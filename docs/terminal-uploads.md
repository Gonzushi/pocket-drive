# Upload from macOS or Windows

Open **API keys** in Pocket Drive. Create a key with **Read & download** and **Upload & organize**, then download the script for your computer. Read access is used to preserve empty folders and reuse existing folders; uploading a single file needs only upload access. Delete permission is not required.

Choose either **No Python** or **Python**. All four downloads are self-contained; no repository checkout, pip packages, Node or jq is needed on your computer.

| Computer | Version   | Download                         | Requirements                                                                     |
| -------- | --------- | -------------------------------- | -------------------------------------------------------------------------------- |
| macOS    | No Python | `pocket-drive-upload-native.sh`  | Built-in Bash, curl, shasum and JavaScript for Automation (osascript)            |
| Windows  | No Python | `pocket-drive-upload-native.cmd` | Command Prompt and built-in Windows PowerShell 5.1; PowerShell 7 is not required |
| macOS    | Python    | `pocket-drive-upload.sh`         | Python 3.9 or newer                                                              |
| Windows  | Python    | `pocket-drive-upload.ps1`        | Python 3.9 or newer and Windows PowerShell                                       |

## Run

Native macOS, in Terminal:

```bash
bash ~/Downloads/pocket-drive-upload-native.sh
```

Native Windows, in Command Prompt:

```cmd
"%USERPROFILE%\Downloads\pocket-drive-upload-native.cmd"
```

Python macOS, in Terminal:

```bash
bash ~/Downloads/pocket-drive-upload.sh
```

Python Windows, in PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\pocket-drive-upload.ps1"
```

For the Python versions, install Python 3.9 or newer from https://www.python.org/downloads/ if needed. The Windows launchers permit execution only in their current PowerShell process; they do not change your permanent execution policy. Change the command path if you saved the download elsewhere.

## Prompts

1. Choose **Upload a file or folder**, or **Retry or resume from JSON report**.
2. Enter your file/folder path or report path. The prompt shows examples for both operating systems. Spaces, optional surrounding quotes and trailing directory separators work. macOS `~` paths are supported. Bash-escaped drag-and-drop paths such as `My\ Folder` should be entered instead as `"My Folder"`.
3. Choose **1–8 parallel files**, default **3**. Each file sends its 4 MiB chunks sequentially; different files upload in parallel. More workers do not guarantee faster uploads.
4. Paste your API key at the hidden prompt. It remains in memory; it is not embedded in downloads, written to reports, or passed on a process command line.
5. Review the server, destination and pending file count, then confirm.

A file uploads into **My files**. A selected folder uploads as a folder with the same name, preserving nested and empty folders. Hidden files are included. Symbolic links are skipped and listed in the report. Existing same-name folders are reused. A fresh job creates new file copies; it does not overwrite or synchronize existing files. A job supports at most 15,000 total file/folder entries.

Source files are fingerprinted before uploading. Files whose contents change while uploading or between retries fail explicitly. Timestamps are checked during a transfer; stored size and SHA-256 verify content across script versions. Initial discovery hashes file contents, which can take time for large folders. The script directory must be writable. Keep the script outside your source folder when convenient; generated reports beside it are excluded from a folder scan.

## Resume and retry

The script writes a `pocket-drive-upload-progress-DATE-ID.json` checkpoint beside itself before network uploads. If failures remain, it also writes `pocket-drive-upload-failures-DATE-ID.json` in the same directory. Reports record source paths, source checksums, destination paths, upload IDs, errors and completion state, but never the API key. They contain personal paths, so treat them as private.

Run the script again, choose option **2**, and enter either report path. Enter your key and preferred concurrency again. Completed file entries are skipped. Unfinished files resume from the server's confirmed offset; a completed server session recovers a lost completion acknowledgement without duplicating the file. Each retry creates a new report and leaves the original untouched. Native and Python versions share the version 1 report format: either can resume the other’s report on the same computer and server. If you move the job to another computer, its absolute source paths must still exist. Folder paths are checked/recreated in dependency order, including failed empty-folder entries.

Temporary failures receive up to four attempts with bounded backoff. Authentication, size-limit, source-change and storage errors are reported for your intervention. Repair permissions or free storage before retrying. If a source changed, start a fresh job for that file. Unfinished sessions reserve space and expire after 24 hours without activity; completed uploads do not expire. Expired unfinished uploads restart from zero using the same job ID where possible. Cancelling an upload fences that ID and requires a fresh job.

After interruption, use the progress report to resume. Network requests have bounded timeouts. Uploaded copies remain on the server; the next run obtains the actual offset from the server, even if the local checkpoint missed a response.

## Developer verification

Build the drive first, then run:

```bash
python3 tests/uploader.py
```

Tests use isolated storage and the actual built server. They cover 1/3/8 parallel uploads, directory structure, byte-for-byte downloads, interrupted transfer recovery, lost completion responses, invalid keys, changed sources, quota reservations, and download authentication. Bash launchers and embedded Python are checked. The Python PowerShell launcher is exercised when `pwsh` is installed.

Run native client tests on macOS or Windows:

```bash
python tests/native-uploaders.py
```

Python is used only as the test fixture runner, not by the native scripts. CI runs these tests on both actual operating systems. Tests render the same launcher templates as the download endpoint and cover fresh file/folder discovery, hidden/empty folders, Unicode and spaced paths, 1/3/8 workers, multiple chunks, byte equality, invalid keys, failures and cross-version reports, source changes, partial offsets and lost completion responses. They use an isolated HTTP fixture; actual production-server checks run separately on Linux. A Linux run skips the native runtime tests and cannot prove native compatibility.

The native launchers also support an unattended job with `POCKET_DRIVE_UPLOAD_SOURCE` (fresh file/folder) or `POCKET_DRIVE_UPLOAD_REPORT` (resume), plus optional `POCKET_DRIVE_UPLOAD_CONCURRENCY` (default 3). In this mode they read the API key as one line from standard input. Source/report paths are environment settings, never the credential. Interactive use needs none of these settings. Supply only one source/report setting; a report takes precedence.

The API Keys page server-loads only key metadata after authentication. Client refresh/create/revoke requests still use the authenticated API. The route loading UI and explicit prefetch provide navigation feedback; private key responses are not publicly cached. No full tokens or hashes are included in server-rendered key lists.
