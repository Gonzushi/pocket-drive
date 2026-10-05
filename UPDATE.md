# Update an existing local Pocket Drive

This update adds **Download ZIP** to the selection bar so checked files and folders can be downloaded together. It keeps the sidebar’s “Upload your way” card in place when switching between My files and API keys. It makes the files header and storage overview more compact and adds **Download as ZIP** to each folder’s **⋯** menu, including nested files and empty folders. It includes Back/Forward/Up navigation, a folder tree, file/folder renaming, and batch moves/deletion. It retains folder uploads and the duplicate Node preload startup fix. It also filters only the specific SQLite experimental notice during module loading; other warnings and database errors remain visible.

1. Stop the running app with **Control + C**.
2. Extract the updated ZIP into a separate folder.
3. Copy the new source files into your existing `pocket-drive` project, replacing files with matching names. Keep your existing `.env.local` and `storage/` directory. The ZIP excludes both, so neither needs to be replaced.
4. In the existing project, run:

```bash
npm run dev -- --port 3000
```

No dependency versions changed in this update, so an existing successful installation does not need to be installed again. Do not rerun `npm run setup`; keep your existing login credentials.

On your Mac, if the existing project folder is named `pocket-drive`, you can instead save the new ZIP as `~/Downloads/pocket-drive.zip`, stop the app, and run these commands from inside the existing project:

```bash
unzip -o ~/Downloads/pocket-drive.zip -d ..
npm run dev -- --port 3000
```

This merges the updated source into the existing folder. It preserves `.env.local`, `storage/`, and `node_modules/`, because the archive contains none of them. Avoid replacing the entire project folder in Finder.

Open http://localhost:3000. Existing files and folder locations are preserved. Older drives automatically gain folder support without changing file IDs, content, credentials, or API keys. To move an item, open its **⋯** menu and choose **Move to…**, or select multiple items and choose **Move**.

For a fresh installation on a computer using an internal npm registry, install the public dependencies with:

```bash
npm ci --registry=https://registry.npmjs.org/
npm run setup
npm run dev -- --port 3000
```
