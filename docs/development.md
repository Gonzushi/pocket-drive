# Development

Use Node 24.13 or newer in the Node 24 series. Run all app commands from the repository root.

```bash
npm ci
npm run setup
npm run dev
```

Open http://localhost:3000. Setup writes ignored `.env.local` and prints credentials once. Use a separate scratch storage directory for development; never point tests at production storage.

## Commands

| Command                                 | Purpose                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `npm run dev`                           | Generate local preview assets and run Next.js                           |
| `npm run build`                         | Check types, generate assets and package standalone output              |
| `npm start`                             | Start the built standalone server                                       |
| `npm run typecheck`                     | Check app, scripts, tests, browser worker and Codex service             |
| `npm run lint`                          | Check Next.js, React and module boundaries                              |
| `npm run format`                        | Format owned source and documentation                                   |
| `npm run format:check`                  | Verify formatting without modifying files                               |
| `npm test`                              | Exercise real production-server behavior with isolated fixtures         |
| `npm --prefix services/codex run smoke` | Check the real installed Codex executable using local fixture responses |

Build before integration tests: they start `.next/standalone/server.js`. Do not rebuild concurrently with those tests. Install `ffmpeg`, LibreOffice, fonts and `pdftotext` for the full media/Office suite; CI installs these dependencies.

## Conventions

Keep client imports inside `lib/client`, `lib/shared` and client components. Server APIs enforce authorization even when the UI hides a control. Use explicit types at data boundaries, readable functions and comments that explain constraints. Change API contracts, tool definitions, tests and docs together. Bump the assistant toolset version when its tool contract changes.

Most source is TypeScript. Node 24 directly runs erasable `.ts` scripts. The ESLint configuration is `.mjs` because Node loads it as native ESM. Browser worker and vendor assets are generated JavaScript and ignored in Git. Do not edit generated files.

Downloadable uploaders live in `scripts/upload/`: `uploader.py` is shared by the Python Bash/PowerShell launchers; `native-macos.sh` and `native-macos.js` use built-in macOS tools; `native-windows.ps1` is embedded in a self-contained CMD launcher using Windows PowerShell 5.1. `lib/server/uploader-scripts.ts` renders these templates; `uploader-download.ts` supplies the configured public origin and private download response. No API key is embedded. All versions share resumable version 1 JSON reports. See [terminal-uploads.md](terminal-uploads.md).

Build first, then run `python3 tests/uploader.py` for isolated real-server integration tests. `python tests/native-uploaders.py` executes rendered native launchers against an HTTP fixture on macOS/Windows; CI provides both runners. Python is a test runner here, not a native client dependency. `node scripts/render-uploaders.ts OUTPUT_DIR ORIGIN` renders native launchers for these tests without a Next.js server. The production standalone build includes the authored templates.
