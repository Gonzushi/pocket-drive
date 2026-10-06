import { open } from 'node:fs/promises';
import type { StoredFile } from './db';
import { download, filePath } from './storage';
import { HttpError, json } from './http';
import { PREVIEW_TEXT_BYTES, previewLimit, previewType } from '../shared/preview-kind';

async function prefix(file: StoredFile, count: number) {
  let handle;
  try {
    handle = await open(filePath(file.id, file.blob_id ?? null), 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new HttpError(404, 'This file is missing from storage.');
    throw error;
  }
  try {
    const bytes = Buffer.alloc(Math.min(file.size, count));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
function validSignature(mime: string, bytes: Buffer) {
  const start = bytes.toString('latin1');
  if (mime === 'application/pdf') return start.startsWith('%PDF-');
  if (mime === 'image/png')
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/gif') return /^GIF8[79]a/.test(start);
  if (mime === 'image/webp') return start.startsWith('RIFF') && start.slice(8, 12) === 'WEBP';
  if (mime === 'image/bmp') return start.startsWith('BM');
  if (mime === 'image/avif')
    return start.slice(4, 8) === 'ftyp' && /avif|avis/.test(start.slice(8, 64));
  if (mime.includes('mp4') || mime === 'video/quicktime') return start.slice(4, 8) === 'ftyp';
  if (mime === 'video/webm') return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  if (mime.includes('ogg')) return start.startsWith('OggS');
  if (mime === 'audio/flac') return start.startsWith('fLaC');
  if (mime === 'audio/wav') return start.startsWith('RIFF') && start.slice(8, 12) === 'WAVE';
  if (mime === 'audio/mpeg')
    return start.startsWith('ID3') || (bytes[0] === 255 && (bytes[1] & 224) === 224);
  return false;
}
function ensureLimit(file: StoredFile) {
  const type = previewType(file.name);
  if (file.size > previewLimit(type.kind))
    throw new HttpError(
      413,
      'This file is too large for an in-browser preview. Download it to open locally.',
    );
  return type;
}
export function previewInfo(file: StoredFile) {
  const { kind, extension } = previewType(file.name);
  return json({
    kind,
    extension,
    supported: kind !== 'unsupported' && file.size <= previewLimit(kind),
    reason:
      file.size > previewLimit(kind)
        ? 'This file is too large for an in-browser preview.'
        : kind === 'unsupported'
          ? 'A preview is not available for this format yet.'
          : null,
    text_limit_bytes: PREVIEW_TEXT_BYTES,
  });
}
export async function previewContent(req: Request, file: StoredFile) {
  const type = ensureLimit(file);
  if (!['image', 'pdf', 'audio', 'video', 'workbook'].includes(type.kind))
    throw new HttpError(415, 'This format has no inline content preview.');
  if (type.kind === 'workbook') await archiveEntries(req, file, true);
  else if (!validSignature(type.mime, await prefix(file, 64)))
    throw new HttpError(
      415,
      'The file content does not match its extension, or is damaged. Download it to inspect locally.',
    );
  return download(req, file, { mime: type.mime, inline: true });
}
export async function previewText(file: StoredFile) {
  const { kind } = previewType(file.name);
  if (!['text', 'markdown', 'table'].includes(kind))
    throw new HttpError(415, 'This format is not a text preview.');
  const bytes = await prefix(file, PREVIEW_TEXT_BYTES);
  // UTF-16 is common in exported text. Keep HTML, SVG, and code as inert text.
  const utf16 = (bytes[0] === 255 && bytes[1] === 254) || (bytes[0] === 254 && bytes[1] === 255);
  if (!utf16 && bytes.includes(0))
    throw new HttpError(415, 'This file contains binary data and cannot be previewed as text.');
  const encoding = utf16 ? (bytes[0] === 255 ? 'utf-16le' : 'utf-16be') : 'utf-8';
  const truncated = file.size > bytes.length;
  let text = new TextDecoder(encoding).decode(bytes, { stream: truncated });
  if (truncated) {
    const newline = text.lastIndexOf('\n');
    if (newline >= 0) text = text.slice(0, newline + 1);
  }
  return json({ text, truncated, encoding, limit_bytes: PREVIEW_TEXT_BYTES });
}
export async function archiveEntries(req: Request, file: StoredFile, workbook = false) {
  const yauzl = await import('yauzl');
  return new Promise<{
    entries: { name: string; size: number; directory: boolean; encrypted: boolean }[];
    truncated: boolean;
    total: number;
  }>((resolve, reject) => {
    yauzl.open(
      filePath(file.id, file.blob_id ?? null),
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new HttpError(422, 'This archive is damaged or cannot be read.'));
          return;
        }
        let settled = false;
        let totalBytes = 0;
        const entries: { name: string; size: number; directory: boolean; encrypted: boolean }[] =
          [];
        const limit = 1000;
        const finish = (error?: Error, truncated = false) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.signal.removeEventListener('abort', abort);
          zip.close();
          if (error) reject(error);
          else resolve({ entries, truncated, total: zip.entryCount });
        };
        const abort = () => finish(new HttpError(499, 'Preview cancelled.'));
        const timer = setTimeout(
          () =>
            finish(
              new HttpError(
                422,
                'Archive preview took too long. Download the file to open locally.',
              ),
            ),
          10000,
        );
        req.signal.addEventListener('abort', abort, { once: true });
        if (req.signal.aborted) {
          abort();
          return;
        }
        zip.on('error', () =>
          finish(new HttpError(422, 'This archive is damaged or cannot be read.')),
        );
        zip.on('end', () => {
          if (workbook && !entries.some((entry) => entry.name === 'xl/workbook.xml'))
            finish(new HttpError(422, 'This file is not a valid XLSX workbook.'));
          else finish();
        });
        zip.on('entry', (entry) => {
          if (entries.length >= limit) {
            finish(
              workbook ? new HttpError(413, 'This workbook is too complex to preview.') : undefined,
              true,
            );
            return;
          }
          const encrypted = !!(entry.generalPurposeBitFlag & 1);
          entries.push({
            name: entry.fileName,
            size: entry.uncompressedSize,
            directory: entry.fileName.endsWith('/'),
            encrypted,
          });
          if (!workbook) {
            zip.readEntry();
            return;
          }
          if (
            encrypted ||
            entry.uncompressedSize > 16 * 1024 * 1024 ||
            entry.fileName.endsWith('vbaProject.bin')
          ) {
            finish(
              new HttpError(
                415,
                'Encrypted, macro-enabled, or very large workbooks cannot be previewed.',
              ),
            );
            return;
          }
          zip.openReadStream(entry, (error, stream) => {
            if (settled) {
              stream?.destroy();
              return;
            }
            if (error || !stream) {
              finish(new HttpError(422, 'The workbook could not be read.'));
              return;
            }
            let entryBytes = 0;
            stream.on('data', (chunk) => {
              entryBytes += chunk.length;
              totalBytes += chunk.length;
              if (totalBytes > 32 * 1024 * 1024 || entryBytes > 16 * 1024 * 1024) {
                stream.destroy();
                finish(new HttpError(413, 'This workbook expands beyond the preview limit.'));
              }
            });
            stream.on('error', () => finish(new HttpError(422, 'The workbook is damaged.')));
            stream.on('end', () => {
              if (!settled) zip.readEntry();
            });
            const stopStream = () => stream.destroy();
            zip.once('close', stopStream);
            stream.once('close', () => zip.removeListener('close', stopStream));
          });
        });
        zip.readEntry();
      },
    );
  });
}
