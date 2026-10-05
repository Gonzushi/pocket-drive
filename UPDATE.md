# Update Pocket Drive

This update adds authenticated file previews through filename clicks and **⋯ → Preview**, with Previous/Next navigation, zoom, sheet tabs, media playback, safe source text, and ZIP contents. Unsupported formats offer details and Download. See [the preview guide](docs/PREVIEWS.md) for supported formats, limits, and the saved second-stage Office conversion plan.

## GitHub / Coolify

Use the current `main` branch of `Gonzushi/pocket-drive` and redeploy in Coolify. The Dockerfile installs the locked preview dependencies and builds local viewer assets automatically. Keep the same persistent mount at `/app/storage`, runtime `STORAGE_PATH=/app/storage`, and existing credentials. A correctly mounted storage directory keeps your files, database, folders, API keys, and upload sessions across deployments. No database reset or setup command is needed.

After deployment, upload a small file and open its preview. Check an existing PDF or spreadsheet if available, then verify that your files remain after another redeploy. The smaller preview limits do not reduce the normal upload limit.

## Existing local Git checkout

Stop the running app, then run inside your `pocket-drive` checkout:

```bash
git pull --ff-only origin main
npm ci
npm run dev -- --port 3000
```

On a computer configured to use an internal npm registry, use `npm ci --registry=https://registry.npmjs.org/` for the dependency installation. Keep your existing `.env.local` and `storage/` directory. Do not rerun `npm run setup`.

The existing folder navigation, moves/renames, folder/selection ZIP downloads, compact sidebar, Node preload handling, SQLite warning handling, and refresh-safe upload queue remain available. Wait for **Preparing uploads** to finish before refreshing during a new batch. Recovery uses the same browser and site address.
