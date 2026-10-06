# Validation

## Repository cleanup and assistant file changes — 2026-10-06

- Production build, strict TypeScript checks across application/scripts/tests/workers, zero-warning lint and formatting checks passed.
- All 69 locally runnable regression checks passed. Coverage includes actual file creation/editing, stale checksums, name collisions, unsupported formats, size limits, permission denial, cancellation, retained revisions and cleanup of revisions after normal deletion.
- Real installed Codex smoke checks passed for direct tool exposure, authenticated callbacks, document text reaching the next model request, streamed replies and resumed threads. These use local Responses fixtures, not live OpenAI inference.
- Assistant browser checks passed at desktop/mobile sizes, including persistent checked permission, per-reply permission labels, sources, previews, history, cancellation and sign-in UI.
- PDF sidebar/search/rotation/text checks and CSV/XLSX browser worker rendering passed. Local Markdown links resolve.
- Two LibreOffice-dependent checks were not run locally because LibreOffice is unavailable. Docker image builds and Compose validation also require Docker, which is unavailable locally. The CI workflow installs conversion dependencies and runs those checks, the full suite, native smoke checks and both image builds.
- Live production deployment/account inference, disaster recovery and restored backups still require operator verification.

## Earlier feature verification

Validated on 2026-10-05 with Node.js 24.19.0.

- Production Next.js build and TypeScript checks passed.
- All 29 test results passed, covering the standalone production API, Node preload normalization, and the selective SQLite notice filter.
- Browser checks passed for administrator login, the initial empty state, multiple file uploads, folder creation, nested directory uploads, breadcrumb navigation, Back/Forward/Up and native browser history, desktop/mobile folder trees, scroll restoration on return, multi-selection, batch moves, destination folder creation, renaming, bulk deletion, filename search, type filters, authenticated file, folder, and selection ZIP downloads, compact header/storage overview, delete confirmation/cancellation, recursive folder deletion, API-key generation, key revocation, and logout.
- Resumable browser checks passed for refreshing after one committed chunk, resuming from that offset, recovering a lost final acknowledgement without duplication, pause persistence, offline/online retries, navigation to API keys during upload, bounded virtualized file lists, cross-tab worker coordination and cancellation, and releasing cached sources after completion.
- The sidebar promotional card has been removed from My files and API keys. The production build and targeted browser checks pass at 1440, 950, and 390 px, including desktop footer positioning and mobile layout.
- Desktop (1440 px) and mobile (390 px) browser checks reported no page errors or horizontal overflow. Screenshots are under `docs/screenshots`.
- Runtime dependency audit reported zero known vulnerabilities at validation time.

API tests cover origin validation, cookie protections, key hashing and permissions, multipart errors, binary and empty files, checksums, path-safe filenames, byte-range downloads, restart persistence, concurrent quota enforcement, interrupted-operation recovery, free-disk reserve, session revocation, and sign-in throttling. Folder tests cover migration from the original database, nested paths, duplicate folder reuse, invalid paths, scoped permissions, persistence, recursive deletion, and quota release.

Explorer API checks cover renaming, nested metadata-only moves, stable IDs/content/checksums/download links and quota, restart persistence, atomic conflict rejection, stale selections, folder cycles, the depth limit, write permissions, origin checks, and batch deletion. The app logs omit the exact SQLite experimental notice while an independent warning test confirms other experimental warnings remain visible.

ZIP tests verify extraction and CRCs with a standard ZIP reader, nested and empty folders, Unicode and binary content, duplicate filenames, read-only authorization, unchanged quota, renamed exports, missing files, and download cancellation. Selection exports also verify mixed files/folders, same-name roots, overlapping descendants included once, GET/HEAD/POST, invalid and stale selections, read-only access, CSRF, and unchanged quota. A ZIP64 export with 65,536 entries opens successfully. Multi-gigabyte archives were not downloaded during testing.

Development startup was also exercised with duplicate preload settings. The launcher kept the hook enabled once and Next.js reached its ready state. Normal settings, distinct hooks, and other Node options are preserved.

The current development server was tested with Turbopack and a duplicated temporary registry hook: administrator login, the files page, a nested folder upload, renaming, folder listing, folder and selection ZIP downloads all succeeded. The hook stayed enabled, and the SQLite notice was absent. Production uses the same native SQLite loader.

Screenshots show sample files uploaded during an isolated browser test. The delivered project starts with an empty drive and contains no working credentials, API keys, or uploaded user files.

The Dockerfile's standalone server was exercised locally. A Docker image build and deployment on your Biznet/Coolify server were not performed because that server was not connected to this session. Follow COOLIFY.md and verify a small upload/download after deployment.

Resumable API checks cover exact quota reservations, idempotent creation and completion, permission and Origin checks, durable offsets across a server restart, wrong-offset rejection, oversized-chunk rollback, actual interrupted request bodies, exclusive request leases, cancellation cleanup, fencing late creates after cancellation, 24-hour expiry cleanup, and recovery after a crash between file rename and metadata publication, including zero-byte files. Browser refresh testing used a twelve-file batch including a 10 MiB file; the largest configured 1 GB file and a full 5,000-file batch were not transferred during validation. Browser storage quotas and eviction depend on the user's browser/device.

## Preview update

The production build and all 39 tests pass, including nine new API subtests for read authorization, safe source text, UTF-16 decoding, truncation, verified inline MIME types, ranges/HEAD, unchanged downloads, XLSX validation, bounded ZIP listings, damaged archives, decompression limits, and unchanged storage metadata/quota.

Chromium browser checks cover filename/menu entry, code highlighting, safe HTML/Markdown, image loading, PDF page navigation/zoom and corrupt-file fallback, XLSX sheet tabs, CSV quoting/source mode, ZIP filtering, audio/video metadata loading, unsupported formats, large text, keyboard navigation, and desktop/mobile layouts. Preview screenshots are under `docs/screenshots/preview-*`. Playback compatibility still depends on the browser codec. No Word/PowerPoint conversion worker is included in this stage.

The final preview browser check also verifies image zoom/fit, exact scroll restoration on close, and a 10 MiB background upload completing while a preview is open. The Turbopack development smoke check passes with duplicate preload hooks retained once. The runtime dependency audit reports zero known advisories for the locked dependency tree.

## Search, sorting and mobile spacing update

The production build and all 45 tests pass. New API tests cover name/date/size/extension sorting before pagination, stable ordering across multiple pages, direct-folder and recursive searches, drive-wide search and legacy file-listing compatibility, current paths after renaming/moving folders, literal SQL wildcards, invalid options, missing folders, and read-only authorization. Files and persistent storage are not migrated or modified by this update.

Chromium browser checks pass for URL-backed search/scope/sort/filter controls, result location links, loading more than 50 files, refresh preservation, app and native Back/Forward, restoring previously loaded pages and scroll after both navigation and reload, and opening a preview from global search. Mobile title-to-action spacing is at least 18 px. Layouts at 320, 390, 430, 950 and 1440 px show no horizontal overflow or browser errors. These checks use isolated temporary storage and generated test credentials, not the production drive. Actual Safari/iOS device testing and the Coolify redeploy remain deployment checks.
