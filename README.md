# Pocket Drive

A private drive for your own server: folders, resumable uploads, searchable file previews and an optional assistant using your personal Codex account.

## Start locally

Use Node **24.13 or newer in the Node 24 series**.

```bash
npm ci
npm run setup
npm run dev
```

Open http://localhost:3000. Setup writes an ignored `.env.local` and prints your credentials once. Save the password securely.

## Find your guide

| Task                                 | Guide                                 |
| ------------------------------------ | ------------------------------------- |
| Deploy on Coolify and preserve files | [Deployment](docs/deployment.md)      |
| Connect the personal Codex assistant | [Assistant](docs/assistant.md)        |
| Understand the repository            | [Architecture](docs/architecture.md)  |
| Develop, test and contribute         | [Development](docs/development.md)    |
| Back up, restore and troubleshoot    | [Operations](docs/operations.md)      |
| Use the REST API                     | [API](docs/api.md)                    |
| Preview documents, code and media    | [Previews](docs/previews.md)          |
| Browse all documentation             | [Documentation index](docs/README.md) |

## Features

- Folder navigation, filename search, sorting, moving and renaming.
- Refresh-safe resumable uploads and private downloads, including folder ZIP exports.
- Image, PDF, code, Markdown, spreadsheet, Office and media previews.
- A personal Codex assistant that reads and summarizes documents and, with permission, creates files/folders, edits text/code, renames and moves items.
- SQLite metadata, explicit quotas, a free-disk reserve and private non-root containers.

The app serves one administrator and one workspace. Uploaded data and Codex sign-in need persistent mounts. Read [operating constraints](docs/architecture.md#deployment-constraints) before deployment.

## Code layout

Next.js routes are in `app/`; feature UI is in `components/`; server, browser and shared utilities are separated in `lib/`. The private Codex worker is in `services/codex/`. TypeScript is the source language; preview assets and browser-worker JavaScript are generated during builds.

[Contributor instructions](AGENTS.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
