# Deploy Pocket Drive on Coolify

This deploys one Next.js application on your Biznet VPS. Your uploaded files and metadata share a persistent host directory. You do not need PostgreSQL.

## 1. Generate your credentials

On your computer, extract this project, install Node.js 24 LTS, and run:

```bash
npm ci
npm run setup
```

Save the printed password. Open the generated `.env.local` privately; you will copy its hash and secret into Coolify. Do not commit or share this file.

## 2. Put the project in Git

Create a private repository and push the project, including `package-lock.json` and `Dockerfile`. The supplied `.gitignore` excludes secrets, uploads, and build files.

```bash
git init
git add .
git commit -m "Create Pocket Drive"
git branch -M main
```

Add your own repository remote and push `main` using your Git provider's instructions.

## 3. Prepare the VPS directory

In the **server's terminal** in Coolify, create the storage directory:

```bash
sudo mkdir -p /srv/file-storage
sudo chown 1001:1001 /srv/file-storage
sudo chmod 700 /srv/file-storage
df -h /srv/file-storage
```

The application runs as UID/GID `1001:1001`. The directory must be writable by that identity. These commands apply to this dedicated new folder; do not change ownership of unrelated directories.

Based on your reported ~29 GB free, the included 20 GB quota is a reasonable starting point. The quota is an application limit; the folder does not reserve a separate disk partition. The 5 GB disk reserve protects headroom when the app accepts uploads. Continue monitoring the VPS because Docker and other apps can also consume space.

## 4. Create the application

In your Coolify project/environment, add an application from your Git repository and choose the **Dockerfile** build pack.

| Setting | Value |
| --- | --- |
| Branch | `main` |
| Base directory | `/` |
| Dockerfile | `/Dockerfile` |
| Container port / Ports Exposes | `3000` |
| Domain | Your own HTTPS domain, e.g. `https://files.example.com` |
| Replica count | One |
| Rolling deployments | Disabled for this stateful app |

Point the domain's DNS to your VPS using your existing Coolify proxy setup. Use HTTPS. You do not need to publish port 3000 directly to the Internet.

## 5. Set environment variables

Add these as runtime environment variables. Do not make secrets public or prefix them with `NEXT_PUBLIC_`. They are not needed as build variables.

| Variable | Value |
| --- | --- |
| `APP_ORIGIN` | Your exact HTTPS origin, such as `https://files.example.com` — no trailing slash |
| `ADMIN_USERNAME` | `admin` or your chosen username |
| `ADMIN_PASSWORD_HASH` | Copy the complete generated value from `.env.local` |
| `SESSION_SECRET` | Copy the generated value from `.env.local` |
| `STORAGE_PATH` | `/app/storage` |
| `STORAGE_QUOTA_BYTES` | `20000000000` |
| `MIN_FREE_DISK_BYTES` | `5000000000` |
| `MAX_FILE_BYTES` | `1000000000` |

`APP_ORIGIN` must match the URL you actually use to sign in. Do not include `:3000` when the public URL is standard HTTPS.

## 6. Add persistent storage before deploying

In the application's **Persistent Storage** configuration, add a **Volume Mount** with a source path:

| Field | Value |
| --- | --- |
| Source path on VPS | `/srv/file-storage` |
| Destination path in container | `/app/storage` |

An explicit source path creates a bind mount. This one mount includes both file contents and SQLite metadata. Configure it **before the first upload**.

## 7. Deploy and verify

Deploy the application, open your HTTPS domain, and sign in using the credentials generated in step 1.

1. The dashboard should show empty storage and a 20 GB limit.
2. Upload a small file and download it again.
3. Open **API keys**, create a key with read/upload permission, and copy it.
4. Use the on-page cURL example to upload from your computer.
5. Redeploy the app. The file list and API key should still work.

The image provides a health check at `/api/health`. If Coolify asks for health-check settings, use HTTP on port `3000`, path `/api/health`.

## Optional Compose deployment

If you prefer a Docker Compose resource, use the provided `compose.yaml` and configure the same runtime variables in Coolify. The bind mount is already declared in Compose. Attach your domain to the `drive` service on port 3000; Compose owns the mount configuration. Choose either this approach or the Dockerfile application setup above.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Login says origin is not allowed | `APP_ORIGIN` matches the browser URL exactly, with no trailing slash |
| API health returns 500 | Hash/secret configuration, Node 24 image, and storage-directory permissions |
| `EACCES` in logs | `/srv/file-storage` belongs to UID/GID `1001:1001`; mount is writable |
| Upload returns 413 | App's per-file limit, proxy/CDN body limits, and proxy timeouts |
| Upload returns 507 | File quota, concurrent reservations, or disk reserve; delete files or free server space |
| Files disappear after redeployment | Verify the `/srv/file-storage` → `/app/storage` bind mount and `STORAGE_PATH` |
| Upload was interrupted by redeployment | Wait for uploads to finish, then deploy; crashed reservations expire after one hour |

If you use a CDN such as Cloudflare, check its current upload limits. Use DNS-only routing for this storage domain if necessary, or lower the app's upload limit to fit your proxy. The app's 1 GB setting does not raise a CDN's own limit.

Keep off-server backups of the full `/srv/file-storage` directory. See README.md for the stop/archive/start backup and restore procedure.

Reference: [Coolify bind mounts and permissions](https://coolify.io/docs/core/persistent-storage/storage-mounts/bind-mounts).
