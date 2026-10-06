import { randomUUID, createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { db, fileById, transaction } from '../db';
import { folderName, parentId, folderById } from '../folders';
import { HttpError } from '../http';
import { previewType } from '../../shared/preview-kind';
import { diskFree, diskReserved, reserved, totals, kindOf } from '../storage';
import { runById, type Run } from './store';

export const ASSISTANT_FILE_BYTES = 96 * 1024;

// Immutable blobs make a file edit a single SQLite pointer update. A crash cannot
// replace the bytes of the current version before its metadata is committed.
export async function writeAssistantFile(
  run: Run,
  args: Record<string, unknown>,
  editing: boolean,
) {
  const cfg = config();
  db();
  const current = editing && typeof args.file_id === 'string' ? fileById(args.file_id) : undefined;
  if (editing && !current) throw new HttpError(404, 'File not found.');
  const name = current?.name || folderName(args.name);
  if (!['text', 'markdown', 'table'].includes(previewType(name).kind))
    throw new HttpError(
      415,
      'Create or edit text, code, Markdown, CSV or TSV files. Binary documents need their own editor.',
    );
  if (typeof args.content !== 'string' || args.content.includes('\0'))
    throw new HttpError(400, 'Supply text contents without null bytes.');
  const bytes = Buffer.from(args.content, 'utf8');
  if (bytes.length > Math.min(ASSISTANT_FILE_BYTES, cfg.maxFile))
    throw new HttpError(413, 'Assistant file writes are limited to 96 KiB.');
  if (
    current &&
    (typeof args.expected_checksum !== 'string' || current.checksum !== args.expected_checksum)
  )
    throw new HttpError(409, 'The file changed. Read it again before editing.');
  const folder = current ? current.folder_id : parentId(args.folder_id);
  if (folder) folderById(folder);
  function check() {
    const active = runById(run.id);
    if (active.status !== 'running' || !active.organize)
      throw new HttpError(403, 'File changes are not permitted for this reply.');
    if (current) {
      const latest = fileById(current.id);
      if (
        !latest ||
        latest.checksum !== current.checksum ||
        latest.name !== current.name ||
        latest.folder_id !== current.folder_id
      )
        throw new HttpError(409, 'The file changed. Read it again before editing.');
      if (
        Number(
          db().prepare('SELECT COUNT(*) AS n FROM file_revisions WHERE file_id=?').get(current.id)!
            .n,
        ) >= 100
      )
        throw new HttpError(409, 'This file has reached its 100-revision limit.');
    } else if (
      db()
        .prepare('SELECT 1 FROM files WHERE folder_id IS ? AND name=? COLLATE NOCASE')
        .get(folder, name)
    )
      throw new HttpError(
        409,
        'A file with this name already exists. Read it and use edit_file, or choose a different name.',
      );
    if (folder) folderById(folder);
    if (totals().used - (current?.size || 0) + bytes.length + reserved() > cfg.quota)
      throw new HttpError(507, 'The drive quota is full.');
  }
  const free = await diskFree();
  if (free - diskReserved() - bytes.length < cfg.reserve)
    throw new HttpError(507, 'The server needs more free disk space.');
  const blob = randomUUID();
  transaction(() => {
    check();
    if (free - diskReserved() - bytes.length < cfg.reserve)
      throw new HttpError(507, 'The server needs more free disk space.');
    db()
      .prepare('INSERT INTO reservations VALUES(?,?,?)')
      .run(blob, bytes.length, Date.now() + 90000);
  });
  const target = path.join(cfg.storagePath, 'files', blob);
  let committed = false;
  try {
    const handle = await open(target, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await open(path.dirname(target), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const remaining = await diskFree();
    if (remaining < cfg.reserve) throw new HttpError(507, 'The server needs more free disk space.');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const id = current?.id || blob;
    transaction(() => {
      // Our reservation is already included in the quota sum above.
      db().prepare('DELETE FROM reservations WHERE id=?').run(blob);
      check();
      if (remaining - diskReserved() < cfg.reserve)
        throw new HttpError(507, 'The server needs more free disk space.');
      if (current) {
        const old = db().prepare('SELECT blob_id FROM files WHERE id=?').get(id)!;
        db()
          .prepare('INSERT INTO file_revisions VALUES(?,?,?,?,?,?,?)')
          .run(
            randomUUID(),
            id,
            String(old.blob_id || id),
            current.name,
            current.size,
            current.checksum,
            new Date().toISOString(),
          );
        db()
          .prepare('UPDATE files SET blob_id=?,size=?,checksum=? WHERE id=?')
          .run(blob, bytes.length, checksum, id);
      } else
        db()
          .prepare(
            'INSERT INTO files(id,name,size,mime_type,kind,checksum,created_at,folder_id,blob_id) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            name,
            bytes.length,
            'text/plain; charset=utf-8',
            kindOf(name),
            checksum,
            new Date().toISOString(),
            folder,
            blob,
          );
    });
    committed = true;
    return { file: fileById(id)!, previous_version_retained: Boolean(current) };
  } finally {
    if (!committed) {
      await rm(target, { force: true });
      db().prepare('DELETE FROM reservations WHERE id=?').run(blob);
    }
  }
}
