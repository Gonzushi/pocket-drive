import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rename, rm, statfs } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import { config } from './config';
import { db, transaction, type StoredFile } from './db';
import { HttpError } from './http';
import { ensurePath, parentId, relativeParts, trail } from './folders';

export const validId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
export const filePath = (id: string) => {
  if (!validId(id)) throw new HttpError(404, 'File not found.');
  return path.join(config().storagePath, 'files', id);
};
export function totals() {
  return db().prepare('SELECT COALESCE(SUM(size), 0) AS used, COUNT(*) AS count FROM files').get() as { used: number; count: number };
}
export function reserved() { return (db().prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM reservations').get() as { bytes: number }).bytes; }
export function diskReserved() { const staged = (db().prepare("SELECT COALESCE(SUM(offset), 0) AS bytes FROM uploads WHERE status != 'complete'").get() as { bytes: number }).bytes; return Math.max(0, reserved() - staged); }
export async function diskFree() { const fs = await statfs(config().storagePath); return fs.bavail * fs.bsize; }

export async function cleanup() {
  db();
  const expired = transaction(() => {
    const now = Date.now();
    db().prepare('DELETE FROM upload_cancellations WHERE expires < ?').run(now);
    const rows = db().prepare(`SELECT r.id, u.id AS upload_id FROM reservations r LEFT JOIN uploads u ON u.id=r.id WHERE r.expires < ? AND (u.id IS NULL OR u.lease_until < ?)
      UNION SELECT id, id AS upload_id FROM uploads WHERE expires < ? AND status != 'complete' AND lease_until < ?`).all(now,now,now,now) as { id: string; upload_id: string | null }[];
    // Keep an expired session's ID reserved until its bytes have been removed.
    // A second worker must not delete a newly restarted upload with the same ID.
    const claimed = rows.map(row => {
      const token = row.upload_id ? randomUUID() : '';
      if (token) db().prepare("UPDATE uploads SET status='cleaning',lease_token=?,lease_until=? WHERE id=?").run(token,now+90_000,row.id);
      db().prepare('DELETE FROM reservations WHERE id=?').run(row.id);
      return {id:row.id,token};
    });
    db().prepare("DELETE FROM uploads WHERE expires < ? AND status='complete'").run(now);
    return claimed;
  });
  for (const row of expired) {
    try {
      await rm(path.join(config().storagePath, 'tmp', row.id), { force: true });
      // A crash between rename and metadata commit can leave an unregistered file.
      if (!db().prepare('SELECT 1 FROM files WHERE id = ?').get(row.id)) await rm(filePath(row.id), { force: true });
      if (row.token) db().prepare("DELETE FROM uploads WHERE id=? AND lease_token=? AND status='cleaning'").run(row.id,row.token);
    } catch (error) {
      if (row.token) db().prepare('UPDATE uploads SET lease_until=0 WHERE id=? AND lease_token=?').run(row.id,row.token);
      throw error;
    }
  }
  const deleting = db().prepare('SELECT id FROM files WHERE deleting = 1').all() as { id: string }[];
  for (const row of deleting) {
    await import('./preview-cache').then(module => module.removePrepared(row.id));
    await rm(filePath(row.id), { force: true });
    db().prepare('DELETE FROM files WHERE id = ? AND deleting = 1').run(row.id);
  }
  db().prepare('DELETE FROM folders WHERE deleting = 1').run();
}
export async function storageInfo() {
  await cleanup();
  const cfg = config(); const free = await diskFree();
  const { used, count } = totals(); const pending = reserved();
  return {
    used_bytes: used, quota_bytes: cfg.quota, reserved_bytes: pending, file_count: count,
    available_bytes: Math.max(0, Math.min(cfg.quota - used - pending, free - cfg.reserve - diskReserved())),
    disk_free_bytes: free, min_free_disk_bytes: cfg.reserve, max_file_bytes: cfg.maxFile
  };
}
export function kindOf(name: string) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'avif', 'bmp', 'tiff'].includes(ext)) return 'image';
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'tsv', 'xls', 'xlsx', 'ppt', 'pptx', 'json', 'sql', 'scala', 'py', 'ipynb'].includes(ext)) return 'document';
  return 'other';
}
export async function upload(req: Request) {
  const cfg = config();
  const params = new URL(req.url).searchParams;
  const destination = parentId(params.get('folder_id'));
  const parts = relativeParts(params.get('relative_path'));
  if (trail(destination).length + Math.max(0, parts.length - 1) > 32) throw new HttpError(400, 'Folders can be nested up to 32 levels.');
  if (!req.body || !req.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')) throw new HttpError(415, 'Upload a multipart/form-data request with one file field named file.');
  if (Number(req.headers.get('content-length') || 0) > cfg.maxFile + 65536) throw new HttpError(413, 'The file exceeds the upload limit.');
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({ headers: Object.fromEntries(req.headers), defParamCharset: 'utf8', limits: { fileSize: cfg.maxFile + 1, files: 1, fields: 0, parts: 2, headerPairs: 50 }, highWaterMark: 65536 });
  } catch { throw new HttpError(400, 'Invalid multipart upload.'); }
  await cleanup();
  const free = await diskFree(); const id = randomUUID();
  const budget = transaction(() => {
    const remaining = cfg.quota - totals().used - reserved();
    const diskRemaining = free - cfg.reserve - diskReserved();
    if (remaining <= 0) throw new HttpError(507, 'Your storage is full. Delete files before uploading more.');
    if (diskRemaining <= 0) throw new HttpError(507, 'Uploads are paused because the server needs more free disk space.');
    const bytes = Math.floor(Math.min(cfg.maxFile, remaining, diskRemaining));
    db().prepare('INSERT INTO reservations(id, bytes, expires) VALUES (?, ?, ?)').run(id, bytes, Date.now() + 60 * 60_000);
    return bytes;
  });
  const temporary = path.join(cfg.storagePath, 'tmp', id);
  const controller = new AbortController();
  let failure: Error | undefined;
  const fail = (error: Error) => { failure ??= error; controller.abort(); };
  const timer = setTimeout(() => fail(new HttpError(408, 'Upload timed out after 15 minutes. Try again.')), 15 * 60_000);
  const onAbort = () => fail(new HttpError(400, 'Upload was cancelled.'));
  req.signal.addEventListener('abort', onAbort, { once: true });
  if (req.signal.aborted) onAbort();
  let name = ''; let mime = ''; let size = 0; let hasFile = false;
  let fileDone: Promise<void> = Promise.resolve(); let moved = false;
  const checksum = createHash('sha256');
  parser.on('file', (field, stream, info) => {
    if (hasFile || field !== 'file') { stream.resume(); fail(new HttpError(400, 'Use one file field named file.')); return; }
    hasFile = true;
    name = info.filename?.replace(/\\/g, '/').split('/').pop()?.replace(/[\x00-\x1f\x7f]/g, '').normalize('NFC').trim() || '';
    if (!name || Buffer.byteLength(name) > 255) { stream.resume(); fail(new HttpError(400, 'Use a filename between 1 and 255 bytes.')); return; }
    mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(info.mimeType) ? info.mimeType : 'application/octet-stream';
    stream.on('limit', () => fail(new HttpError(413, 'The file exceeds the upload limit.')));
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > cfg.maxFile) { callback(new HttpError(413, 'The file exceeds the upload limit.')); return; }
      if (size > budget) { callback(new HttpError(507, 'This file needs more space than is currently available.')); return; }
      checksum.update(chunk); callback(null, chunk);
    } });
    fileDone = pipeline(stream, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: controller.signal }).catch(error => { fail(error); });
  });
  parser.on('filesLimit', () => fail(new HttpError(400, 'Upload one file at a time.')));
  parser.on('fieldsLimit', () => fail(new HttpError(400, 'Only the file field is supported.')));
  parser.on('partsLimit', () => fail(new HttpError(400, 'Upload exactly one file field.')));
  let received = 0;
  const requestMeter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    received += chunk.length;
    callback(received > cfg.maxFile + 65536 ? new HttpError(413, 'Upload request is too large.') : null, chunk);
  } });
  try {
    try { await pipeline(Readable.fromWeb(req.body as import('node:stream/web').ReadableStream), requestMeter, parser, { signal: controller.signal }); }
    catch (error) { fail(error as Error); }
    await fileDone;
    if (failure) throw failure;
    if (!hasFile || !name) throw new HttpError(400, 'No file found. Use the file field.');
    if (parts.length && parts[parts.length - 1] !== name) throw new HttpError(400, 'The relative path must end with the uploaded filename.');
    if (await diskFree() < cfg.reserve) throw new HttpError(507, 'The server needs more free disk space. Try again later.');
    // Flush file contents before persisting the metadata pointer.
    const handle = await open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, filePath(id)); moved = true;
    const dir = await open(path.join(cfg.storagePath, 'files'), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    const file = { id, name, size, mime_type: mime, kind: kindOf(name), checksum: checksum.digest('hex'), created_at: new Date().toISOString(), folder_id: destination };
    transaction(() => {
      file.folder_id = ensurePath(destination, parts.slice(0, -1));
      db().prepare('INSERT INTO files(id, name, size, mime_type, kind, checksum, created_at, folder_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(file.id, file.name, file.size, file.mime_type, file.kind, file.checksum, file.created_at, file.folder_id);
      db().prepare('DELETE FROM reservations WHERE id = ?').run(id);
    });
    return { ...file, download_url: `${cfg.origin}/api/files/${id}/download` };
  } catch (error) {
    await fileDone;
    await rm(temporary, { force: true });
    if (moved) await rm(filePath(id), { force: true });
    db().prepare('DELETE FROM reservations WHERE id = ?').run(id);
    if (error instanceof HttpError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw new HttpError(507, 'The server disk is full.');
    if ((error as Error).message?.includes('Unexpected end') || (error as Error).name === 'AbortError') throw new HttpError(400, 'Upload was interrupted or malformed. Try again.');
    throw error;
  } finally {
    clearTimeout(timer); req.signal.removeEventListener('abort', onAbort);
  }
}
export async function deleteFile(id: string) {
  db().prepare('UPDATE files SET deleting = 1 WHERE id = ?').run(id);
  await import('./preview-cache').then(module => module.removePrepared(id));
  await rm(filePath(id), { force: true });
  db().prepare('DELETE FROM files WHERE id = ? AND deleting = 1').run(id);
}
export async function download(req: Request, file: StoredFile, preview?: { mime: string; inline: boolean; path?: string; etag?: string }) {
  let start = 0; let end = file.size - 1; let status = 200;
  const range = req.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const invalid = () => new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}`, 'Cache-Control': 'no-store' } });
    if (!match || (!match[1] && !match[2]) || file.size === 0) return invalid();
    if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalid(); start = Math.max(0, file.size - suffix); }
    else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), file.size - 1); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.size) return invalid();
    status = 206;
  }
  let handle;
  try { handle = await open(preview?.path || filePath(file.id), 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'This file is missing from disk. Restore it from a backup.'); throw error; }
  const headers = new Headers({
    'Content-Type': preview?.mime || 'application/octet-stream', 'Content-Length': String(file.size ? end - start + 1 : 0),
    'Content-Disposition': `${preview?.inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`,
    'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'
  });
  if (status === 206) headers.set('Content-Range', `bytes ${start}-${end}/${file.size}`);
  if (preview?.etag) headers.set('ETag', `"${preview.etag}"`);
  if (req.method === 'HEAD' || !file.size) { await handle.close(); return new Response(null, { status, headers }); }
  const stream = handle.createReadStream({ start, end, autoClose: true });
  const abort = () => stream.destroy(); req.signal.addEventListener('abort', abort, { once: true });
  stream.once('close', () => req.signal.removeEventListener('abort', abort));
  if (req.signal.aborted) stream.destroy();
  return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers });
}
