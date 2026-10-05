export interface UploadSource { file: File; relativePath: string }
export async function droppedFiles(items: DataTransferItemList, fallback: FileList): Promise<UploadSource[]> {
  const entries = Array.from(items).map(item => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => !!entry);
  if (!entries.length) return Array.from(fallback).map(file => ({ file, relativePath: '' }));
  const result: UploadSource[] = [];
  async function visit(entry: FileSystemEntry, parent = ''): Promise<void> {
    const relative = parent + entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      result.push({ file, relativePath: parent ? relative : '' });
      if (result.length > 5000) throw new Error('Choose up to 5,000 files per upload batch.');
    } else if (entry.isDirectory) {
      if (relative.split('/').length > 32) throw new Error('Folders can be nested up to 32 levels.');
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      while (true) {
        const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!children.length) break;
        for (const child of children) await visit(child, relative + '/');
      }
    }
  }
  for (const entry of entries) await visit(entry);
  return result;
}
