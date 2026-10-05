# Pocket Drive previews

Open a filename or **⋯ → Preview**. All viewers are read-only and require the existing login/API read permissions. Download returns the untouched original. The expanded viewer has optional details, full filenames, checksums, keyboard navigation, and a mobile layout. Closing restores focus and scroll position. Previous/Next follows the folder/search/filter/sort snapshot and fetches further pages, deduplicated by file ID.

| Format | Viewer and limits |
| --- | --- |
| JPG, PNG, GIF, WebP, AVIF, BMP | Actual size, fit, rotation, drag to pan, touch pinch; 25 MiB |
| PDF | Selectable text, search, lazy thumbnails, page jump, rotation, fit width, zoom; 100 MiB |
| Text and code | Read-only CodeMirror, language selector, syntax highlighting, folding where supported, search, selection matching, wrapping, themes, line jump, copy; first 512 KiB |
| JSON | Raw / formatted preview; original stays unchanged |
| Markdown | Formatted / source; uploaded HTML disabled, external images shown as labels |
| CSV, TSV, XLSX | Search, numeric-aware column sort, optional header row, sticky headers, original row numbers, expanded/copyable cells; 20 sheets, 1,000 rows, 50 columns |
| DOCX, PPTX, ODT, ODP | Cached server-generated PDF; 20 MiB input |
| MP3, WAV, OGG, FLAC, M4A | Native audio, speed, ten-second seeking, resume |
| MP4, M4V, MOV, WebM, OGV | Range streaming, fast-start MP4, optional 720p H.264/AAC, speed, seek, native fullscreen, resume |
| ZIP | Searchable contents, first 1,000 entries; no extraction |
| Legacy DOC/PPT and other formats | Details and original download |

CodeMirror renders the visible source rather than thousands of DOM rows. HTML/SVG and other source remain inert text. Viewer libraries load on demand. Session storage remembers code scroll/wrapping, image zoom/rotation, PDF page/zoom/rotation, and media position. Code theme and playback speed are shared session preferences.

PDF search examines native text in the first 500 pages; thumbnails cover the first 200 pages. Page navigation reaches the remaining pages. Scanned PDFs need OCR, which is not included. Office layout/fonts can differ; animations, macros, embedded media, and editing are not reproduced.

Table search/sort covers loaded preview rows. Formulas are not recalculated. The parser has a 20-second deadline and stops when closed. Workbook output is capped at 100,000 cells, two million characters, and 1,000 characters per cell. Truncation is visible.

## Deployment and streaming

Redeploy with the repository Dockerfile, which installs FFmpeg, FFprobe, LibreOffice Writer/Impress, fonts, and util-linux. Generated previews live in STORAGE_PATH/previews on the existing persistent mount. Keep the mount and run one instance with rolling deployments disabled, as documented in README.md.

Outside Docker, install the same Linux tools. Optional FFMPEG_BIN, FFPROBE_BIN, and LIBREOFFICE_BIN override executable paths. /usr/bin/prlimit is required. Core previews and original media remain available when conversion tools are missing.

Documents start conversion when opened. Video Auto prepares a fast-start copy while the original stays available. Already-playing Auto video is not interrupted; reopening uses the cached version. Choosing 720p requests a smaller derivative; Original switches back immediately. Preparation must finish once before the cached version can improve startup. Original playback depends on browser container/codec support.

Auto remuxes H.264 with compatible AAC/MP3 audio without re-encoding. Other videos and 720p use H.264/AAC at up to 1280×720, preserving aspect ratio, CRF 25, 2.2 Mbps maximum video bitrate, and 128 Kbps audio. Playback metadata is placed first and byte ranges support seeking. This is fast-start MP4, not adaptive HLS/DASH. Long videos can exceed the limits; their originals stay available.

## Conversion limits and cache

Jobs run serially in separate child processes, with at most eight admitted jobs. Limits: 2 GiB address space, 160 CPU seconds, 60-second document / 150-second video deadline, two encoding threads, 128 MiB per output. Children receive job-local profiles and a small environment without application credentials. These are bounded subprocesses, not an OS container sandbox.

Office ZIP validation rejects encrypted/macro-enabled content, external relationships (including hyperlinks), XML entities, more than 2,000 entries, or more than 64 MiB declared decompressed contents. Protected or damaged content offers an original download.

The cache is trimmed to 512 MiB after successful preparation, with seven-day idle eviction. Temporary directories are removed after completion; abandoned directories are cleaned after subsequent successful preparation. Previews are excluded from upload quota but consume filesystem space and respect disk reserve. Source/extension fingerprints invalidate derivatives, and deletion removes them. Failed jobs have a one-minute retry cooldown. After a server restart, interrupted jobs can be requested again immediately; ready derivatives persist.

## API and security

GET /api/files/{id}/preview/prepare?variant=document|stream|mobile checks status without starting work. POST starts/reuses preparation and requires same-origin validation for browser sessions. Both require read permission. Responses contain status (idle/running/ready/failed), error, and a ready URL. Running returns 202; other states return 200. A full queue returns 429.

GET/HEAD /api/files/{id}/preview/prepared?variant=... serves the derivative with authenticated single-range responses, nosniff, and private/no-store caching. Not-ready derivatives return 202 JSON. No public viewer or public URL is used.

Normal downloads remain application/octet-stream attachments. Inline originals need verified signatures. HTML/SVG/XML/code never execute. XLSX input stays capped at 10 MiB with a ten-second archive validation deadline and 32 MiB actual decompressed limit. Corrupt, oversized, protected, and unsupported content retains an original-download fallback.
