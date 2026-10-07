#!/bin/bash
set -e
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
for tool in /usr/bin/osascript /usr/bin/curl /usr/bin/shasum; do
  [ -x "$tool" ] || { echo "Required macOS system tool is missing: $tool"; exit 1; }
done
PROBE="$(mktemp "$SCRIPT_DIR/.pocket-upload-check.XXXXXX")"
rm -f "$PROBE"
PROGRAM="$(mktemp -t pocket-native)"
trap 'rm -f "$PROGRAM"' EXIT
cat > "$PROGRAM" <<'POCKET_DRIVE_JXA'
__POCKET_DRIVE_JXA_SOURCE__
POCKET_DRIVE_JXA
if [ -n "${POCKET_DRIVE_UPLOAD_REPORT:-}${POCKET_DRIVE_UPLOAD_SOURCE:-}" ]; then
  if [ -n "${POCKET_DRIVE_UPLOAD_REPORT:-}" ]; then
    MODE=2
    TARGET="$POCKET_DRIVE_UPLOAD_REPORT"
  else
    MODE=1
    TARGET="$POCKET_DRIVE_UPLOAD_SOURCE"
  fi
  CONCURRENCY="${POCKET_DRIVE_UPLOAD_CONCURRENCY:-3}"
  IFS= read -r KEY
else
  echo 'Pocket Drive native uploader'
  echo '1. Upload a file or folder'
  echo '2. Retry or resume from JSON report'
  read -r -p 'Choose 1 or 2 [1]: ' MODE
  MODE="${MODE:-1}"
  case "$MODE" in 1|2) ;; *) echo 'Choose 1 or 2.'; exit 1 ;; esac
  echo 'File: /Users/hendry/Documents/trial.sql'
  echo 'Folder: /Users/hendry/Documents/Reports'
  echo 'Spaces, surrounding quotes and ~ are supported. Links are skipped.'
  if [ "$MODE" = 2 ]; then read -r -p 'JSON report path: ' TARGET
  else read -r -p 'File or folder path: ' TARGET; fi
  while true; do
    read -r -p 'Parallel file uploads, 1-8 [3]: ' CONCURRENCY
    CONCURRENCY="${CONCURRENCY:-3}"
    case "$CONCURRENCY" in [1-8]) break ;; *) echo 'Enter a number from 1 to 8.' ;; esac
  done
  read -r -s -p 'API key (hidden): ' KEY
  echo
  echo "Server: __POCKET_DRIVE_ORIGIN_TEXT__"
  echo "Destination: My files; concurrency: $CONCURRENCY; source/report: $TARGET"
  read -r -p 'Start uploading? [Y/n]: ' CONFIRM
  case "$CONFIRM" in ''|y|Y|yes|YES) ;; *) exit 0 ;; esac
fi
# Credentials enter JXA over stdin, and curl over its stdin config; never command arguments.
printf '%s\n' "$KEY" | /usr/bin/osascript -l JavaScript "$PROGRAM" "$SCRIPT_DIR" "$MODE" "$TARGET" "$CONCURRENCY"
