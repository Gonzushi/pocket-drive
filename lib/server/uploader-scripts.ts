export type UploaderPlatform = 'macos' | 'windows';
export type UploaderVariant = 'python' | 'native';

export function pythonLauncher(platform: UploaderPlatform, source: string) {
  return platform === 'macos'
    ? `#!/bin/bash\nset -e\ncommand -v python3 >/dev/null || { echo 'Install Python 3.9 or newer, then run this script again.'; exit 1; }\nSCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"\npython3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo 'Python 3.9 or newer is required.'; exit 1; }\npython3 - "$SCRIPT_DIR" <<'POCKET_DRIVE_PYTHON'\n${source}\nPOCKET_DRIVE_PYTHON\n`
    : `$ErrorActionPreference = 'Stop'\n$python = $null\n$pythonArgs = @()\nforeach ($candidate in @('py', 'python3', 'python')) {\n  if (Get-Command $candidate -ErrorAction SilentlyContinue) {\n    $candidateArgs = @()\n    if ($candidate -eq 'py') { $candidateArgs = @('-3') }\n    & $candidate @candidateArgs -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'\n    if ($LASTEXITCODE -eq 0) { $python = $candidate; $pythonArgs = $candidateArgs; break }\n  }\n}\nif (-not $python) { throw 'Install Python 3.9 or newer from python.org, reopen PowerShell, and run again.' }\n$source = @'\n${source}\n'@\n$temporary = [System.IO.Path]::GetTempFileName()\ntry {\n  [System.IO.File]::WriteAllText($temporary, $source, (New-Object System.Text.UTF8Encoding($false)))\n  & $python @pythonArgs $temporary $PSScriptRoot\n  $result = $LASTEXITCODE\n} finally {\n  Remove-Item -LiteralPath $temporary -Force\n}\nexit $result\n`;
}

export function nativeLauncher(
  platform: UploaderPlatform,
  origin: string,
  sources: { macos: string; shell: string; windows: string },
) {
  if (platform === 'macos') {
    const source = sources.macos.replace(
      "var SERVER = '__POCKET_DRIVE_SERVER__';",
      `var SERVER = ${JSON.stringify(origin)};`,
    );
    const shellOrigin = "'" + ('Server: ' + origin).replace(/'/g, "'\\''") + "'";
    return sources.shell
      .replace('__POCKET_DRIVE_JXA_SOURCE__', source)
      .replace('echo "Server: __POCKET_DRIVE_ORIGIN_TEXT__"', `echo ${shellOrigin}`);
  }
  const source = sources.windows.replace(
    "$Server = '__POCKET_DRIVE_SERVER__'",
    "$Server = '" + origin.replace(/'/g, "''") + "'",
  );
  // CMD starts its built-in PowerShell; the embedded source is UTF-8 decoded before execution.
  return `@echo off\r\nsetlocal\r\nset "POCKET_DRIVE_LAUNCHER=%~f0"\r\npowershell -NoProfile -ExecutionPolicy Bypass -Command "$text=[IO.File]::ReadAllText($env:POCKET_DRIVE_LAUNCHER); $marker='# POCKET_DRIVE_NATIVE_SOURCE'; $source=$text.Substring($text.LastIndexOf($marker)+$marker.Length); & ([ScriptBlock]::Create($source)) -ReportDirectory ([IO.Path]::GetDirectoryName($env:POCKET_DRIVE_LAUNCHER))"\r\nexit /b %errorlevel%\r\n# POCKET_DRIVE_NATIVE_SOURCE\r\n${source}`;
}
