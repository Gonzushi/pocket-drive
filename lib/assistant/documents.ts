import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileById, transaction, type StoredFile } from '../db';
import { filePath } from '../storage';
import { previewType } from '../preview-kind';
import { archiveEntries, previewText } from '../preview';
import { preparedDocumentPath, preparedStatus } from '../preview-cache';
import { HttpError } from '../http';
import { assistantDB } from './store';

export interface Section { label: string; text: string }
interface Document { sections: Section[]; limited: boolean; error?: string | null }
const pending = new Map<string, Promise<Document>>(); let indexing = false;
export const fingerprint = (file: StoredFile) => file.checksum + ':' + previewType(file.name).extension;
function cached(file: StoredFile): Document | null {
  const row = assistantDB().prepare('SELECT * FROM assistant_documents WHERE file_id=? AND fingerprint=?').get(file.id, fingerprint(file));
  return row ? { sections: JSON.parse(String(row.sections)), limited: Boolean(row.limited), error: row.error ? String(row.error) : null } : null;
}
function extract(kind: string, file: string, extension: string, text?: string): Promise<Document> {
  return new Promise((resolve, reject) => {
    const child = spawn('prlimit', ['--cpu=45', '--fsize=4194304', '--', process.execPath, '--max-old-space-size=192', path.join(process.cwd(), 'scripts/extract-document.ts')], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C.UTF-8', NODE_ENV: 'production', PDFTOTEXT_BIN: process.env.PDFTOTEXT_BIN } });
    let output = ''; let size = 0; let settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); try { process.kill(-child.pid!, 'SIGKILL'); } catch {} if (error) reject(error); else { try { resolve(JSON.parse(output)); } catch { reject(new Error('Document extraction failed.')); } } };
    const timer = setTimeout(() => finish(new Error('Document extraction exceeded its time limit.')), 45000);
    child.on('error', () => finish(new Error('Document reader is unavailable. Check the deployment image.')));
    child.stdin.on('error', () => {}); child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) finish(new Error('Document exceeds the extraction limit.')); else output += chunk.toString(); });
    child.on('close', code => finish(code === 0 ? undefined : new Error('Document is damaged or could not be extracted.')));
    child.stdin.end(JSON.stringify({ kind, file, extension, text }));
  });
}
async function parse(file: StoredFile): Promise<Document> {
  const { kind, extension } = previewType(file.name);
  if (['text', 'markdown', 'table'].includes(kind)) {
    const data = await (await previewText(file)).json() as { text: string; truncated: boolean };
    if (kind === 'table') { const document = await extract('table', filePath(file.id), extension, data.text); return { ...document, limited: document.limited || data.truncated }; }
    const lines = data.text.split('\n'); const sections: Section[] = [];
    for (let offset = 0; offset < lines.length && sections.length < 256; offset += 80) sections.push({ label: 'Lines ' + (offset + 1) + '–' + Math.min(offset + 80, lines.length), text: lines.slice(offset, offset + 80).join('\n') });
    return { sections, limited: data.truncated || lines.length > 256 * 80 };
  }
  if (kind === 'pdf') {
    if (file.size > 100 * 1024 * 1024) throw new HttpError(413, 'PDF reading is limited to 100 MB.');
    return extract('pdf', filePath(file.id), extension);
  }
  if (kind === 'workbook') {
    if (file.size > 10 * 1024 * 1024) throw new HttpError(413, 'Spreadsheet reading is limited to 10 MB.');
    await archiveEntries(new Request('http://localhost'), file, true);
    return extract('workbook', filePath(file.id), extension);
  }
  if (kind === 'office') {
    const started = Date.now();
    while (Date.now() - started < 70000) {
      const status = await preparedStatus(file, 'document', true);
      if (status.status === 'failed') throw new Error(status.error || 'Document conversion failed.');
      if (status.status === 'ready') return extract('pdf', await preparedDocumentPath(file), extension);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Document preparation is still in progress. Try again shortly.');
  }
  throw new HttpError(415, 'Content reading is supported for text, code, Markdown, PDF, Office documents, CSV, TSV and XLSX. Image OCR and media transcription are not available yet.');
}
async function save(file: StoredFile): Promise<Document> {
  let document: Document;
  try { document = await parse(file); } catch (error) { document = { sections: [], limited: false, error: (error as Error).message }; }
  const current = fileById(file.id);
  if (!current || fingerprint(current) !== fingerprint(file)) throw new HttpError(409, 'The file changed or was deleted. Search again.');
  const database = assistantDB();
  const used = Number(database.prepare('SELECT COALESCE(SUM(length(sections)),0) AS n FROM assistant_documents WHERE file_id!=?').get(file.id)!.n);
  if (used + JSON.stringify(document.sections).length > 128 * 1024 * 1024) return { sections: [], limited: true, error: 'The document index is full (128 MB). Filename search remains available.' };
  transaction(() => {
    database.prepare('DELETE FROM assistant_search WHERE file_id=?').run(file.id);
    database.prepare('INSERT OR REPLACE INTO assistant_documents VALUES(?,?,?,?,?)').run(file.id, fingerprint(file), JSON.stringify(document.sections), Number(document.limited), document.error || null);
    const insert = database.prepare('INSERT INTO assistant_search(file_id,section,text) VALUES(?,?,?)');
    document.sections.forEach((section, index) => insert.run(file.id, index, section.text));
  });
  return document;
}
export async function readDocument(file: StoredFile, retryErrors = false) {
  const document = cached(file); if (document && (!document.error || !retryErrors)) return document;
  const key = file.id + ':' + fingerprint(file);
  if (!pending.has(key)) pending.set(key, save(file).finally(() => pending.delete(key)));
  return pending.get(key)!;
}
export function indexStatus() {
  const database = assistantDB();
  const total = Number(database.prepare('SELECT COUNT(*) AS n FROM files WHERE deleting=0').get()!.n);
  const rows = database.prepare('SELECT f.* FROM assistant_documents d JOIN files f ON f.id=d.file_id WHERE f.deleting=0').all().map(row => cached(row as unknown as StoredFile)).filter((row): row is Document => row !== null);
  return { total, indexed: rows.filter(row => !row.error).length, unreadable: rows.filter(row => row.error).length, limited: rows.filter(row => row.limited).length, pending: Math.max(0, total - rows.length), indexing };
}
export function startIndex() {
  if (indexing) return; indexing = true;
  void (async () => {
    const database = assistantDB();
    database.exec('DELETE FROM assistant_search WHERE file_id NOT IN (SELECT id FROM files WHERE deleting=0); DELETE FROM assistant_documents WHERE file_id NOT IN (SELECT id FROM files WHERE deleting=0);');
    try {
      // One bounded batch per visit; new uploads are picked up on the next status/search.
      const files = database.prepare('SELECT f.* FROM files f LEFT JOIN assistant_documents d ON d.file_id=f.id WHERE f.deleting=0 ORDER BY CASE WHEN d.file_id IS NULL THEN 0 ELSE 1 END,f.created_at DESC').all() as unknown as StoredFile[];
      let count = 0;
      for (const file of files) { if (cached(file)) continue; if (++count > 100) break; await readDocument(file).catch(() => {}); await new Promise(resolve => setTimeout(resolve, 10)); }
    } finally { indexing = false; }
  })().catch(() => { indexing = false; });
}
export function searchContent(query: string) {
  const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 10); if (!terms?.length) return [];
  const expression = terms.map(term => '"' + term + '"').join(' AND ');
  return assistantDB().prepare("SELECT s.file_id,s.section,snippet(assistant_search,2,'','', ' … ',40) AS excerpt FROM assistant_search s JOIN files f ON f.id=s.file_id JOIN assistant_documents d ON d.file_id=s.file_id WHERE assistant_search MATCH ? AND f.deleting=0 ORDER BY rank LIMIT 30").all(expression).filter(row => { const file = fileById(String(row.file_id)); return file && cached(file); });
}
