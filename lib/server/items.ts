import { db, fileById, transaction } from './db';
import { folderById, folderName, parentId, trail, type Folder } from './folders';
import { HttpError } from './http';
import { kindOf, validId } from './storage';

export type ItemRef = { type: 'file' | 'folder'; id: string };
export function references(value: unknown): ItemRef[] {
  if (!Array.isArray(value) || !value.length || value.length > 100)
    throw new HttpError(400, 'Select between 1 and 100 items.');
  const seen = new Set<string>();
  return value.map((item) => {
    if (
      !item ||
      !['file', 'folder'].includes(item.type) ||
      typeof item.id !== 'string' ||
      !validId(item.id)
    )
      throw new HttpError(400, 'Invalid selected item.');
    const key = item.type + ':' + item.id;
    if (seen.has(key)) throw new HttpError(400, 'Each item may only be selected once.');
    seen.add(key);
    return { type: item.type, id: item.id };
  });
}
function resolve(item: ItemRef) {
  if (item.type === 'folder') {
    const folder = folderById(item.id);
    return { ...item, name: folder.name, parent: folder.parent_id };
  }
  const file = fileById(item.id);
  if (!file) throw new HttpError(404, 'A selected file no longer exists. Refresh your drive.');
  return { ...item, name: file.name, parent: file.folder_id };
}
function conflict(type: ItemRef['type'], name: string, parent: string | null, id: string) {
  const table = type === 'folder' ? 'folders' : 'files';
  const column = type === 'folder' ? 'parent_id' : 'folder_id';
  // Include pending deletions: folders have a unique index even while deleting.
  if (
    db()
      .prepare(
        `SELECT 1 FROM ${table} WHERE ${column} IS ? AND name = ? COLLATE NOCASE AND id != ?`,
      )
      .get(parent, name, id)
  ) {
    throw new HttpError(
      409,
      `A ${type} named “${name}” already exists in this folder. Rename it or choose another destination.`,
    );
  }
}
export function renameItem(item: ItemRef, value: unknown) {
  const name = folderName(value);
  return transaction(() => {
    const current = resolve(item);
    if (name !== current.name) {
      conflict(item.type, name, current.parent, item.id);
      if (item.type === 'folder')
        db().prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, item.id);
      else
        db()
          .prepare('UPDATE files SET name = ?, kind = ? WHERE id = ?')
          .run(name, kindOf(name), item.id);
    }
    return { id: item.id, type: item.type, name };
  });
}
export function folderTree() {
  return db()
    .prepare(
      'SELECT id, name, parent_id FROM folders WHERE deleting = 0 ORDER BY name COLLATE NOCASE, id',
    )
    .all();
}
export function moveItems(value: unknown, destination: unknown) {
  const items = references(value);
  if (destination === undefined) throw new HttpError(400, 'Choose a destination folder.');
  const parent = parentId(destination);
  return transaction(() => {
    const destinationTrail = trail(parent);
    const selected = items.map(resolve);
    const selectedFolders = new Set(
      selected.filter((item) => item.type === 'folder').map((item) => item.id),
    );
    const folders = db()
      .prepare('SELECT * FROM folders WHERE deleting = 0')
      .all() as unknown as Folder[];
    const children = new Map<string, Folder[]>();
    for (const folder of folders)
      if (folder.parent_id)
        children.set(folder.parent_id, [...(children.get(folder.parent_id) || []), folder]);
    for (const item of selected) {
      if (trail(item.parent).some((ancestor) => selectedFolders.has(ancestor.id)))
        throw new HttpError(400, 'Select either a folder or items inside it, rather than both.');
      if (item.type === 'folder') {
        if (destinationTrail.some((folder) => folder.id === item.id))
          throw new HttpError(
            400,
            'A folder cannot be moved into itself or one of its subfolders.',
          );
        const stack: [string, number][] = [[item.id, 1]];
        let height = 1;
        while (stack.length) {
          const [id, level] = stack.pop()!;
          height = Math.max(height, level);
          for (const child of children.get(id) || []) stack.push([child.id, level + 1]);
        }
        if (destinationTrail.length + height > 32)
          throw new HttpError(400, 'This move would exceed the 32-level folder limit.');
      }
      if (item.parent !== parent) conflict(item.type, item.name, parent, item.id);
    }
    // Detect collisions between the selected items before making any changes.
    const names = new Set<string>();
    for (const item of selected) {
      if (item.parent === parent) continue;
      const folded = item.name.replace(/[A-Z]/g, (char) => char.toLowerCase());
      const key = item.type + ':' + folded;
      if (names.has(key))
        throw new HttpError(
          409,
          `Two selected ${item.type}s are named “${item.name}”. Rename one before moving them together.`,
        );
      names.add(key);
    }
    let moved = 0;
    for (const item of selected) {
      if (item.parent === parent) continue;
      if (item.type === 'folder')
        db().prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(parent, item.id);
      else db().prepare('UPDATE files SET folder_id = ? WHERE id = ?').run(parent, item.id);
      moved++;
    }
    return { success: true, moved, destination_id: parent };
  });
}
export function markItemsForDeletion(value: unknown) {
  const items = references(value);
  transaction(() => {
    items.forEach(resolve);
    for (const item of items) {
      if (item.type === 'file')
        db().prepare('UPDATE files SET deleting = 1 WHERE id = ?').run(item.id);
      else {
        const tree = `WITH RECURSIVE tree(id) AS (SELECT id FROM folders WHERE id = ? UNION ALL SELECT folders.id FROM folders JOIN tree ON folders.parent_id = tree.id)`;
        db()
          .prepare(`${tree} UPDATE files SET deleting = 1 WHERE folder_id IN (SELECT id FROM tree)`)
          .run(item.id);
        db()
          .prepare(`${tree} UPDATE folders SET deleting = 1 WHERE id IN (SELECT id FROM tree)`)
          .run(item.id);
      }
    }
  });
  return items.length;
}
