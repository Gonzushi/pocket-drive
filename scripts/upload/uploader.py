"""Shared, standard-library uploader embedded in both downloadable launchers."""
import concurrent.futures
import datetime
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

SERVER = "__POCKET_DRIVE_SERVER__"
PREFIX = "pocket-drive-upload-"
TRANSIENT = {408, 409, 429, 500, 502, 503, 504}


class UploadError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward an API key to a redirected destination.


def clean_path(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return Path(os.path.expandvars(value)).expanduser().absolute()


def fingerprint(path):
    info = path.stat()
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(chunk)
    after = path.stat()
    if (info.st_size, info.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("Source changed while reading. Run a new upload for this file.")
    return {"size": info.st_size, "modified_ns": info.st_mtime_ns, "sha256": checksum.hexdigest()}


def source_record(path, relative, kind="file"):
    entry = {"source": str(path), "relative_path": relative, "kind": kind,
             "upload_id": str(uuid.uuid4()), "status": "pending", "attempts": 0, "error": ""}
    if kind == "file":
        try:
            entry["fingerprint"] = fingerprint(path)
        except (OSError, ValueError) as error:
            entry["status"] = "failed"
            entry["error"] = str(error)
            entry["fingerprint"] = None
    return entry


def scan(path, report_dir):
    if path.is_symlink():
        raise ValueError("Symbolic links are skipped. Choose the original file or folder.")
    if path.is_file():
        return [source_record(path, "")], []
    if not path.is_dir():
        raise ValueError("That file or folder does not exist.")
    records, skipped = [], []
    for root, directories, files in os.walk(path, followlinks=False, onerror=lambda err: (_ for _ in ()).throw(err)):
        current = Path(root)
        for name in list(directories):
            child = current / name
            if child.is_symlink():
                skipped.append(str(child))
                directories.remove(name)
        relative = Path(path.name) / current.relative_to(path)
        records.append(source_record(current, relative.as_posix(), "folder"))
        if len(records) > 15000:
            raise ValueError("Choose a smaller folder: at most 15,000 files/folders per job.")
        for name in sorted(files):
            child = current / name
            if child.is_symlink() or (child.parent == report_dir and name.startswith(PREFIX) and name.endswith(".json")):
                skipped.append(str(child))
                continue
            records.append(source_record(child, (relative / name).as_posix()))
            if len(records) > 15000:
                raise ValueError("Choose a smaller folder: at most 15,000 files/folders per job.")
    return records, skipped


class Uploader:
    def __init__(self, server, key, records, report_dir, skipped=None):
        self.server = server.rstrip("/")
        self.key = key
        self.records = records
        self.skipped = skipped or []
        self.lock = threading.RLock()
        self.stopped = threading.Event()
        self.opener = urllib.request.build_opener(NoRedirect())
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        self.job = f"{stamp}-{uuid.uuid4().hex[:6]}"
        self.report_dir = report_dir
        self.checkpoint = report_dir / f"{PREFIX}progress-{self.job}.json"

    def request(self, method, route, data=None, offset=None):
        headers = {"Authorization": f"Bearer {self.key}"}
        if isinstance(data, dict):
            data = json.dumps(data).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif isinstance(data, bytes):
            headers["Content-Type"] = "application/octet-stream"
        if offset is not None:
            headers["Upload-Offset"] = str(offset)
        request = urllib.request.Request(self.server + route, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=135) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            try:
                message = json.loads(error.read(65536)).get("error", "Request failed.")
            except (ValueError, AttributeError):
                message = f"HTTP {error.code}: request failed."
            raise UploadError(error.code, str(message)) from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            raise UploadError(0, "Connection or response interrupted; resume from confirmed status.") from error

    def save(self, target=None):
        with self.lock:
            payload = {"format": "pocket-drive-upload", "version": 1, "server": self.server,
                       "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                       "entries": self.records, "skipped": self.skipped}
            destination = target or self.checkpoint
            handle, temporary = tempfile.mkstemp(prefix=".pocket-upload-", dir=self.report_dir)
            try:
                with os.fdopen(handle, "w", encoding="utf-8") as report:
                    json.dump(payload, report, ensure_ascii=False, indent=2)
                    report.flush()
                    os.fsync(report.fileno())
                os.replace(temporary, destination)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)

    def update(self, entry, **values):
        with self.lock:
            entry.update(values)
            self.save()

    def completed(self, entry, response):
        file = response.get("file", {})
        if file.get("checksum") != entry["fingerprint"]["sha256"]:
            raise ValueError("Server checksum differs from the source; inspect this upload before retrying.")
        self.update(entry, status="complete", file_id=file.get("id"), error="")

    def transfer(self, entry):
        path = Path(entry["source"])
        if path.is_symlink() or not path.is_file():
            raise ValueError("Source is missing or is a symbolic link.")
        if entry["fingerprint"] is None:
            self.update(entry, fingerprint=fingerprint(path))
        if fingerprint(path) != entry["fingerprint"]:
            raise ValueError("Source changed since this job. Start a new upload for this file.")
        route = "/api/uploads/" + entry["upload_id"]
        try:
            status = self.request("GET", route)
        except UploadError as error:
            if error.status != 404:
                raise
            status = self.request("POST", "/api/uploads", {
                "id": entry["upload_id"], "name": path.name,
                "size": entry["fingerprint"]["size"], "mime_type": "application/octet-stream",
                "folder_id": "root", "relative_path": entry["relative_path"]})
        if status["status"] == "complete":
            self.completed(entry, status)
            return
        if status.get("busy"):
            raise UploadError(409, "Another request is working on this file. Retry shortly.")
        offset = status["offset"]
        with path.open("rb") as source:
            source.seek(offset)
            while offset < entry["fingerprint"]["size"]:
                if self.stopped.is_set():
                    raise InterruptedError("Upload stopped; use this report to resume.")
                info = path.stat()
                if (info.st_size, info.st_mtime_ns) != (entry["fingerprint"]["size"], entry["fingerprint"]["modified_ns"]):
                    raise ValueError("Source changed during upload. Start a new upload for this file.")
                data = source.read(min(status["chunk_size"], entry["fingerprint"]["size"] - offset))
                if not data:
                    raise ValueError("Source ended before its expected size.")
                status = self.request("PATCH", route, data, offset)
                offset = status["offset"]
                with self.lock:
                    entry["offset"] = offset  # The server is authoritative after an interruption.
                    print(f"Uploading {path.name}: {offset}/{entry['fingerprint']['size']} bytes", flush=True)
        if fingerprint(path) != entry["fingerprint"]:
            raise ValueError("Source changed during upload. Start a new upload for this file.")
        self.completed(entry, self.request("POST", route + "/complete", {}))

    def file_worker(self, entry):
        for attempt in range(4):
            if self.stopped.is_set():
                return
            self.update(entry, status="uploading", attempts=entry.get("attempts", 0) + 1)
            try:
                self.transfer(entry)
                with self.lock:
                    count = sum(e["status"] == "complete" and e["kind"] == "file" for e in self.records)
                    total = sum(e["kind"] == "file" for e in self.records)
                    print(f"[{count}/{total}] Uploaded: {entry['relative_path'] or Path(entry['source']).name}", flush=True)
                return
            except Exception as error:
                retryable = isinstance(error, UploadError) and (error.status == 0 or error.status in TRANSIENT)
                message = re.sub(r"pd_[a-f0-9]{64}", "[redacted]", str(error)).replace(self.key, "[redacted]")
                self.update(entry, status="failed", error=message,
                            http_status=getattr(error, "status", None))
                if not retryable or attempt == 3:
                    with self.lock:
                        print(f"Failed: {entry['source']} — {message}", flush=True)
                    return
                time.sleep(min(2 ** attempt, 8))

    def folders(self):
        entries = [e for e in self.records if e["kind"] == "folder"]
        if not entries:
            return
        # A single tree snapshot plus sequential creation avoids duplicate-folder races.
        tree = self.request("GET", "/api/folders/tree")["folders"]
        mapping = {(e.get("parent_id"), e["name"].translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))): e["id"] for e in tree}
        for entry in sorted(entries, key=lambda e: e["relative_path"].count("/")):
            try:
                parent = None
                for name in entry["relative_path"].split("/"):
                    lookup = (parent, name.translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")))
                    if lookup not in mapping:
                        try:
                            result = self.request("POST", "/api/folders", {"name": name, "parent_id": parent or "root"})
                            mapping[lookup] = result["id"]
                        except UploadError as error:
                            if error.status != 409:
                                raise
                            fresh = self.request("GET", "/api/folders/tree")["folders"]
                            for folder in fresh:
                                key = (folder.get("parent_id"), folder["name"].translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")))
                                mapping[key] = folder["id"]
                            if lookup not in mapping:
                                raise
                    parent = mapping[lookup]
                self.update(entry, status="complete", folder_id=parent, error="")
            except Exception as error:
                self.update(entry, status="failed", error=str(error).replace(self.key, "[redacted]"))

    def run(self, concurrency):
        self.save()
        print(f"Recovery report: {self.checkpoint}", flush=True)
        try:
            self.folders()
        except Exception as error:
            for entry in self.records:
                if entry["kind"] == "folder" and entry["status"] != "complete":
                    self.update(entry, status="failed", error=str(error).replace(self.key, "[redacted]"))
        pending = [entry for entry in self.records if entry["kind"] == "file" and entry["status"] != "complete"]
        # Only running workers create sessions, not every file in the selected folder.
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
            try:
                for _ in pool.map(self.file_worker, pending):
                    pass
            except KeyboardInterrupt:
                self.stopped.set()
                print("\nStopping after active requests return; pending files remain in the recovery report.", flush=True)
                raise
        failed = [entry for entry in self.records if entry["status"] != "complete"]
        success = sum(entry["kind"] == "file" and entry["status"] == "complete" for entry in self.records)
        print(f"Finished: {success} files uploaded; {len(failed)} failed entries; {len(self.skipped)} skipped links/reports.")
        if failed:
            report = self.report_dir / f"{PREFIX}failures-{self.job}.json"
            self.save(report)
            print(f"Failure report: {report}\nRun again and choose option 2 to retry this report.")
        return 1 if failed else 0


def load_report(path, server):
    with path.open(encoding="utf-8") as source:
        report = json.load(source)
    if report.get("format") != "pocket-drive-upload" or report.get("version") != 1:
        raise ValueError("This is not a supported Pocket Drive upload report.")
    if report.get("server", "").rstrip("/") != server.rstrip("/"):
        raise ValueError("Report belongs to another server. Download its script instead.")
    entries = report.get("entries")
    if not isinstance(entries, list) or len(entries) > 15000:
        raise ValueError("Report entries are invalid.")
    for entry in entries:
        if entry.get("kind") not in ("file", "folder") or not isinstance(entry.get("source"), str):
            raise ValueError("Report contains an invalid source entry.")
        if not isinstance(entry.get("relative_path"), str):
            raise ValueError("Report contains an invalid destination.")
        if entry["kind"] == "file":
            parsed = uuid.UUID(entry["upload_id"])
            if parsed.version != 4 or str(parsed) != entry["upload_id"]:
                raise ValueError("Report contains an invalid upload ID.")
            if entry.get("fingerprint") is not None and not isinstance(entry.get("fingerprint"), dict):
                raise ValueError("Report is missing source fingerprint information.")
    return entries, report.get("skipped", [])


def main():
    report_dir = Path(sys.argv[1]).resolve()
    # Bash uses stdin for the embedded program; prompts must read the terminal.
    if os.name != "nt":
        sys.stdin = open("/dev/tty", "r")
    print(f"Pocket Drive uploader\nServer: {SERVER}\nReports are stored beside the script: {report_dir}")
    probe, probe_path = tempfile.mkstemp(dir=report_dir)
    os.close(probe)
    os.unlink(probe_path)
    print("1. Upload a file or folder\n2. Retry or resume from JSON report")
    mode = input("Choose 1 or 2 [1]: ").strip() or "1"
    if mode not in ("1", "2"):
        raise ValueError("Choose 1 or 2.")
    if mode == "2":
        print('Report example: /Users/hendry/Downloads/pocket-drive-upload-failures-DATE.json\nWindows: C:\\Users\\Hendry\\Downloads\\pocket-drive-upload-failures-DATE.json')
        records, skipped = load_report(clean_path(input("JSON report path: ")), SERVER)
    else:
        print('File examples: /Users/hendry/Documents/trial.sql or C:\\Users\\Hendry\\Documents\\trial.sql\nFolder examples: /Users/hendry/Documents/Reports or C:\\Users\\Hendry\\Documents\\Reports\nSpaces are allowed; surrounding quotes are optional. macOS ~ is supported. Hidden files are included; links are skipped.')
        path = clean_path(input("File or folder path: "))
        print("Scanning and fingerprinting source files…", flush=True)
        records, skipped = scan(path, report_dir)
    while True:
        value = input("Parallel file uploads, 1–8 [3]: ").strip() or "3"
        if value.isdigit() and 1 <= int(value) <= 8:
            concurrency = int(value)
            break
        print("Enter a whole number from 1 to 8.")
    key = getpass.getpass("API key (hidden): ").strip()
    if not re.fullmatch(r"pd_[a-f0-9]{64}", key):
        raise ValueError("Enter a complete Pocket Drive API key starting with pd_.")
    files = sum(entry["kind"] == "file" and entry["status"] != "complete" for entry in records)
    print(f"Server: {SERVER}\nDestination: My files (folder structure preserved)\nPending: {files} files; concurrency: {concurrency}")
    if input("Start uploading? [Y/n]: ").strip().lower() not in ("", "y", "yes"):
        return 0
    return Uploader(SERVER, key, records, report_dir, skipped).run(concurrency)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nStopped. Use the progress JSON report beside the script to resume.", file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
