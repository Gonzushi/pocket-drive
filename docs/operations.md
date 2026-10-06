# Operations

## Persistent mounts

| Service | Host                      | Container      |
| ------- | ------------------------- | -------------- |
| drive   | `/srv/file-storage`       | `/app/storage` |
| codex   | `/srv/pocket-drive-codex` | `/state`       |

Use UID/GID 1001 and private permissions. Route HTTPS to the drive's port 3000. The worker's port 4400 stays private. Matching worker secrets and private URLs are required on both services. See [Deployment](deployment.md) and [Assistant](assistant.md).

## Backups and restore

1. Stop both services in Coolify so SQLite and file writes are quiescent.
2. Back up both host directories with ownership and permissions preserved. Include SQLite WAL/SHM files if present, file revisions, cache/index data and worker state. Store encrypted backups outside the VPS.
3. Restart services and check login, a download and an assistant reply.
4. Periodically restore into isolated directories with separate domains and secrets; verify actual downloads and document reading. A backup is not verified until a restore succeeds.

To restore production, stop services, preserve the current directories, restore the complete matching backup, verify UID/GID 1001, then restart. Never restore only the database without its matching file blobs. Authentication state in backups is sensitive.

## Assistant file edits

Text/code writes are limited to 96 KiB. Edits require the current checksum and keep at most 100 previous versions per file. Revisions are in `file_revisions` and their immutable blobs are in `files/`. There is no revision browser yet: recover an old blob through an operator using the recorded `blob_id`, verify its SHA-256 and save it as a separate file through the normal upload UI. Avoid manual database edits while the app is running.

## Monitoring

Check `/api/health`, service health, available disk, upload failures and backup age. The quota covers current files; database, previews, revisions and Docker images consume additional disk. Preserve the configured free-space reserve. Never log credentials, capabilities, document contents or sign-in tokens.

## Troubleshooting

| Symptom                         | Check                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| Files disappear after redeploy  | Drive mount and absolute `STORAGE_PATH`                                             |
| Worker unavailable              | Private network, matching secrets, worker logs and service health                   |
| Connected but tools unavailable | Deploy both services from the same commit; send a new message                       |
| Cannot create/edit              | Enable file changes before sending; check format, size, collisions and disk reserve |
| Edit conflict                   | Read the latest file and use its current checksum                                   |
| Office/media preview fails      | Conversion binaries, fonts, cache space and resource limits                         |

## Upgrades and rollback

Back up before deployment, record the deployed commit and deploy both services together for assistant changes. Run smoke checks and verify downloads, uploads and a live assistant reply. For rollback, review schema compatibility first; the immutable-blob edit format requires a version that understands `files.blob_id`. Restore the matching database-and-files backup when reverting to an older version that lacks this support.
