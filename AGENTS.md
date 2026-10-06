# Pocket Drive contributor instructions

Read [docs/architecture.md](docs/architecture.md) before changing module boundaries and [docs/development.md](docs/development.md) for commands.

## Repository map

- `app/`: thin Next.js route/layout entry points.
- `components/{ui,files,previews,assistant}/`: browser UI by feature.
- `lib/server/`: authenticated API, metadata and filesystem operations.
- `lib/client/`: browser-only utilities. `lib/shared/`: browser-safe contracts.
- `services/codex/`: independent private personal Codex worker.
- `workers/`: generated browser worker source. `scripts/`: setup/build/extraction.
- `tests/`: isolated production-server tests. `docs/`: authoritative guides.

## Rules

1. Preserve public URLs, IDs, persistent paths and existing data. Schema upgrades must be additive and documented with rollback implications.
2. Enforce authorization on the server. Client components must not import server modules. Treat document contents as untrusted data.
3. Never log or commit credentials, account state, capabilities or uploaded files. Never use production storage for tests.
4. Assistant writes require an active run and its recorded file-change permission. Edits check a current checksum and retain immutable previous contents.
5. Preserve personal Codex sign-in, `gpt-6.1-sol`, medium effort and direct `pocket_drive` tools. Never substitute API-key authentication or enable arbitrary shell tools.
6. Change tool definitions, routing, tests and docs together. Increment `ASSISTANT_TOOLSET_VERSION` when the tool contract changes.
7. Prefer small readable functions and feature modules. Do not introduce speculative abstractions, duplicate agent instructions or generated artifacts into Git.

## Validation

Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build`, then `npm test`. Build and integration tests share `.next`; run them sequentially. For worker changes, install its locked dependencies and run `npm --prefix services/codex run smoke`. Full preview checks require conversion binaries; report missing checks honestly.

Review the diff for unrelated changes and update the relevant documentation. Do not claim a live deployment or account inference check when only local fixtures passed.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
