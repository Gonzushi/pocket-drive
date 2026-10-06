# Personal Codex assistant

Pocket Drive runs the website and a separate private Codex worker. The worker uses the official Codex app-server with managed ChatGPT sign-in. No OpenAI API key is required. Replies use **gpt-6.1-sol** with **medium** reasoning; the worker never silently substitutes a different model. Your account must have access to that model. Subscription usage limits apply, and model availability must be verified after sign-in.

## Deploy with Coolify

The existing Dockerfile deployment continues to work as a drive. To enable the assistant, deploy the repository's `compose.yaml` as a Docker Compose application. This starts both `drive` and `codex`. Keep the same existing drive mount and credentials so your saved files and metadata stay available. Run one instance of each service and disable rolling deployments: the database and worker are designed for a single private workspace.

1. In the **VPS host terminal**, prepare the worker's persistent folder:

   ```sh
   mkdir -p /srv/pocket-drive-codex
   chown 1001:1001 /srv/pocket-drive-codex
   chmod 700 /srv/pocket-drive-codex
   openssl rand -hex 32
   ```

2. Set the generated value as `ASSISTANT_WORKER_SECRET` in Coolify, alongside your existing `APP_ORIGIN`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, quota and disk reserve settings. This is a server-to-server secret, not an API key. Do not put it in a public `NEXT_PUBLIC_*` variable or commit it.
3. Set your existing public domain on the **drive** service, port **3000**. Keep the Codex worker private, with **no public domain or host port**. Compose supplies `ASSISTANT_WORKER_URL=http://codex:4400` to the drive and `POCKET_DRIVE_URL=http://drive:3000` to the worker.
4. Confirm the mounts before deploying:

   | Service | Host directory | Container directory | Contains |
   | --- | --- | --- | --- |
   | drive | `/srv/file-storage` | `/app/storage` | Uploads, metadata, conversations, document index, preview cache |
   | codex | `/srv/pocket-drive-codex` | `/state` | Personal Codex sign-in and Codex threads |

   The drive's `STORAGE_PATH` is **`/app/storage`**, not `./storage` on the host. Back up both host directories. The worker has no mount of your uploaded files or the drive's database.
5. Deploy. Open **Assistant → Connect Codex**, follow the official sign-in link, and enter the displayed device code. If device sign-in is disabled, enable it in your ChatGPT security settings. Authenticate the personal account you want to use. Pocket Drive never asks for your ChatGPT password.
6. Send a small test message such as “Find my project document and summarize it.” This validates your account's actual access to `gpt-6.1-sol`; sign-in alone cannot prove model entitlement. If Codex reports a model or usage error, the conversation shows it without changing models.

If you keep a Dockerfile application instead, deploy `services/codex/Dockerfile` separately on the same private Docker network. Set its `ASSISTANT_WORKER_SECRET`, `POCKET_DRIVE_URL` (the private drive address), and `/state` persistent mount. Set the matching secret and private `ASSISTANT_WORKER_URL` on the drive. Do not expose the worker to the internet. The two containers must be able to reach one another.

## Using the assistant

- Ask it to find documents anywhere in the drive, explain code, summarize a file or compare documents. Search results include exact folder locations, and answers can cite page, line or spreadsheet row labels.
- Open a file preview and use **Ask assistant about this file** to attach that file as context. The assistant reads the actual document through an authorized tool, rather than trusting a filename or a pasted summary.
- Source cards open the existing preview, and their folder buttons open the file's location. File access continues to require your normal Pocket Drive session.
- Organization is off by default. Enable **Allow folder creation, moving and renaming for this message** when you explicitly request changes. It resets after sending. There is no deletion, sharing, upload, arbitrary shell or code-execution tool.
- Use **Stop** to interrupt a reply and immediately revoke its document access. Closing the browser does not discard the reply. Reopen the conversation to see the saved result. A server restart marks unfinished replies interrupted; send a new message to continue the saved Codex thread.
- Disconnect signs the worker out. Sign-in tokens are managed by Codex and persisted only under `/state`; no token is returned to the browser.

## Reading and indexing limits

Search combines filenames with a persistent local full-text index. It does not use an embedding API. Indexing begins when the assistant is opened and runs in bounded batches; newly uploaded or renamed files are picked up on subsequent visits/status checks. Coverage is shown in the interface and returned to the model, so an incomplete index is not treated as proof that a document does not exist. Deleted files disappear from content search immediately, and orphaned index rows are cleaned up in the next batch.

| Content | Reader and bounds |
| --- | --- |
| Text, code, Markdown | First 512 KiB, labeled line ranges; maximum 256 sections |
| CSV, TSV | First 512 KiB; parsed quoted records, first 1,000 rows and 50 columns; labeled row ranges |
| PDF | Files up to 100 MiB; first 100 pages, maximum 1 million extracted characters |
| DOCX, PPTX, ODT, ODP | Existing bounded LibreOffice preview conversion, then PDF text extraction |
| XLSX | Files up to 10 MiB; validated ZIP; first 20 sheets, 1,000 rows and 50 columns per sheet; cached values, no formula evaluation |
| Images, audio, video, unsupported formats | Filename/location search and existing previews; no OCR or transcription in this version |

Empty scanned PDFs are reported as having no readable text. Truncated documents are marked limited. Reading a tool result is bounded to five sections and 30,000 characters; the assistant can paginate. Each reply has a maximum of 40 document-tool calls, eight minutes, and 65,536 response characters. The index has a 128 MiB extracted-content budget. These limits protect a small VPS and are separate from your upload quota; preserve the free-disk reserve and monitor storage. Index/cache backups contain extracted document text.

The worker runs as UID/GID 1001 with no added Linux capabilities. Native shell/browser/computer tools are disabled, and unexpected approval requests fail closed. Each document-tool call requires a short-lived, signed capability for a currently active reply. Organization permission is checked in the drive server on every mutation. Document contents are explicitly treated as untrusted data in the assistant instructions.

Document sections you ask Codex to read are sent to OpenAI using your connected account. This is a personal, authenticated workspace integration, not a public chatbot serving unrelated users through your subscription.

If a connected assistant reports that the tool host is disabled, redeploy **both drive and codex** from the latest commit. Document tools are registered as direct calls in the `pocket_drive` namespace using `features.code_mode.direct_only_tool_namespaces`; they do not depend on the disabled code-mode host. Existing conversations automatically get a fresh Codex thread on their next message when the toolset version changes, preserving their saved history. No disconnect or deletion of persistent state is needed.

## Verification

Run `npm run build`, `npm run typecheck`, and `npm test`. The assistant integration tests use a clearly isolated deterministic worker fixture to exercise real website authentication, document readers, indexing, streaming persistence, organization permissions, cancellation and server restarts. Worker transport tests cover concurrent JSON-RPC messages, tool requests, notifications, failures and recovery. They do not spend subscription usage or claim to test model inference. A real-account end-to-end reply is a post-deployment check after personal sign-in.

Run `npm run smoke` inside `services/codex` to exercise the installed Codex executable. A local Responses fixture verifies that the model request actually exposes `pocket_drive.read_document`, a tool invocation reaches the drive callback with the run capability, the returned document text reaches the next model request, and the reply streams through the worker. The check repeats after resuming the same thread and also runs during the worker image build. It makes no OpenAI requests and requires no account or API key.
