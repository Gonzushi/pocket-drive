export type PreviewKind = 'image' | 'pdf' | 'text' | 'markdown' | 'table' | 'workbook' | 'audio' | 'video' | 'archive' | 'unsupported';
const images: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };
const media: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg' };
const textExtensions = new Set('txt text log sql scala py js jsx ts tsx mjs cjs json jsonl ndjson yaml yml toml ini conf cfg env sh bash zsh css scss less html htm xml svg java c cpp h hpp rs go rb php r swift kt kts vue svelte ipynb diff patch properties gitignore dockerfile'.split(' '));
export function previewType(name: string): { kind: PreviewKind; mime: string; extension: string } {
  const extension = name.toLowerCase().split('.').pop() || '';
  if (images[extension]) return { kind: 'image', mime: images[extension], extension };
  if (media[extension]) return { kind: media[extension].startsWith('audio') ? 'audio' : 'video', mime: media[extension], extension };
  const kind: PreviewKind = extension === 'pdf' ? 'pdf' : ['md', 'markdown'].includes(extension) ? 'markdown' : ['csv', 'tsv'].includes(extension) ? 'table' : extension === 'xlsx' ? 'workbook' : extension === 'zip' ? 'archive' : textExtensions.has(extension) || ['dockerfile', 'makefile', 'license', 'readme'].includes(name.toLowerCase()) ? 'text' : 'unsupported';
  return { kind, mime: kind === 'pdf' ? 'application/pdf' : ['text', 'markdown', 'table'].includes(kind) ? 'text/plain; charset=utf-8' : 'application/octet-stream', extension };
}
export const PREVIEW_TEXT_BYTES = 512 * 1024;
export const PREVIEW_WORKBOOK_BYTES = 10 * 1024 * 1024;
export function previewLimit(kind: PreviewKind) { return kind === 'image' ? 25 * 1024 * 1024 : kind === 'pdf' ? 100 * 1024 * 1024 : kind === 'workbook' ? PREVIEW_WORKBOOK_BYTES : Infinity; }
