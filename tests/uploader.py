"""Exercise the actual uploader against a built drive with isolated storage."""
import hashlib
import importlib.util
import json
import os
import select
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request
import uuid

spec = importlib.util.spec_from_file_location("uploader", "scripts/upload/uploader.py")
uploader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uploader)


class UploadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="pocket-uploader-test-")
        cls.root = Path(cls.temp.name)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        cls.server = f"http://127.0.0.1:{port}"
        salt = secrets.token_hex(16)
        cls.password = secrets.token_hex(20)
        digest = hashlib.scrypt(cls.password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64).hex()
        env = dict(os.environ, NODE_ENV="production", APP_ORIGIN=cls.server, ADMIN_USERNAME="admin",
                   ADMIN_PASSWORD_HASH=f"scrypt:{salt}:{digest}", SESSION_SECRET=secrets.token_hex(32),
                   STORAGE_PATH=str(cls.root / "storage"), STORAGE_QUOTA_BYTES="100000000",
                   MIN_FREE_DISK_BYTES="0", MAX_FILE_BYTES="10000000", PORT=str(port), HOSTNAME="127.0.0.1")
        cls.log = (cls.root / "server.log").open("w")
        cls.process = subprocess.Popen([shutil.which("node"), ".next/standalone/server.js"], env=env, stdout=cls.log, stderr=cls.log)
        for _ in range(100):
            try:
                urllib.request.urlopen(cls.server + "/api/health", timeout=1).close()
                break
            except Exception:
                time.sleep(.1)
        else:
            raise RuntimeError("Test server failed to start")
        req = urllib.request.Request(cls.server + "/api/auth/login", data=json.dumps({"username": "admin", "password": cls.password}).encode(), headers={"Content-Type": "application/json", "Origin": cls.server})
        with urllib.request.urlopen(req) as response:
            cls.cookie = response.headers["Set-Cookie"].split(";")[0]
        cls.key = cls.session("/api/keys", {"name": "uploader tests", "scopes": ["read", "upload", "delete"]})["token"]

    @classmethod
    def session(cls, route, data=None):
        req = urllib.request.Request(cls.server + route, data=json.dumps(data).encode() if data is not None else None,
                                     headers={"Cookie": cls.cookie, "Origin": cls.server, "Content-Type": "application/json"})
        with urllib.request.urlopen(req) as response:
            return json.load(response)

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=15)
        cls.log.close()
        cls.temp.cleanup()

    def make_job(self, records, key=None):
        directory = self.root / uuid.uuid4().hex
        directory.mkdir()
        return uploader.Uploader(self.server, key or self.key, records, directory)

    def test_parallel_uploads_and_content_at_1_3_8_workers(self):
        for concurrency in (1, 3, 8):
            with self.subTest(concurrency=concurrency):
                directory = self.root / ("Reports space café " + uuid.uuid4().hex)
                directory.mkdir()
                (directory / "nested").mkdir()
                (directory / "empty folder").mkdir()
                (directory / ".hidden").write_bytes(b"hidden")
                for index in range(10):
                    (directory / "nested" / f"file {index}.txt").write_bytes(bytes([index]) * (80 + index))
                (directory / "nested" / "zero.sql").write_bytes(b"")
                records, skipped = uploader.scan(directory, self.root)
                job = self.make_job(records)
                self.assertEqual(job.run(concurrency), 0)
                self.assertTrue(all(e["status"] == "complete" for e in records))
                folders = job.request("GET", "/api/folders/tree")["folders"]
                self.assertTrue(any(f["name"] == "empty folder" for f in folders))
                for entry in records:
                    if entry["kind"] == "file":
                        req = urllib.request.Request(self.server + "/api/files/" + entry["file_id"] + "/download", headers={"Authorization": "Bearer " + self.key})
                        with urllib.request.urlopen(req) as response:
                            self.assertEqual(response.read(), Path(entry["source"]).read_bytes())
                self.assertEqual(skipped, [])

    def test_failure_report_retry_and_lost_completion(self):
        file = self.root / "retry.sql"
        file.write_bytes(b"select 1;")
        job = self.make_job([uploader.source_record(file, "")], "pd_" + "0" * 64)
        self.assertEqual(job.run(3), 1)
        report = next(job.report_dir.glob("*failures*.json"))
        self.assertNotIn(job.key, report.read_text())
        entries, skipped = uploader.load_report(report, self.server)
        retry = self.make_job(entries)
        real_request = retry.request
        lost = [False]
        def request(method, route, *args):
            response = real_request(method, route, *args)
            if route.endswith("/complete") and not lost[0]:
                lost[0] = True
                raise uploader.UploadError(0, "lost acknowledgement")
            return response
        retry.request = request
        self.assertEqual(retry.run(3), 0)
        file_id = entries[0]["file_id"]
        self.assertEqual(file_id, job.records[0]["upload_id"])
        self.assertEqual(retry.run(3), 0)
        self.assertEqual(entries[0]["file_id"], file_id)
        with self.assertRaises(ValueError):
            uploader.load_report(report, "https://another.example")

    def test_changed_source_and_resume_offset(self):
        file = self.root / "resume.txt"
        file.write_bytes(b"1234567890")
        entry = uploader.source_record(file, "")
        job = self.make_job([entry])
        job.request("POST", "/api/uploads", {"id": entry["upload_id"], "name": file.name, "size": 10})
        job.request("PATCH", "/api/uploads/" + entry["upload_id"], b"1234", 0)
        self.assertEqual(job.run(1), 0)
        large = self.root / "multiple chunks.bin"
        large.write_bytes(b"x" * (5 * 1024 * 1024))
        self.assertEqual(self.make_job([uploader.source_record(large, "")]).run(1), 0)
        old = uploader.source_record(file, "")
        file.write_bytes(b"changed")
        changed = self.make_job([old])
        self.assertEqual(changed.run(1), 1)
        self.assertIn("Source changed", old["error"])

    @unittest.skipUnless(os.name != "nt" and shutil.which("bash"), "Bash PTY requires a Unix host")
    def test_downloaded_bash_script_interactive_prompts(self):
        import pty
        file = self.root / "terminal file.sql"
        file.write_text("select 42;")
        req = urllib.request.Request(self.server + "/api/keys/uploader?platform=macos", headers={"Cookie": self.cookie})
        with urllib.request.urlopen(req) as response:
            launcher = self.root / "launcher space.sh"
            launcher.write_bytes(response.read())
        pid, terminal = pty.fork()
        if pid == 0:
            os.execvp("bash", ["bash", str(launcher)])
        transcript = b""
        prompts = [(b"Choose 1 or 2 [1]:", "1"), (b"File or folder path:", '"' + str(file) + '"'),
                   (b"Parallel file uploads, 1", "3"), (b"API key (hidden):", self.key),
                   (b"Start uploading? [Y/n]:", "y")]
        try:
            for prompt, answer in prompts:
                deadline = time.monotonic() + 15
                while prompt not in transcript:
                    if time.monotonic() > deadline:
                        self.fail("Prompt not received: " + repr(prompt) + " " + transcript.decode(errors="replace"))
                    if select.select([terminal], [], [], .2)[0]:
                        transcript += os.read(terminal, 65536)
                os.write(terminal, (answer + "\n").encode())
            deadline = time.monotonic() + 15
            while b"Finished:" not in transcript and time.monotonic() < deadline:
                if select.select([terminal], [], [], .2)[0]:
                    try:
                        transcript += os.read(terminal, 65536)
                    except OSError:
                        break
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0, transcript.decode(errors="replace"))
            self.assertNotIn(self.key.encode(), transcript)
            self.assertIn(b"1 files uploaded; 0 failed", transcript)
            self.assertTrue(list(self.root.glob("pocket-drive-upload-progress-*.json")))
        finally:
            os.close(terminal)
            try:
                os.kill(pid, 15)
            except ProcessLookupError:
                pass

    def test_server_quota_under_parallel_requests(self):
        job = self.make_job([])
        # Reserve almost all remaining space in one session; other sessions must fail atomically.
        ids = [str(uuid.uuid4()) for _ in range(16)]
        def reserve(id):
            try:
                job.request("POST", "/api/uploads", {"id": id, "name": "quota.bin", "size": 10000000})
                return True
            except uploader.UploadError as error:
                self.assertEqual(error.status, 507)
                return False
        with uploader.concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(reserve, ids))
        storage = job.request("GET", "/api/storage")
        self.assertLessEqual(storage["used_bytes"] + storage["reserved_bytes"], storage["quota_bytes"])
        self.assertGreater(sum(results), 0)
        self.assertLess(sum(results), len(ids))
        for id, created in zip(ids, results):
            if created:
                job.request("DELETE", "/api/uploads/" + id)
        self.assertEqual(job.request("GET", "/api/storage")["reserved_bytes"], 0)

    def test_page_and_downloads(self):
        for platform in ("macos", "windows"):
            route = "/api/keys/uploader?platform=" + platform
            with self.assertRaises(urllib.error.HTTPError) as unauth:
                urllib.request.urlopen(self.server + route)
            self.assertEqual(unauth.exception.code, 401)
            req = urllib.request.Request(self.server + route, headers={"Cookie": self.cookie})
            with urllib.request.urlopen(req) as response:
                text = response.read().decode("utf-8-sig")
                self.assertIn("attachment", response.headers["Content-Disposition"])
                self.assertIn("no-store", response.headers["Cache-Control"])
                self.assertIn(self.server, text)
                self.assertNotIn(self.key, text)
            if platform == "macos":
                source = text.split("<<'POCKET_DRIVE_PYTHON'\n", 1)[1].rsplit("\nPOCKET_DRIVE_PYTHON", 1)[0]
                subprocess.run(["bash", "-n"], input=text.encode(), check=True)
            else:
                source = text.split("$source = @'\n", 1)[1].split("\n'@", 1)[0]
                if shutil.which("pwsh"):
                    # Exercise PowerShell argument passing without an interactive terminal.
                    launcher = self.root / "launcher space.ps1"
                    launcher.write_text(text.replace("sys.exit(main())", 'print("Launcher works"); sys.exit(0)'), encoding="utf-8-sig")
                    result = subprocess.run(["pwsh", "-NoProfile", "-File", str(launcher)], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("Launcher works", result.stdout)
            compile(source, "downloaded uploader", "exec")
        req = urllib.request.Request(self.server + "/keys", headers={"Cookie": self.cookie})
        with urllib.request.urlopen(req) as response:
            text = response.read().decode()
            self.assertIn("uploader tests", text)
            self.assertIn("Download script", text)
            self.assertNotIn(self.key, text)

    def test_paths_symlinks_and_report_integrity(self):
        self.assertEqual(uploader.clean_path('"/tmp/path with spaces/"'), Path("/tmp/path with spaces"))
        directory = self.root / uuid.uuid4().hex
        directory.mkdir()
        (directory / "target").write_text("target")
        (directory / "link").symlink_to(directory / "target")
        records, skipped = uploader.scan(directory, self.root)
        self.assertEqual(len(skipped), 1)
        self.assertEqual(len(records), 2)


if __name__ == "__main__":
    unittest.main()
