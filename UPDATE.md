# Update an existing local Pocket Drive

This update removes the “Upload your way” card from the sidebar on both My files and API keys. Sign out remains at the bottom on desktop.

It includes **refresh-safe uploads** for files and folders, overall and per-file progress, persistent pause/resume, automatic connection retries, and a compact upload panel that stays visible across the workspace. Batches of more than five files start collapsed; expanding them shows a fixed-height scrolling list. Completed files are never duplicated when recovering the same saved queue. Keep the tab open during the initial **Preparing uploads** step; once that finishes, refresh or reopen the app in the same browser to continue.

It retains folder navigation and moves, folder/selection ZIP downloads, the compact header, the sidebar navigation, and the Node preload and SQLite notice fixes. There are no dependency changes. The database adds an upload-session table automatically without changing existing file content, login credentials, or API keys.

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

## Existing GitHub / Coolify deployment

Merge the updated source into your GitHub checkout, preserving your environment files and storage directory. Review the changes, commit and push to the branch Coolify deploys, then redeploy. Keep the same persistent storage mount and runtime environment settings. The upload-session table is created automatically on startup. No reset or new password is needed. Verify a small folder upload, then refresh during a larger file upload to check recovery on your deployed origin.

The browser caches selected sources locally for recovery, so allow device storage and use smaller batches if needed. Transfers pause when the app is closed and resume when it is reopened. Sources are released after each successful file. See README.md for preparation, retention, and browser-storage limits.
