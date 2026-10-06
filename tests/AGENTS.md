# Tests

Tests start the actual built standalone server against temporary storage. Build first and do not rebuild concurrently. Never reuse production state or credentials.

Use fixture HTTP/JSON-RPC boundaries for deterministic tests; fixture payloads are deliberately explicit flexible records, not production contracts. Assert observable authorization, persisted contents, quota behavior, conflict handling, cancellation and restart recovery. Do not test only that a configuration string equals its implementation.

PDF reading needs `pdftotext`. Full Office/media conversion checks need LibreOffice, fonts and ffmpeg. Keep required tests enabled in CI; document unavailable local dependencies. A local fixture result is not a live Codex inference result.
