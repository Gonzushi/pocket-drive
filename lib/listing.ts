import { db } from './db';
import { parentId, trail } from './folders';
import { HttpError } from './http';
import type { FileItem, FolderItem, TreeFolder } from './types';

const registered = new WeakSet<object>();
export function listFiles(params: URLSearchParams) {
  const database = db();
  const folder = parentId(params.get('folder_id'));
  const breadcrumbs = trail(folder).map(({ id, name }) => ({ id, name }));
  const type = params.get('type') || 'all';
  const scope = params.get('scope') || (params.has('folder_id') ? 'folder' : 'drive');
  const recursive = params.get('recursive') || '0';
  const sort = params.get('sort') || 'date';
  const order = params.get('order') || (sort === 'date' || sort === 'size' ? 'desc' : 'asc');
  const offset = Number(params.get('offset') || '0');
  if (!['all', 'image', 'document', 'other'].includes(type)) throw new HttpError(400, 'Invalid file filter.');
  if (!['folder', 'drive'].includes(scope) || !['0', '1'].includes(recursive)) throw new HttpError(400, 'Invalid search scope.');
  if (!['name', 'date', 'size', 'type'].includes(sort) || !['asc', 'desc'].includes(order)) throw new HttpError(400, 'Invalid sort.');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'Invalid page.');
  if (!registered.has(database)) {
    database.function('file_extension', { deterministic: true }, value => {
      const name = String(value); const dot = name.lastIndexOf('.');
      return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    });
    registered.add(database);
  }
  const pattern = '%' + (params.get('q') || '').slice(0, 200).replace(/[\\%_]/g, '\\$&') + '%';
  const descendants = scope === 'folder' && recursive === '1' && folder !== null;
  const prefix = descendants ? `WITH RECURSIVE scope(id) AS (
    SELECT id FROM folders WHERE id = ? AND deleting = 0
    UNION ALL SELECT f.id FROM folders f JOIN scope ON f.parent_id = scope.id WHERE f.deleting = 0
  ) ` : '';
  const global = scope === 'drive' || (recursive === '1' && folder === null);
  const fileLocation = global ? '1 = 1' : descendants ? 'folder_id IN (SELECT id FROM scope)' : 'folder_id IS ?';
  const folderLocation = global ? '1 = 1' : descendants ? 'id IN (SELECT id FROM scope) AND id != ?' : 'parent_id IS ?';
  const leading = descendants ? [folder] : [];
  const locationValues = global || descendants ? [] : [folder];
  const values = [...leading, pattern, type, type, ...locationValues];
  const where = `deleting = 0 AND name LIKE ? ESCAPE '\\' AND (? = 'all' OR kind = ?) AND ${fileLocation}`;
  // Only validated, fixed SQL fragments are interpolated. Sorting precedes pagination.
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const column = { name: 'name COLLATE NOCASE', date: 'created_at', size: 'size', type: 'file_extension(name) COLLATE NOCASE' }[sort]!;
  const ordering = `${column} ${direction}, name COLLATE NOCASE ASC, id ASC`;
  const count = database.prepare(`${prefix}SELECT COUNT(*) AS total FROM files WHERE ${where}`).get(...values) as { total: number };
  const files = database.prepare(`${prefix}SELECT id, name, size, mime_type, kind, checksum, created_at, folder_id FROM files WHERE ${where} ORDER BY ${ordering} LIMIT 50 OFFSET ?`).all(...values, offset) as unknown as FileItem[];
  const folderSort = sort === 'date' ? `created_at ${direction}` : `name COLLATE NOCASE ${sort === 'name' ? direction : 'ASC'}`;
  const folders = type === 'all' ? database.prepare(`${prefix}SELECT id, name, parent_id, created_at,
    (SELECT COUNT(*) FROM files WHERE folder_id = folders.id AND deleting = 0) +
    (SELECT COUNT(*) FROM folders children WHERE children.parent_id = folders.id AND children.deleting = 0) AS item_count
    FROM folders WHERE deleting = 0 AND name LIKE ? ESCAPE '\\' AND ${folderLocation}
    ORDER BY ${folderSort}, id ASC`).all(...leading, pattern, ...(global ? [] : [folder])) as unknown as FolderItem[] : [];
  const nodes = database.prepare('SELECT id, name, parent_id FROM folders WHERE deleting = 0').all() as unknown as TreeFolder[];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const paths = new Map<string | null, string>([[null, 'My files']]);
  function location(id: string | null): string {
    const cached = paths.get(id); if (cached !== undefined) return cached;
    const parts: string[] = []; let current = id;
    while (current && parts.length < 32) { const node = byId.get(current); if (!node) break; parts.unshift(node.name); current = node.parent_id; }
    const path = ['My files', ...parts].join(' / '); paths.set(id, path); return path;
  }
  return { files: files.map(file => ({ ...file, location: location(file.folder_id) })), total: count.total, offset, limit: 50,
    folders: folders.map(item => ({ ...item, location: location(item.parent_id) })), breadcrumbs };
}
