import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeLauncher } from '../lib/server/uploader-scripts.ts';
const [directory, origin] = process.argv.slice(2);
if (!directory || !origin)
  throw new Error('Usage: node scripts/render-uploaders.ts OUTPUT_DIR ORIGIN');
const [macos, shell, windows] = await Promise.all([
  readFile('scripts/upload/native-macos.js', 'utf8'),
  readFile('scripts/upload/native-macos.sh', 'utf8'),
  readFile('scripts/upload/native-windows.ps1', 'utf8'),
]);
await mkdir(directory, { recursive: true });
await writeFile(
  join(directory, 'pocket-drive-upload-native.sh'),
  nativeLauncher('macos', origin, { macos, shell, windows }),
);
await writeFile(
  join(directory, 'pocket-drive-upload-native.cmd'),
  nativeLauncher('windows', origin, { macos, shell, windows }),
);
