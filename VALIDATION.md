# Validation

Validated on 2026-10-05 with Node.js 24.19.0.

- Production Next.js build and TypeScript checks passed.
- All 29 test results passed, covering the standalone production API, Node preload normalization, and the selective SQLite notice filter.
- Browser checks passed for administrator login, the initial empty state, multiple file uploads, folder creation, nested directory uploads, breadcrumb navigation, Back/Forward/Up and native browser history, desktop/mobile folder trees, scroll restoration on return, multi-selection, batch moves, destination folder creation, renaming, bulk deletion, filename search, type filters, authenticated file, folder, and selection ZIP downloads, compact header/storage overview, delete confirmation/cancellation, recursive folder deletion, API-key generation, key revocation, and logout.
- Resumable browser checks passed for refreshing after one committed chunk, resuming from that offset, recovering a lost final acknowledgement without duplication, pause persistence, offline/online retries, navigation to API keys during upload, bounded virtualized file lists, cross-tab worker coordination and cancellation, and releasing cached sources after completion.
- The sidebar card stays at the same desktop position when switching between My files and API keys, including direct navigation through Explore the API.
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
