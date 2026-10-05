# Pocket Drive previews

Open any file using its filename or **⋯ → Preview**. Previews are read-only and retain the same login/API read permissions. Previous/Next and left/right keys browse the currently loaded file list; Escape closes the overlay and restores focus. Each viewer has a Download action.

| Format | Viewer / limits |
| --- | --- |
| JPG, PNG, GIF, WebP, AVIF, BMP | Image zoom and fit; up to 25 MiB |
| PDF | Page navigation and zoom; up to 100 MiB; password-protected PDFs require download |
| TXT, SQL, Scala, JSON, logs, common code files | Line numbers; highlighting for common languages; up to 512 KiB / 2,000 displayed lines |
| Markdown | Formatted / Source; HTML disabled, external images shown as labels |
| CSV, TSV | Table / Source; quoted fields; first 1,000 rows / 50 columns |
| XLSX | Read-only sheet tabs; first 20 sheets / 1,000 rows / 50 columns; no formula recalculation or workbook formatting |
| MP3, WAV, OGG, FLAC, M4A | Native audio playback when the browser supports the codec |
| MP4, M4V, MOV, WebM, OGV | Native video playback when the browser supports the codec |
| ZIP | Contents list and search; first 1,000 entries; no extraction |
| Other / legacy / proprietary formats | Metadata and authenticated download |

Large or corrupt files show a clear fallback; recoverable request failures have Retry. Text truncation and table/archive limits are explicit. Table parsers have a 20-second deadline and terminate when their preview closes. Workbook uploads still accept the normal upload maximum; the smaller preview limits protect browser/server resources. Workbook preview output is also capped at 100,000 cells, about two million text characters, and 1,000 characters per cell. Source filenames select the viewer, while safe inline types also require matching content signatures.

## Second stage: Office conversion

The saved plan is to add Word, PowerPoint, and older Office formats using a separate server-side conversion worker that produces cached PDFs. This will need Docker/worker resource configuration, conversion timeouts, cache limits, fonts, and fidelity tests. No external public viewer or public file URL is required. Native Office formatting may differ after conversion. This stage is not implemented by the first preview update.
