# Pocket Drive API

Base URL: your configured website origin. Create API keys from the signed-in **API keys** page.

```http
Authorization: Bearer pd_YOUR_KEY
```

There is no public upload or download endpoint. API keys grant access to this single workspace. Store them in environment variables or a secret manager. Key management is available only from the signed-in website.

## Upload a file

`POST /api/files` — requires **upload** permission.

Send `multipart/form-data` with exactly one field named `file`. Do not set Content-Type manually when using FormData, requests, or curl; let the client include the multipart boundary. Multiple selected files in the website are uploaded as separate requests.

```bash
export POCKET_DRIVE_URL='https://files.example.com'
# Set POCKET_DRIVE_KEY privately in your environment.
curl --fail-with-body "$POCKET_DRIVE_URL/api/files" \
  -H "Authorization: Bearer $POCKET_DRIVE_KEY" \
  -F 'file=@report.pdf'
```

Successful response (`201`):

```json
{
  "id": "81220d63-8861-4fbd-87ed-727d0c7e20af",
  "name": "report.pdf",
  "size": 123456,
  "mime_type": "application/pdf",
  "kind": "document",
  "checksum": "a_sha256_hex_digest",
  "created_at": "2026-10-05T06:00:00.000Z",
  "folder_id": null,
  "download_url": "https://files.example.com/api/files/81220d63-8861-4fbd-87ed-727d0c7e20af/download"
}
```

`download_url` is authenticated, not a public share link. Repeating an upload creates a separate file; this version does not deduplicate or implement idempotency keys.

Python:

```python
import os
import requests

base_url = os.environ["POCKET_DRIVE_URL"].rstrip("/")
headers = {"Authorization": f"Bearer {os.environ['POCKET_DRIVE_KEY']}"}

with open("report.pdf", "rb") as file:
    response = requests.post(
        f"{base_url}/api/files", headers=headers,
        files={"file": file}, timeout=300,
    )
response.raise_for_status()
print(response.json())
```

Install requests with `pip install requests`. For very large files, standard requests may build the multipart body in memory on the client; use curl or a streaming multipart client when needed. The server streams uploads to disk.

## List and search

`GET /api/files` — requires **read** permission.

| Parameter | Meaning |
| --- | --- |
| `q` | Filename substring; at most 200 characters; ASCII case-insensitive SQLite matching |
| `type` | `all`, `document`, `image`, or `other` |
| `offset` | Nonnegative result offset, default 0 |
| `folder_id` | `root` for top-level files, or a folder UUID for its direct files. Omit to list files across the entire drive for compatibility. |

Returns `{ "files": [...], "total": 124, "offset": 0, "limit": 50 }`. Each file has the same metadata fields as the upload response except `download_url`. Results are newest first. Increase offset by 50 to continue. New uploads/deletes may change offsets; this version uses simple offset pagination.

The response also includes `folders` (direct child folders, with item counts) and `breadcrumbs` (ancestors followed by the current folder). A file's `folder_id` is `null` at the drive root. File-type filters hide folders; name search is limited to the selected location when `folder_id` is specified.

```bash
curl --fail-with-body "$POCKET_DRIVE_URL/api/files?type=document&q=report" \
  -H "Authorization: Bearer $POCKET_DRIVE_KEY"
```

## Folder uploads and management

Add optional query parameters to `POST /api/files`:

| Parameter | Meaning |
| --- | --- |
| `folder_id` | Destination folder UUID, or `root` |
| `relative_path` | File path inside the selected folder upload, including the top-level folder and filename, e.g. `Reports/October/report.pdf` |

Example:

```bash
curl --fail-with-body "$POCKET_DRIVE_URL/api/files?folder_id=root&relative_path=Reports%2FOctober%2Freport.pdf" \
  -H "Authorization: Bearer $POCKET_DRIVE_KEY" \
  -F 'file=@report.pdf'
```

