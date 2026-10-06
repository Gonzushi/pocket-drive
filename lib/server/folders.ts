import { randomUUID } from 'node:crypto';
import { db, transaction } from './db';
import { HttpError } from './http';

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  deleting: number;
}
const isId = (value: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function parentId(value: unknown): string | null {
  if (value === undefined || value === null || value === '' || value === 'root') return null;
  if (typeof value !== 'string' || !isId(value)) throw new HttpError(400, 'Invalid folder.');
  return value;
}
export function folderName(value: unknown) {
  if (typeof value !== 'string') throw new HttpError(400, 'Enter a folder name.');
  const name = value.normalize('NFC').trim();
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    Buffer.byteLength(name) > 255 ||
    /[\\/\x00-\x1f\x7f]/.test(name)
  )
    throw new HttpError(
      400,
      'Use a folder name up to 255 bytes, without slashes or control characters.',
    );
  return name;
}
export function folderById(id: string) {
  const folder = db()
    .prepare('SELECT * FROM folders WHERE id = ? AND deleting = 0')
    .get(id) as unknown as Folder | undefined;
  if (!folder) throw new HttpError(404, 'This folder no longer exists. Return to My files.');
  return folder;
}
export function trail(id: string | null) {
  const folders: Folder[] = [];
  let current = id;
  while (current) {
    if (folders.length >= 32) throw new HttpError(400, 'Folders can be nested up to 32 levels.');
    const folder = folderById(current);
    folders.unshift(folder);
    current = folder.parent_id;
  }
  return folders;
}
function insertFolder(name: string, parent: string | null) {
  if ((db().prepare('SELECT COUNT(*) AS n FROM folders').get() as { n: number }).n >= 10000)
    throw new HttpError(400, 'This drive has reached its 10,000-folder limit.');
  const folder = {
    id: randomUUID(),
    name,
    parent_id: parent,
    created_at: new Date().toISOString(),
  };
  db()
    .prepare('INSERT INTO folders(id, name, parent_id, created_at) VALUES (?, ?, ?, ?)')
    .run(folder.id, folder.name, folder.parent_id, folder.created_at);
  return folder;
}
export function createFolder(value: unknown, parent: string | null) {
  const name = folderName(value);
  return transaction(() => {
    if (trail(parent).length >= 32)
      throw new HttpError(400, 'Folders can be nested up to 32 levels.');
    if (
      db()
        .prepare('SELECT 1 FROM folders WHERE parent_id IS ? AND name = ? COLLATE NOCASE')
        .get(parent, name)
    )
      throw new HttpError(409, 'A folder with this name already exists here.');
    return insertFolder(name, parent);
  });
}
export function relativeParts(value: string | null) {
  if (!value) return [];
  if (value.length > 4096 || value.includes('\\') || value.startsWith('/'))
    throw new HttpError(400, 'Use a relative folder path without backslashes.');
  const parts = value.split('/');
  if (
    parts.length > 33 ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        Buffer.byteLength(part) > 255 ||
        /[\x00-\x1f\x7f]/.test(part),
    )
  )
    throw new HttpError(
      400,
      'Invalid relative path. Use up to 32 folder levels without . or .. segments.',
    );
  return parts.map((part) => part.normalize('NFC'));
}
// Called within the upload's metadata transaction, after streaming succeeds.
export function ensurePath(parent: string | null, names: string[]) {
  if (trail(parent).length + names.length > 32)
    throw new HttpError(400, 'Folders can be nested up to 32 levels.');
  let current = parent;
  for (const value of names) {
    const name = folderName(value);
    const existing = db()
      .prepare('SELECT id, deleting FROM folders WHERE parent_id IS ? AND name = ? COLLATE NOCASE')
      .get(current, name) as { id: string; deleting: number } | undefined;
    if (existing?.deleting)
      throw new HttpError(
        409,
        'A folder in this path is being deleted. Try again after deletion finishes.',
      );
    current = existing?.id || insertFolder(name, current).id;
  }
  return current;
}
export function childFolders(parent: string | null, q = '') {
  const pattern = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  return db()
    .prepare(
      `SELECT id, name, parent_id, created_at,
    (SELECT COUNT(*) FROM files WHERE folder_id = folders.id AND deleting = 0) +
    (SELECT COUNT(*) FROM folders children WHERE children.parent_id = folders.id AND children.deleting = 0) AS item_count
    FROM folders WHERE parent_id IS ? AND deleting = 0 AND name LIKE ? ESCAPE '\\'
    ORDER BY name COLLATE NOCASE, id`,
    )
    .all(parent, pattern);
}
const subtree = `WITH RECURSIVE tree(id) AS (
  SELECT id FROM folders WHERE id = ? AND deleting = 0
  UNION ALL SELECT folders.id FROM folders JOIN tree ON folders.parent_id = tree.id WHERE folders.deleting = 0
)`;
export function folderDetails(id: string) {
  const folder = folderById(id);
  const summary = db()
    .prepare(
      `${subtree} SELECT COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS size FROM files WHERE folder_id IN (SELECT id FROM tree) AND deleting = 0`,
    )
    .get(id) as { file_count: number; size: number };
  const count = db()
    .prepare(`${subtree} SELECT COUNT(*) - 1 AS folder_count FROM tree`)
    .get(id) as { folder_count: number };
  const { deleting: _, ...metadata } = folder;
  return { ...metadata, ...summary, ...count };
}
export function markFolderForDeletion(id: string) {
  transaction(() => {
    folderById(id);
    db()
      .prepare(`${subtree} UPDATE files SET deleting = 1 WHERE folder_id IN (SELECT id FROM tree)`)
      .run(id);
    db()
      .prepare(`${subtree} UPDATE folders SET deleting = 1 WHERE id IN (SELECT id FROM tree)`)
      .run(id);
  });
}
