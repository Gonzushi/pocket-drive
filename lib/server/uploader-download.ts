import { readFile } from 'node:fs/promises';
import { config } from './config';
import { HttpError } from './http';

export async function uploaderDownload(platform: string | null) {
  if (platform !== 'macos' && platform !== 'windows')
    throw new HttpError(400, 'Choose macos or windows.');
  const source = (await readFile('scripts/upload/uploader.py', 'utf8')).replace(
    'SERVER = "__POCKET_DRIVE_SERVER__"',
    `SERVER = ${JSON.stringify(config().origin)}`,
  );
  const script =
    platform === 'macos'
      ? `#!/bin/bash\nset -e\ncommand -v python3 >/dev/null || { echo 'Install Python 3.9 or newer, then run this script again.'; exit 1; }\nSCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"\npython3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo 'Python 3.9 or newer is required.'; exit 1; }\npython3 - "$SCRIPT_DIR" <<'POCKET_DRIVE_PYTHON'\n${source}\nPOCKET_DRIVE_PYTHON\n`
      : `$ErrorActionPreference = 'Stop'\n$python = $null\n$pythonArgs = @()\nforeach ($candidate in @('py', 'python3', 'python')) {\n  if (Get-Command $candidate -ErrorAction SilentlyContinue) {\n    $candidateArgs = @()\n    if ($candidate -eq 'py') { $candidateArgs = @('-3') }\n    & $candidate @candidateArgs -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'\n    if ($LASTEXITCODE -eq 0) { $python = $candidate; $pythonArgs = $candidateArgs; break }\n  }\n}\nif (-not $python) { throw 'Install Python 3.9 or newer from python.org, reopen PowerShell, and run again.' }\n$source = @'\n${source}\n'@\n$temporary = [System.IO.Path]::GetTempFileName()\ntry {\n  [System.IO.File]::WriteAllText($temporary, $source, (New-Object System.Text.UTF8Encoding($false)))\n  & $python @pythonArgs $temporary $PSScriptRoot\n  $result = $LASTEXITCODE\n} finally {\n  Remove-Item -LiteralPath $temporary -Force\n}\nexit $result\n`;
  const extension = platform === 'macos' ? 'sh' : 'ps1';
  return new Response(platform === 'windows' ? '\uFEFF' + script : script, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="pocket-drive-upload.${extension}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
