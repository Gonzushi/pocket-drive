# Architecture

Pocket Drive is a full-stack Next.js App Router application. Server-rendered pages check authentication and mount interactive React client components. Requests for uploads, downloads and assistant tools use authenticated server APIs. The Codex worker is a separate private Node service.

| Directory               | Responsibility                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| `app/`                  | URL routes, layouts, server authentication and the API entry point |
| `components/ui/`        | Layout, login, keys and shared dialogs                             |
| `components/files/`     | Explorer, folder navigation and uploads                            |
| `components/previews/`  | Lazy-loaded viewers and preview state                              |
| `components/assistant/` | Chat, permissions, sources and account connection                  |
| `lib/server/`           | API dispatch, authorization, SQLite, storage and previews          |
| `lib/server/assistant/` | Conversations, indexing and capability-scoped tools                |
| `lib/client/`           | Browser requests, directory drops and persistent upload queue      |
| `lib/shared/`           | Browser-safe types and file classification                         |
| `services/codex/`       | Private JSON-RPC bridge to personal Codex                          |
| `workers/`              | TypeScript source compiled into the browser table worker           |
| `scripts/`              | Setup, asset generation, extraction and standalone packaging       |
| `tests/`                | Production-server integration tests and transport fixtures         |
| `docs/`                 | User, developer and operator guides                                |

## File request flow

`app/api/[...path]/route.ts` delegates to `lib/server/api.ts`. Authorization checks happen before storage actions. Metadata and quota reservations are in SQLite; file bytes use generated UUID names. File and folder IDs remain stable when items move or are renamed.

## Assistant request flow

The browser submits a message and its file-change permission. The drive persists a run, creates an expiring capability and streams a turn from the private worker. Codex uses direct `pocket_drive` tools. The worker calls the drive API with that capability; the drive rechecks the active run and permissions. Results and source events are saved independently of the browser.

Read-only tools can find and read documents. File-change permission enables explicit requests to create files/folders, edit text/code, rename and move. It does not grant shell access or deletion. Existing conversations refresh their Codex thread when the toolset version changes.

## Storage and consistency

`metadata.sqlite`, its WAL, uploaded blobs, document index, previews and conversations live under `STORAGE_PATH`. Personal Codex authentication and threads live under the worker's `/state` mount.

An assistant edit writes and flushes a new immutable blob before atomically updating the file's SQLite pointer. The previous blob is retained in `file_revisions`. Expected checksums reject stale edits. Retained revisions consume disk space; the upload quota counts current contents, while the disk reserve protects remaining space. Deleting a file through the normal UI also deletes its retained versions.

## Deployment constraints

Run a single drive process against the local SQLite database. This version is not designed for replicas sharing a filesystem, multiple tenants, or rolling updates with concurrent versions. The worker handles one active reply at a time. Health checks verify reachability; the native Codex smoke check verifies tool exposure and routing with a local model-response fixture. Live account/model access is checked after deployment.
