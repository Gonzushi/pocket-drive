# Using Pocket Drive

## Everyday use

1. Sign in, then choose **Upload files**, **Upload folder**, or drop files/folders into the upload area. Uploads go into the folder you are viewing.
2. Open folders by clicking their names or using the sidebar tree. Use **Back**, **Forward**, **Up one level**, or the breadcrumb path to navigate. On mobile, tap **Folders** for the folder drawer. Choose **This folder**, **Include subfolders**, or **Entire drive** for filename search. Drive-wide and recursive results show their containing path; click a file's path or a folder's **Open location** action to visit its parent folder. Sort by name, upload date, size, or extension; folders stay first (folders sort alphabetically for size/type sorting). Search, scope, filters and sorting are saved in the URL. Opening a folder clears search and returns to that folder's contents while keeping sorting and file-type filters; Back restores the previous search and scroll position.
3. Use the download arrow to save it to your device.
4. Use an item's **⋯** menu to rename, move, delete, or download a folder as ZIP. Check several items, then choose **Download ZIP** to download them together, or choose another batch action. In **Move to**, browse to your destination (or create a folder), then choose **Move here**. **Open destination** takes you to the result.
5. Open **API keys** to connect a script. Create one key per tool, copy it immediately, and use the example on that page.

There are no public file links. The download URL returned by the API still requires a signed-in browser or an API key. Every API key with read permission can access all files in this single workspace.

Folder uploads process one file at a time and display each relative path in the upload panel. Existing folders with the same path are reused; repeated files are kept as separate uploads. A partial failure does not undo successful files. Up to 5,000 files can be selected per UI batch, and folders can be nested up to 32 levels (10,000 folders per drive). Browser directory selection exposes file paths, so empty subfolders are not included; use **New folder** to create empty folders.

### Refresh-safe uploads

After selecting files or a folder, the website saves the source files and queue in this browser using IndexedDB. **Keep the tab open during Preparing uploads**; a refresh before this atomic preparation finishes may require selecting the files again. Once the panel says **Uploading files**, refresh or reopen Pocket Drive on the same origin, browser, and profile to continue automatically. It resumes from the last server-confirmed chunk, and completed files are not uploaded twice. A chunk interrupted during refresh may be sent again.

The compact panel shows overall byte progress and the completed file count. Batches of more than five files start collapsed. Expand the panel for the current file, a scrolling list, **Pause**, **Resume**, or **Cancel uploads**. Pause is remembered after refresh. Cancelling removes unfinished uploads and their saved sources; files already uploaded remain in your drive. The panel stays available while navigating within the workspace. Open tabs share one queue and coordinate one uploader.

Closed tabs do not transfer bytes in the background. Reopening the app continues the saved queue. A sign-in expiry pauses the queue until you sign in again. After 24 inactive hours, an unfinished server session expires; the browser can start that file again from its cached source. Browser storage must have room for the selected files. Sources are removed from browser storage as each file finishes; clearing site data, private-session closure, storage eviction, or switching browsers/origins can lose an unfinished queue. The app requests persistent storage where supported and explains a storage failure before starting the batch. You can select a smaller batch if device storage is limited.

Select up to 100 files and/or folders and choose **Download ZIP** to create one archive of that selection. Selected files appear at the ZIP root; selected folders retain their nested structure. Items already included inside a selected folder appear only once.

To download a folder, open its **⋯** menu and choose **Download as ZIP**. The ZIP includes that folder, all nested files, and empty folders. Exports stream directly without using extra drive storage. Duplicate filenames receive numbered suffixes, and characters that cannot be extracted safely on common operating systems are replaced. Downloads require read access and support up to 100,000 entries; download a smaller subfolder for larger collections. ZIP exports do not support byte-range resume. If files are deleted during an export, refresh and retry.

Deleting a folder permanently removes every file and subfolder inside it after showing a confirmation with the counts and total size.

Moves keep file IDs, private download URLs, checksums, and storage usage unchanged. A batch either moves completely or changes nothing. A folder cannot be moved into itself or its descendants, and moves cannot exceed 32 folder levels. Rename/move collisions within the same item type use SQLite ASCII case-insensitive matching and return a clear error; choose another name or destination. Existing repeated uploads remain separate files.
