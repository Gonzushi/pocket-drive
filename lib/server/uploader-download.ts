import { readFile } from 'node:fs/promises';
import { config } from './config';
import { HttpError } from './http';
import { nativeLauncher, pythonLauncher } from './uploader-scripts';

export async function uploaderDownload(platform: string | null, variant: string | null = 'python') {
  if (platform !== 'macos' && platform !== 'windows')
    throw new HttpError(400, 'Choose macos or windows.');
  const selected = variant || 'python';
  if (selected !== 'native' && selected !== 'python')
    throw new HttpError(400, 'Choose native or python.');
  const origin = config().origin;
  let script: string;
  if (selected === 'native') {
    const [macos, shell, windows] = await Promise.all([
      readFile('scripts/upload/native-macos.js', 'utf8'),
      readFile('scripts/upload/native-macos.sh', 'utf8'),
      readFile('scripts/upload/native-windows.ps1', 'utf8'),
    ]);
    script = nativeLauncher(platform, origin, { macos, shell, windows });
  } else {
    const source = (await readFile('scripts/upload/uploader.py', 'utf8')).replace(
      'SERVER = "__POCKET_DRIVE_SERVER__"',
      `SERVER = ${JSON.stringify(origin)}`,
    );
    script = pythonLauncher(platform, source);
  }
  const extension = platform === 'macos' ? 'sh' : selected === 'native' ? 'cmd' : 'ps1';
  const suffix = selected === 'native' ? '-native' : '';
  return new Response(
    platform === 'windows' && selected === 'python' ? '\uFEFF' + script : script,
    {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="pocket-drive-upload${suffix}.${extension}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
