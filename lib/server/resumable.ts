import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rename, rm, stat, truncate } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config';
import { db, transaction, fileById } from './db';
import { ensurePath, folderName, parentId, relativeParts, trail } from './folders';
import { HttpError } from './http';
import {
  cleanup,
  diskFree,
  diskReserved,
  filePath,
  kindOf,
  reserved,
  totals,
  validId,
} from './storage';

const TTL = 24 * 60 * 60_000;
const LEASE = 90_000;
export const CHUNK_SIZE = 4 * 1024 * 1024;
interface Upload {
  id: string;
  name: string;
  size: number;
  mime_type: string;
  destination: string | null;
  relative_path: string;
  offset: number;
  status: string;
  expires: number;
  created_at: string;
  lease_token: string | null;
  lease_until: number;
}
const temporary = (id: string) => path.join(config().storagePath, 'tmp', id);
function row(id: string) {
  const upload = db().prepare('SELECT * FROM uploads WHERE id = ?').get(id) as unknown as
    Upload | undefined;
  if (!upload || upload.expires < Date.now())
    throw new HttpError(404, 'This upload expired. Start it again.');
  return upload;
}
function view(upload: Upload) {
  const file = upload.status === 'complete' ? fileById(upload.id) : undefined;
  return {
    id: upload.id,
    name: upload.name,
    size: upload.size,
    offset: upload.offset,
    status: upload.status,
    expires: upload.expires,
    chunk_size: CHUNK_SIZE,
    busy: !!upload.lease_token && upload.lease_until > Date.now(),
    file: file
      ? {
          id: file.id,
          name: file.name,
          size: file.size,
          folder_id: file.folder_id,
          checksum: file.checksum,
        }
      : undefined,
  };
}
export async function beginUpload(value: Record<string, unknown>, signal?: AbortSignal) {
  const cfg = config();
  if (typeof value.id !== 'string' || !validId(value.id))
    throw new HttpError(400, 'Use a unique UUID for this upload.');
  const id = value.id;
  const name = folderName(value.name);
  if (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0)
    throw new HttpError(400, 'Invalid file size.');
  const size = value.size;
  if (size > cfg.maxFile) throw new HttpError(413, 'The file exceeds the upload limit.');
  const destination = parentId(value.folder_id);
  if (value.relative_path !== undefined && typeof value.relative_path !== 'string')
    throw new HttpError(400, 'Invalid relative path.');
  const parts = relativeParts((value.relative_path as string | undefined) || null);
  if (parts.length && parts.at(-1) !== name)
    throw new HttpError(400, 'The relative path must end with the uploaded filename.');
  const relative = parts.join('/');
  const mime =
    typeof value.mime_type === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value.mime_type)
      ? value.mime_type
      : 'application/octet-stream';
  await cleanup();
  const free = await diskFree();
  if (signal?.aborted)
    throw new HttpError(408, 'Upload creation was interrupted. Retry its status.');
  const upload = transaction(() => {
    if (
      db()
        .prepare('SELECT 1 FROM upload_cancellations WHERE id=? AND expires>=?')
        .get(id, Date.now())
    )
      throw new HttpError(
        410,
        'This upload was cancelled. Select the file again with a new upload ID.',
      );
    const existing = db().prepare('SELECT * FROM uploads WHERE id = ?').get(id) as unknown as
      Upload | undefined;
    if (existing) {
      if (existing.status === 'cleaning')
        throw new HttpError(409, 'Expired upload data is being removed. Retry shortly.');
      if (
        existing.name !== name ||
        existing.size !== size ||
        existing.mime_type !== mime ||
        existing.destination !== destination ||
        existing.relative_path !== relative
      )
        throw new HttpError(409, 'This upload ID belongs to a different file.');
      return existing;
    }
    if (fileById(id)) throw new HttpError(409, 'This file ID is already in use.');
    if (trail(destination).length + Math.max(0, parts.length - 1) > 32)
      throw new HttpError(400, 'Folders can be nested up to 32 levels.');
    if (
      (
        db().prepare("SELECT COUNT(*) AS n FROM uploads WHERE status != 'complete'").get() as {
          n: number;
        }
      ).n >= 100
    )
      throw new HttpError(429, 'Too many unfinished uploads. Cancel an old upload or try later.');
    if (size > cfg.quota - totals().used - reserved())
      throw new HttpError(507, 'Your storage is full. Delete files before uploading more.');
    if (size > free - cfg.reserve - diskReserved())
      throw new HttpError(507, 'Uploads are paused because the server needs more free disk space.');
    const created_at = new Date().toISOString();
    const expires = Date.now() + TTL;
    db()
      .prepare(
        'INSERT INTO uploads(id,name,size,mime_type,destination,relative_path,expires,created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(id, name, size, mime, destination, relative, expires, created_at);
    db()
      .prepare('INSERT INTO reservations(id,bytes,expires) VALUES (?,?,?)')
      .run(id, size, expires);
    return row(id);
  });
  // Creation is idempotent, including a retry after a lost response. Only the
  // chunk's lease holder opens/truncates the staging file.
  return view(upload);
}
export function uploadStatus(id: string) {
  const file = fileById(id);
  if (file)
    return {
      id,
      name: file.name,
      size: file.size,
      offset: file.size,
      status: 'complete',
      expires: null,
      chunk_size: CHUNK_SIZE,
      busy: false,
      file: {
        id: file.id,
        name: file.name,
        size: file.size,
        folder_id: file.folder_id,
        checksum: file.checksum,
      },
    };
  return view(row(id));
}
function acquire(id: string, finishing = false) {
  return transaction(() => {
    const upload = row(id);
    if (upload.status === 'complete') return { upload, token: '' };
    if (upload.lease_token && upload.lease_until > Date.now())
      throw new HttpError(409, 'Another request is working on this upload. Retry shortly.');
    if (finishing && upload.offset !== upload.size)
      throw new HttpError(409, 'Upload all file bytes before finishing.');
    const token = randomUUID();
    const expires = Date.now() + TTL;
    db()
      .prepare('UPDATE uploads SET lease_token=?,lease_until=?,expires=?,status=? WHERE id=?')
      .run(token, Date.now() + LEASE, expires, finishing ? 'finalizing' : upload.status, id);
    db().prepare('UPDATE reservations SET expires=? WHERE id=?').run(expires, id);
    return { upload, token };
  });
}
function owns(id: string, token: string) {
  return db().prepare('SELECT 1 FROM uploads WHERE id=? AND lease_token=?').get(id, token);
}
function release(id: string, token: string) {
  db()
    .prepare('UPDATE uploads SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?')
    .run(id, token);
}
function heartbeat(id: string, token: string, controller: AbortController) {
  const timer = setInterval(() => {
    try {
      if (
        !db()
          .prepare('UPDATE uploads SET lease_until=? WHERE id=? AND lease_token=?')
          .run(Date.now() + LEASE, id, token).changes
      )
        controller.abort();
    } catch {
      controller.abort();
    }
  }, 20_000);
  timer.unref();
  return timer;
}
export async function uploadChunk(req: Request, id: string) {
  if (req.headers.get('content-type')?.split(';')[0] !== 'application/octet-stream' || !req.body)
    throw new HttpError(415, 'Send binary bytes with Content-Type: application/octet-stream.');
  const value = req.headers.get('upload-offset');
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new HttpError(400, 'Send the confirmed Upload-Offset.');
  if (Number(req.headers.get('content-length') || 0) > CHUNK_SIZE)
    throw new HttpError(413, 'Upload chunks up to 4 MiB.');
  const { upload, token } = acquire(id);
  if (!token) throw new HttpError(409, 'This upload is already complete.');
  const controller = new AbortController();
  const signal = AbortSignal.any([req.signal, controller.signal]);
  const timer = heartbeat(id, token, controller);
  const deadline = setTimeout(() => controller.abort(), 120_000);
  let received = 0;
  try {
    if (Number(value) !== upload.offset)
      throw new HttpError(409, 'The upload position changed. Fetch its status and resume.');
    if (upload.status === 'finalizing') throw new HttpError(409, 'This file is ready to finish.');
    let handle;
    try {
      handle = await open(temporary(id), 'r+');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (upload.offset !== 0)
        throw new HttpError(409, 'Partial upload data is missing. Cancel and start again.');
      handle = await open(temporary(id), 'wx', 0o600);
    }
    try {
      await handle.truncate(upload.offset);
    } finally {
      await handle.close();
    }
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        done(
          received > CHUNK_SIZE || received > upload.size - upload.offset
            ? new HttpError(413, 'This chunk exceeds the remaining file size or 4 MiB limit.')
            : null,
          chunk,
        );
      },
    });
    await pipeline(
      Readable.fromWeb(req.body as import('node:stream/web').ReadableStream),
      meter,
      createWriteStream(temporary(id), { flags: 'r+', start: upload.offset }),
      { signal },
    );
    if (!received) throw new HttpError(400, 'Send a non-empty chunk.');
    if ((await diskFree()) < config().reserve)
      throw new HttpError(507, 'The server needs more free disk space.');
    const flush = await open(temporary(id), 'r+');
    try {
      await flush.sync();
    } finally {
      await flush.close();
    }
    transaction(() => {
      if (!owns(id, token)) throw new HttpError(409, 'This upload moved to another request.');
      const expires = Date.now() + TTL;
      db()
        .prepare('UPDATE uploads SET offset=?,expires=? WHERE id=? AND lease_token=?')
        .run(upload.offset + received, expires, id, token);
      db().prepare('UPDATE reservations SET expires=? WHERE id=?').run(expires, id);
    });
    return view(row(id));
  } catch (error) {
    if (owns(id, token)) await truncate(temporary(id), upload.offset).catch(() => {});
    if (error instanceof HttpError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC')
      throw new HttpError(507, 'The server disk is full.');
    if (signal.aborted || (error as Error).name === 'AbortError')
      throw new HttpError(408, 'Chunk interrupted. Resume from the last confirmed position.');
    throw error;
  } finally {
    clearInterval(timer);
    clearTimeout(deadline);
    release(id, token);
  }
}
export async function finishUpload(req: Request, id: string) {
  const { upload, token } = acquire(id, true);
  if (!token) return view(upload);
  const controller = new AbortController();
  const signal = AbortSignal.any([req.signal, controller.signal]);
  const timer = heartbeat(id, token, controller);
  try {
    let source = temporary(id);
    try {
      await stat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      source = filePath(id);
      try {
        await stat(source);
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
        if (upload.size !== 0)
          throw new HttpError(409, 'Partial upload data is missing. Cancel and start again.');
        source = temporary(id);
        const empty = await open(source, 'wx', 0o600);
        await empty.close();
      }
    }
    const info = await stat(source);
    if (!info.isFile() || info.size !== upload.size)
      throw new HttpError(409, 'Partial upload data changed. Cancel and start again.');
    const checksum = createHash('sha256');
    for await (const bytes of createReadStream(source, { signal })) checksum.update(bytes);
    const flush = await open(source, 'r+');
    try {
      await flush.sync();
    } finally {
      await flush.close();
    }
    if (source !== filePath(id)) await rename(source, filePath(id));
    const directory = await open(path.dirname(filePath(id)), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const digest = checksum.digest('hex');
    transaction(() => {
      if (!owns(id, token)) throw new HttpError(409, 'This upload moved to another request.');
      const folder = ensurePath(
        upload.destination,
        relativeParts(upload.relative_path).slice(0, -1),
      );
      db()
        .prepare(
          'INSERT INTO files(id,name,size,mime_type,kind,checksum,created_at,folder_id) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          upload.name,
          upload.size,
          upload.mime_type,
          kindOf(upload.name),
          digest,
          upload.created_at,
          folder,
        );
      db()
        .prepare(
          "UPDATE uploads SET status='complete',lease_token=NULL,lease_until=0,expires=? WHERE id=?",
        )
        .run(Date.now() + 7 * TTL, id);
      db().prepare('DELETE FROM reservations WHERE id=?').run(id);
    });
    return view(row(id));
  } finally {
    clearInterval(timer);
    release(id, token);
  }
}
export async function cancelUpload(id: string) {
  if (fileById(id)) return { success: true, complete: true };
  // A cancellation also fences a create request whose response/body was lost.
  // Keep the ID briefly so that a late POST cannot reserve abandoned bytes.
  const remember = () =>
    db()
      .prepare(
        'INSERT INTO upload_cancellations(id,expires) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires',
      )
      .run(id, Date.now() + TTL);
  let upload: Upload;
  try {
    upload = row(id);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) remember();
    throw error;
  }
  if (upload.status === 'complete') return { success: true, complete: true };
  const { token } = acquire(id);
  remember();
  try {
    await rm(temporary(id), { force: true });
    if (!fileById(id)) await rm(filePath(id), { force: true });
    transaction(() => {
      if (!owns(id, token)) throw new HttpError(409, 'This upload moved to another request.');
      db().prepare('DELETE FROM uploads WHERE id=?').run(id);
      db().prepare('DELETE FROM reservations WHERE id=?').run(id);
    });
    return { success: true };
  } finally {
    release(id, token);
  }
}
