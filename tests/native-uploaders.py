"""Run the downloaded native launcher on its OS against an isolated HTTP fixture.

The fixture tests client behavior. tests/uploader.py separately tests the real
Linux production server. No Python installation is needed by native clients.
"""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import platform
import secrets
import subprocess
import tempfile
import threading
import time
import unittest
import uuid

spec = importlib.util.spec_from_file_location("uploader", "scripts/upload/uploader.py")
uploader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uploader)


class Fixture:
    def __init__(self):
        self.key = "pd_" + secrets.token_hex(32)
        self.uploads = {}
        self.folders = []
        self.completed = 0
        self.active = 0
        self.peak = 0
        self.lose_complete = False
        self.lock = threading.RLock()
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send_json(self, code, data):
                body = json.dumps(data).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def dispatch(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.headers.get("Authorization") != "Bearer " + fixture.key:
                    return self.send_json(401, {"error": "Invalid API key"})
                is_chunk = self.command == "PATCH"
                if is_chunk:
                    with fixture.lock:
                        fixture.active += 1
                        fixture.peak = max(fixture.peak, fixture.active)
                    time.sleep(.12)  # Observe parallel files, not overlapping chunks of one file.
                try:
                    with fixture.lock:
                        code, data = self.route(body)
                    if is_chunk:
                        with fixture.lock:
                            fixture.active -= 1
                        is_chunk = False
                    self.send_json(code, data)
                finally:
                    if is_chunk:
                        with fixture.lock:
                            fixture.active -= 1

            def route(self, body):
                if self.path == "/api/folders/tree":
                    return 200, {"folders": fixture.folders}
                if self.path == "/api/folders":
                    value = json.loads(body)
                    parent = None if value["parent_id"] == "root" else value["parent_id"]
                    for folder in fixture.folders:
                        if folder["name"].lower() == value["name"].lower() and folder["parent_id"] == parent:
                            return 409, {"error": "Folder exists"}
                    folder = {"id": str(uuid.uuid4()), "name": value["name"], "parent_id": parent}
                    fixture.folders.append(folder)
                    return 201, folder
                if self.path == "/api/uploads":
                    value = json.loads(body)
                    if value["id"] not in fixture.uploads:
                        fixture.uploads[value["id"]] = dict(value, data=bytearray(), status="pending")
                    return 201, self.status(fixture.uploads[value["id"]])
                parts = self.path.split("/")
                if len(parts) >= 4 and parts[2] == "uploads":
                    record = fixture.uploads.get(parts[3])
                    if record is None:
                        return 404, {"error": "Upload not found"}
                    if self.command == "GET":
                        return 200, self.status(record)
                    if self.command == "PATCH":
                        if int(self.headers["Upload-Offset"]) != len(record["data"]):
                            return 409, {"error": "Wrong offset"}
                        if len(body) > 4 * 1024 * 1024:
                            return 413, {"error": "Chunk too large"}
                        record["data"].extend(body)
                        return 200, self.status(record)
                    if self.command == "POST" and parts[-1] == "complete":
                        if len(record["data"]) != record["size"]:
                            return 409, {"error": "Incomplete upload"}
                        if record["status"] != "complete":
                            record["status"] = "complete"
                            fixture.completed += 1
                        if fixture.lose_complete:
                            fixture.lose_complete = False
                            return 502, {"error": "Lost completion response"}
                        return 200, self.status(record)
                return 404, {"error": "Not found"}

            def status(self, record):
                result = {"id": record["id"], "status": record["status"], "offset": len(record["data"]), "chunk_size": 4 * 1024 * 1024, "busy": False}
                if record["status"] == "complete":
                    result["file"] = {"id": record["id"], "checksum": hashlib.sha256(record["data"]).hexdigest()}
                return result

            do_GET = dispatch
            do_POST = dispatch
            do_PATCH = dispatch

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = "http://127.0.0.1:" + str(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


@unittest.skipUnless(platform.system() in ("Darwin", "Windows"), "Native runtime needs macOS or Windows")
class NativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pocket native café ")
        self.root = Path(self.temp.name)
        self.fixture = Fixture()
        self.downloads = self.root / "Downloads space"
        subprocess.run(["node", "scripts/render-uploaders.ts", str(self.downloads), self.fixture.origin], check=True)

    def tearDown(self):
        self.fixture.close()
        self.temp.cleanup()

    def run_native(self, entries, concurrency=3, key=None, source=None):
        report = self.root / (uuid.uuid4().hex + ".json")
        report.write_text(json.dumps({"format": "pocket-drive-upload", "version": 1, "server": self.fixture.origin, "entries": entries, "skipped": []}), encoding="utf-8")
        env = dict(os.environ, POCKET_DRIVE_UPLOAD_REPORT=str(report), POCKET_DRIVE_UPLOAD_CONCURRENCY=str(concurrency))
        if source:
            env.pop("POCKET_DRIVE_UPLOAD_REPORT")
            env["POCKET_DRIVE_UPLOAD_SOURCE"] = str(source)
        if platform.system() == "Windows":
            command = ["cmd", "/d", "/c", str(self.downloads / "pocket-drive-upload-native.cmd")]
        else:
            command = ["bash", str(self.downloads / "pocket-drive-upload-native.sh")]
        result = subprocess.run(command, input=(key or self.fixture.key) + "\n", text=True, encoding="utf-8", errors="replace", capture_output=True, env=env, timeout=150)
        self.assertNotIn(key or self.fixture.key, result.stdout + result.stderr)
        checkpoints = list(self.downloads.glob("*progress*.json"))
        self.assertTrue(checkpoints, result.stdout + result.stderr)
        checkpoint = max(checkpoints, key=lambda path: path.stat().st_mtime_ns)
        text = checkpoint.read_text(encoding="utf-8-sig")
        self.assertNotIn(key or self.fixture.key, text)
        return result, json.loads(text)["entries"]

    def test_parallel_nested_empty_hidden_and_multichunk(self):
        for concurrency in (1, 3, 8):
            with self.subTest(concurrency=concurrency):
                source = self.root / ("Reports café " + str(concurrency))
                (source / "nested").mkdir(parents=True)
                (source / "empty folder").mkdir()
                (source / ".hidden").write_bytes(b"hidden")
                (source / "zero.sql").write_bytes(b"")
                for index in range(10):
                    (source / "nested" / ("file " + str(index) + ".txt")).write_bytes(bytes([index]) * 4000)
                (source / "large.bin").write_bytes(b"z" * (5 * 1024 * 1024 + 11))
                entries, _ = uploader.scan(source, self.downloads)
                self.fixture.peak = 0
                result, final = self.run_native(entries, concurrency)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertTrue(all(entry["status"] == "complete" for entry in final), final)
                self.assertTrue(any(folder["name"] == "empty folder" for folder in self.fixture.folders))
                for entry in final:
                    if entry["kind"] == "file":
                        stored = self.fixture.uploads[entry["upload_id"]]
                        self.assertEqual(bytes(stored["data"]), Path(entry["source"]).read_bytes())
                        self.assertEqual(stored["relative_path"], entry["relative_path"])
                self.assertLessEqual(self.fixture.peak, concurrency)
                self.assertGreater(self.fixture.peak, 1 if concurrency > 1 else 0)

    def test_fresh_source_scan_and_single_file(self):
        source = self.root / "Fresh café folder"
        (source / "empty").mkdir(parents=True)
        (source / ".hidden").write_bytes(b"hidden")
        (source / "trial.sql").write_bytes(b"select 2;")
        try:
            (source / "link").symlink_to(source / "trial.sql")
        except OSError:
            pass  # Windows developer mode may not allow symlink creation.
        result, final = self.run_native([], source=source)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(all(entry["status"] == "complete" for entry in final), final)
        self.assertEqual(sum(entry["kind"] == "file" for entry in final), 2)
        self.assertEqual(sum(entry["kind"] == "folder" for entry in final), 2)
        result, final = self.run_native([], source=source / "trial.sql")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(final), 1)
        self.assertEqual(final[0]["relative_path"], "")

    def test_failure_retry_lost_completion_and_shared_reports(self):
        source = self.root / "trial café.sql"
        source.write_bytes(b"select 1;")
        entry = uploader.source_record(source, "")
        result, failed = self.run_native([entry], key="pd_" + "0" * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(failed[0]["status"], "failed")
        failure = next(self.downloads.glob("*failures*.json"))
        entries, _ = uploader.load_report(failure, self.fixture.origin)
        self.fixture.lose_complete = True
        result, final = self.run_native(entries)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.fixture.completed, 1)
        self.assertEqual(final[0]["upload_id"], entry["upload_id"])
        result, _ = self.run_native(final)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.fixture.completed, 1)
        # Native reports can be resumed with Python without comparing unavailable nanosecond mtimes.
        final[0]["fingerprint"]["modified_ns"] = None
        final[0]["status"] = "failed"
        job = uploader.Uploader(self.fixture.origin, self.fixture.key, final, self.downloads)
        self.assertEqual(job.run(1), 0)
        self.assertEqual(self.fixture.completed, 1)

    def test_resume_partial_and_reject_changed_source(self):
        source = self.root / "resume.txt"
        source.write_bytes(b"1234567890")
        entry = uploader.source_record(source, "")
        self.fixture.uploads[entry["upload_id"]] = {"id": entry["upload_id"], "size": 10, "data": bytearray(b"1234"), "status": "pending"}
        result, final = self.run_native([entry], 1)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(bytes(self.fixture.uploads[entry["upload_id"]]["data"]), b"1234567890")
        changed = uploader.source_record(source, "")
        source.write_bytes(b"changed!!!")
        result, failed = self.run_native([changed], 1)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(failed[0]["status"], "failed")
        self.assertIn("Source changed", failed[0]["error"])
        self.assertNotIn(changed["upload_id"], self.fixture.uploads)


if __name__ == "__main__":
    unittest.main()
