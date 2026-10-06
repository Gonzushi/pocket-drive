# Configuration

| Variable              | Meaning                                                      | Default                                       |
| --------------------- | ------------------------------------------------------------ | --------------------------------------------- |
| `APP_ORIGIN`          | Exact website origin; HTTPS in production; no trailing slash | `http://localhost:3000`                       |
| `ADMIN_USERNAME`      | Single workspace administrator                               | `admin`                                       |
| `ADMIN_PASSWORD_HASH` | Generated `scrypt:salt:hash` credential                      | Required                                      |
| `SESSION_SECRET`      | Random secret used to hash session tokens and API keys       | Required, at least 32 characters              |
| `STORAGE_PATH`        | Directory containing uploads and SQLite                      | `./storage` locally; `/app/storage` in Docker |
| `STORAGE_QUOTA_BYTES` | Total file-content quota                                     | `20000000000`                                 |
| `MIN_FREE_DISK_BYTES` | Keep at least this much disk free for other services         | `5000000000`                                  |
| `MAX_FILE_BYTES`      | Maximum one-file size                                        | `1000000000`                                  |

Website uploads send chunks of up to 4 MiB with a two-minute chunk deadline. Pending sessions reserve the exact file size and expire after 24 hours without activity; finishing or cancelling releases the reservation. Expired partials are removed on the next storage check or upload. The original multipart API retains its 15-minute timeout and up-to-per-file-limit reservation, with one-hour crash expiry.

Set a smaller per-file limit if needed. For example, 100 MB is `MAX_FILE_BYTES=100000000`. Your proxy or CDN may have its own lower limit.

See [Operations](operations.md) for disk space, revision retention and persistent mounts.
