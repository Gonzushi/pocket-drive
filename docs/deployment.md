# Deploy on Coolify

Use the existing GitHub repository and deploy its `compose.yaml` for both the drive and personal Codex worker. To run without an assistant, deploy the root `Dockerfile` instead and omit assistant variables.

## Prepare persistent storage

Run on the **VPS host terminal**, not inside a disposable container:

```bash
sudo mkdir -p /srv/file-storage /srv/pocket-drive-codex
sudo chown 1001:1001 /srv/file-storage /srv/pocket-drive-codex
sudo chmod 700 /srv/file-storage /srv/pocket-drive-codex
```

Confirm these mounts before deployment:

| Service | Host directory            | Container directory |
| ------- | ------------------------- | ------------------- |
| drive   | `/srv/file-storage`       | `/app/storage`      |
| codex   | `/srv/pocket-drive-codex` | `/state`            |

Compose already defines the mounts. Keep `STORAGE_PATH=/app/storage` in the drive. The host folder `/srv/file-storage` is outside `/root`, so view it with `ls -la /srv/file-storage` or `cd /srv/file-storage`.

## Configure Coolify

1. Select the repository and Docker Compose build pack with `compose.yaml`.
2. Generate drive credentials locally using Node 24, `npm ci` and `npm run setup`. Copy `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` and `SESSION_SECRET` privately from `.env.local` to Coolify.
3. Generate a separate worker secret with `openssl rand -hex 32` and set `ASSISTANT_WORKER_SECRET`. Compose supplies the same secret to both services.
4. Set `APP_ORIGIN=https://pocket-drive.trip-nus.com`. Set quota, minimum free space and maximum file size as described in [Configuration](configuration.md).
5. Configure the service domains:

   | Service | Domain                                   |
   | ------- | ---------------------------------------- |
   | drive   | `https://pocket-drive.trip-nus.com:3000` |
   | codex   | Leave empty                              |

   The domain's `:3000` selects the internal drive port in Coolify; users open the normal HTTPS domain. Do not publish host ports for the worker.

6. Deploy, check both health statuses, sign in, upload/download a sample and redeploy once to verify persistence.
7. Follow [Assistant](assistant.md) to connect personal Codex and check a live document reply.

Compose supplies `ASSISTANT_WORKER_URL=http://codex:4400` and `POCKET_DRIVE_URL=http://drive:3000`. Keep both services on the same private Docker network. Do not enter `localhost` for communication between containers.

## Updates

Deploy both services from the same commit for assistant/tool changes. Back up both mounts before updates. The worker image runs native tool-routing smoke checks during its build. A successful build does not verify live account entitlement, production networking or uploaded document contents; check these after deployment.

For separate Dockerfile applications, configure the same mounts, matching secret and private URLs manually. See [Operations](operations.md) for backup, restore and rollback.
