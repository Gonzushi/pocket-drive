import path from 'node:path';
import { stat } from 'node:fs/promises';
import { db, fileById, transaction } from './db';
import { folderById, trail, type Folder } from './folders';
import { references, type ItemRef } from './items';
import { HttpError } from './http';
import { filePath } from './storage';
import { zipStream, type ZipEntry } from './zip';

const MAX_ENTRIES = 100000;
function safeName(name: string, fallback: string) {
  let result =
    name
      .normalize('NFC')
      .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_')
      .replace(/[. ]+$/, '')
      .trim() || fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(result)) result = '_' + result;
  return result;
}
function itemsSnapshot(items: ItemRef[]) {
  return transaction(() => {
    const selectedFolders = items
      .filter((item) => item.type === 'folder')
      .map((item) => folderById(item.id));
    const selectedFiles = items
      .filter((item) => item.type === 'file')
      .map((item) => {
        const file = fileById(item.id);
        if (!file)
          throw new HttpError(404, 'A selected file no longer exists. Refresh your drive.');
        return file;
      });
    const folderIds = new Set(selectedFolders.map((folder) => folder.id));
    const covered = (parent: string | null) =>
      trail(parent).some((folder) => folderIds.has(folder.id));
    // A selected parent already includes its selected descendants.
    const roots = selectedFolders.filter((folder) => !covered(folder.parent_id));
    const looseFiles = selectedFiles.filter((file) => !covered(file.folder_id));
    const used = new Set<string>();
    const folderPaths = new Map<string, string>();
    const entries: ZipEntry[] = [];
    function unique(parent: string, original: string, directory: boolean) {
      const name = safeName(original, directory ? 'folder' : 'file');
      const extension = directory ? '' : path.extname(name);
      const stem = name.slice(0, name.length - extension.length);
      let result = parent + name;
      let number = 2;
      while (used.has(result.toLowerCase())) result = parent + `${stem} (${number++})${extension}`;
      used.add(result.toLowerCase());
      return result;
    }
    for (const root of roots) {
      const tree = `WITH RECURSIVE tree(id, depth) AS (SELECT id, 0 FROM folders WHERE id = ? AND deleting = 0 UNION ALL SELECT folders.id, tree.depth + 1 FROM folders JOIN tree ON folders.parent_id = tree.id WHERE folders.deleting = 0)`;
      const folders = db()
        .prepare(
          `${tree} SELECT folders.*, depth FROM folders JOIN tree ON folders.id = tree.id ORDER BY depth, name COLLATE NOCASE, id`,
        )
        .all(root.id) as unknown as (Folder & { depth: number })[];
      const remaining = MAX_ENTRIES - entries.length - folders.length - looseFiles.length;
      if (remaining < 0)
        throw new HttpError(413, 'Download fewer items (up to 100,000 archive entries).');
      const files = db()
        .prepare(
          `${tree} SELECT files.id, files.name, files.folder_id, files.size, files.created_at, files.blob_id FROM files WHERE deleting = 0 AND folder_id IN (SELECT id FROM tree) ORDER BY name COLLATE NOCASE, id LIMIT ?`,
        )
        .all(root.id, remaining + 1) as unknown as {
        id: string;
        name: string;
        folder_id: string;
        size: number;
        created_at: string;
        blob_id: string | null;
      }[];
      if (files.length > remaining)
        throw new HttpError(413, 'Download fewer items (up to 100,000 archive entries).');
      for (const folder of folders) {
        const parent = folder.id === root.id ? '' : folderPaths.get(folder.parent_id!)!;
        const name = unique(parent, folder.name, true) + '/';
        folderPaths.set(folder.id, name);
        entries.push({ name, size: 0, created_at: folder.created_at });
      }
      for (const file of files)
        entries.push({
          name: unique(folderPaths.get(file.folder_id)!, file.name, false),
          size: file.size,
          path: filePath(file.id, file.blob_id ?? null),
          created_at: file.created_at,
        });
    }
    for (const file of looseFiles)
      entries.push({
        name: unique('', file.name, false),
        size: file.size,
        path: filePath(file.id, file.blob_id ?? null),
        created_at: file.created_at,
      });
    return {
      name:
        items.length === 1 && selectedFolders.length === 1
          ? safeName(selectedFolders[0].name, 'folder') + '.zip'
          : 'pocket-drive-selection.zip',
      entries,
    };
  });
}
export function folderSnapshot(id: string) {
  return itemsSnapshot([{ type: 'folder', id }]);
}
export async function downloadFolder(req: Request, id: string) {
  return downloadSnapshot(req, folderSnapshot(id));
}
export async function downloadItems(req: Request, value: unknown) {
  return downloadSnapshot(req, itemsSnapshot(references(value)));
}
async function downloadSnapshot(req: Request, snapshot: { name: string; entries: ZipEntry[] }) {
  // Validate files before sending headers, without holding a DB lock or copying
  // contents. A later concurrent deletion aborts the ZIP instead of omitting data.
  for (let offset = 0; offset < snapshot.entries.length; offset += 32) {
    req.signal.throwIfAborted();
    await Promise.all(
      snapshot.entries
        .slice(offset, offset + 32)
        .filter((entry) => entry.path)
        .map(async (entry) => {
          try {
            const info = await stat(entry.path!);
            if (!info.isFile() || info.size !== entry.size)
              throw new HttpError(
                409,
                'A folder file changed on disk. Retry or restore it from a backup.',
              );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
              throw new HttpError(
                409,
                'A folder file is missing or was deleted. Refresh and retry the download.',
              );
            throw error;
          }
        }),
    );
  }
  const headers = new Headers({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="folder.zip"; filename*=UTF-8''${encodeURIComponent(snapshot.name).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase())}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'none',
  });
  return new Response(req.method === 'HEAD' ? null : zipStream(snapshot.entries, req.signal), {
    headers,
  });
}