The server creates or reuses the folder hierarchy after the upload succeeds. Paths must be relative, contain no `.`/`..` segments or backslashes, and end in the uploaded filename. Folder names are unique within each parent using SQLite's ASCII case-insensitive comparison. Folder metadata is virtual; actual file bytes retain their generated UUID storage paths.

| Endpoint | Permission | Purpose |
| --- | --- | --- |
| `GET /api/folders?parent_id=root` | read | List direct child folders |
| `GET /api/folders/tree` | read | List the complete flat folder tree: `id`, `name`, `parent_id` |
| `POST /api/folders` | upload | Create a folder using JSON `{ "name": "Reports", "parent_id": "root" }` |
| `GET /api/folders/{id}` | read | Get folder details, recursive file/subfolder counts, and total bytes |
| `GET /api/folders/{id}/download` | read | Stream the folder and its full subtree as ZIP |
| `HEAD /api/folders/{id}/download` | read | Validate the export and return download headers |
| `DELETE /api/folders/{id}` | delete | Permanently delete the whole subtree and its files |
| `PATCH /api/folders/{id}` | upload | Rename using JSON `{ "name": "New name" }` |

Folder exports return `application/zip` with an attachment filename. The archive includes the named top-level directory, nested files, and empty folders. ZIP64 supports large archives, with a limit of 100,000 entries per export. Duplicate names get numbered suffixes; filenames unsafe on common operating systems are normalized. Exports stream without temporary archives or additional quota use. They have no `Content-Length` and do not support byte ranges/resume. A missing or changed file detected before streaming returns `409`; a later deletion interrupts the download, which must be retried.

Creating a duplicate sibling folder returns `409`. Maximum folder depth is 32; the drive supports up to 10,000 folders. Folder deletion uses the same delete permission as file deletion.

## Move and rename

`PATCH /api/files/{id}` and `PATCH /api/folders/{id}` require **upload** permission. Send `{ "name": "New name" }`. Names must be between 1 and 255 UTF-8 bytes, with no slashes, backslashes, control characters, `.` or `..`. A file rename updates its extension-based `kind` classification; IDs, checksums, and content remain unchanged.

`POST /api/items/download` requires **read** permission and returns a streamed ZIP attachment named `pocket-drive-selection.zip`. Send `{ "items": [{ "type": "file", "id": "FILE_UUID" }, { "type": "folder", "id": "FOLDER_UUID" }] }`. Select 1–100 unique references. Files appear at the archive root; folders retain their nested structure and empty directories. A selected parent includes its selected descendants once. Same-name roots receive numbered suffixes. The same streaming, filename normalization, entry limit, and retry rules as folder ZIP exports apply. Invalid selections return `400`; missing items return `404` before streaming. Read-only keys can download; upload-only keys cannot.

The browser uses `GET /api/items/download?items=file:FILE_UUID,folder:FOLDER_UUID`; URL-encode the parameter value. `HEAD` on that URL validates access and returns download headers without a body. Both require read access. Session-authenticated POST requests require the normal same-origin protections.

```bash
curl --fail-with-body "$POCKET_DRIVE_URL/api/items/download" \
  -H "Authorization: Bearer $POCKET_DRIVE_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"items":[{"type":"file","id":"FILE_UUID"},{"type":"folder","id":"FOLDER_UUID"}]}' \
  --output selected-items.zip
```

`POST /api/items/move` requires **upload** permission. Select 1–100 unique item references and a destination folder UUID or `root`:

```json
{
  "items": [
    { "type": "file", "id": "FILE_UUID" },
    { "type": "folder", "id": "FOLDER_UUID" }
  ],
  "destination_id": "DESTINATION_FOLDER_UUID"
}
```

```bash
curl --fail-with-body "$POCKET_DRIVE_URL/api/items/move" \
  -H "Authorization: Bearer $POCKET_DRIVE_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"items":[{"type":"file","id":"FILE_UUID"}],"destination_id":"root"}'
```

Returns `{ "success": true, "moved": 1, "destination_id": null }` for a move to the root. Items already at the destination are unchanged and excluded from the `moved` count. Moving a folder carries its full subtree by changing only its parent metadata. File IDs, authenticated download URLs, content, checksums, and quota usage remain unchanged.

The batch is atomic: validation fails before any item moves. A missing source/destination returns `404`; a naming conflict returns `409`; a folder cycle, depth violation, duplicated reference, or selection containing both a folder and its descendant returns `400`. Moves and renames reject same-type name conflicts using ASCII case-insensitive matching. File and folder names can coincide; repeated uploads still create separate files. JSON bodies are limited to 8 KiB.

`POST /api/items/delete` requires **delete** permission and takes `{ "items": [...] }` with the same reference format and 100-item limit. All references are validated before items are marked for deletion; folder contents are included. Returns `{ "success": true, "deleted": 2 }`, counting selected references. Deletion is permanent and releases file quota; overlapping selected folder subtrees are safe. Interrupted physical cleanup is completed by the next storage check.

## Metadata and downloads

`GET /api/files/{id}` — **read** permission; returns file metadata.

`GET /api/files/{id}/download` — **read** permission; streams an attachment. All downloads use `application/octet-stream` with the original filename in Content-Disposition. The stored MIME value is client-supplied metadata, not a trusted type guarantee.

```bash
curl --fail-with-body "$POCKET_DRIVE_URL/api/files/FILE_ID/download" \
  -H "Authorization: Bearer $POCKET_DRIVE_KEY" \
  -o report.pdf
```

`HEAD /api/files/{id}/download` returns download headers without file bytes. Single byte ranges, including suffix ranges, are supported with `206`; invalid ranges return `416`. Downloads are never publicly cached.

## Delete

`DELETE /api/files/{id}` — requires **delete** permission, which is off by default for new keys.

```bash
curl --fail-with-body -X DELETE "$POCKET_DRIVE_URL/api/files/FILE_ID" \
  -H "Authorization: Bearer $POCKET_DRIVE_KEY"
```

Returns `{ "success": true }`. Deletion is permanent and releases quota. Repeating deletion returns `404`.

## Storage

`GET /api/storage` — requires **read** permission.

```json
{
  "used_bytes": 123456,
  "quota_bytes": 20000000000,
  "reserved_bytes": 0,
  "file_count": 1,
  "available_bytes": 19999876544,
  "disk_free_bytes": 29000000000,
  "min_free_disk_bytes": 5000000000,
  "max_file_bytes": 1000000000
}
```

These are illustrative numbers. `available_bytes` is the smaller of quota headroom and disk headroom after the reserve, minus current upload reservations, floored at zero. The filesystem figure corresponds to the persistent mount. Reserving up to one upload's maximum size can temporarily reduce availability more than the number of bytes received so far.

## Errors

Errors use JSON `{ "error": "Readable message" }`.

| Status | Meaning |
| --- | --- |
| 400 | Invalid request, interrupted upload, wrong form field, or more than one file |
| 401 | Missing, expired, invalid, or revoked credentials |
| 403 | Key lacks permission, or a browser mutation fails origin validation |
| 404 | File, key, or endpoint not found |
| 408 | Upload timed out after 15 minutes |
| 413 | Per-file or request-size limit exceeded |
| 415 | Unsupported request Content-Type |
| 416 | Invalid download byte range (empty body and Content-Range header) |
| 409 | Folder or file naming conflict; choose another name or destination |
| 429 | Too many login attempts; retry after 15 minutes |
| 500 | Unexpected server/configuration/storage error; check server logs |
| 507 | Insufficient file quota or disk headroom |

Browser-origin cross-site API access is not enabled. Bearer-key uploads are intended for server-side scripts, curl, n8n, and similar clients; do not embed a private key in another site's frontend JavaScript.
