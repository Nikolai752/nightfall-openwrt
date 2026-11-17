#!/bin/sh
set -eu
ROOT=$(mktemp -d)
TMP=$(mktemp -d)
trap 'rm -rf "$ROOT" "$TMP"' EXIT HUP INT TERM
mkdir -p "$ROOT/etc" "$ROOT/proc/sys/kernel"
echo test-router > "$ROOT/proc/sys/kernel/hostname"
cat > "$ROOT/etc/nightfall-monitor.conf" <<'EOF'
TG=1
TG_TOKEN=old-secret-token
TG_PROXY=socks5://user:password@127.0.0.1:1080
TEMP_WARN=80
EOF
echo '{"theme":"night"}' > "$ROOT/etc/nightfall-prefs.json"
dd if=/dev/urandom of="$ROOT/etc/nightfall-journal.log" bs=4096 count=10 2>/dev/null
echo '{"logo":"custom"}' > "$ROOT/etc/nightfall-logo.json"
TOOL="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)/luci-app-nightfall-monitor/root/usr/libexec/nightfall-backup"
export NF_ROOT="$ROOT" NF_TMP="$TMP" NF_BACKUP_DIR="$TMP/backups"

echo "== create, archive validation and metadata =="
"$TOOL" create
ARCHIVE=$(find "$TMP/backups" -name '*.tar.gz' -type f | head -n 1)
[ -n "$ARCHIVE" ]
[ "$(wc -c < "$ARCHIVE" | tr -d ' ')" -gt 0 ]
gzip -t "$ARCHIVE"
"$TOOL" list "$ARCHIVE" | grep -q 'files=4'
NAME=$(basename "$ARCHIVE")
"$TOOL" download-info "$NAME" > "$TMP/info"
SIZE=$(sed -n 's/.*size=\([0-9][0-9]*\).*/\1/p' "$TMP/info")
HASH=$(sed -n 's/.*sha256=\([a-f0-9][a-f0-9]*\).*/\1/p' "$TMP/info")
[ "$SIZE" -eq "$(wc -c < "$ARCHIVE" | tr -d ' ')" ]
[ "$HASH" = "$(sha256sum "$ARCHIVE" | awk '{ print $1 }')" ]

echo "== multi-chunk browser download =="
: > "$TMP/downloaded.tar.gz"
offset=0
while [ "$offset" -lt "$SIZE" ]; do
  "$TOOL" download "$NAME" "$offset" 24576 > "$TMP/chunk.b64"
  [ -s "$TMP/chunk.b64" ]
  base64 -d "$TMP/chunk.b64" > "$TMP/part"
  got=$(wc -c < "$TMP/part" | tr -d ' ')
  expected=$((SIZE - offset)); [ "$expected" -gt 24576 ] && expected=24576
  [ "$got" -eq "$expected" ]
  cat "$TMP/part" >> "$TMP/downloaded.tar.gz"
  offset=$((offset + got))
done
cmp "$ARCHIVE" "$TMP/downloaded.tar.gz"

echo "== don't overwrite an existing archive =="
"$TOOL" create "$TMP/backups/repeat.tar.gz" >/dev/null
"$TOOL" create "$TMP/backups/repeat.tar.gz" >/dev/null
[ -s "$TMP/backups/repeat.tar.gz" ] && [ -s "$TMP/backups/repeat-1.tar.gz" ]

echo "== multi-chunk browser upload =="
"$TOOL" upload-start 0123abcd >/dev/null
offset=0; index=0
while [ "$offset" -lt "$SIZE" ]; do
  dd if="$ARCHIVE" bs=24576 skip="$index" count=1 2>/dev/null | base64 | tr -d '\n' > "$TMP/upload.b64"
  ENCODED=$(cat "$TMP/upload.b64")
  [ -n "$ENCODED" ] && [ "${#ENCODED}" -le 32768 ]
  "$TOOL" upload-chunk 0123abcd "$ENCODED" >/dev/null
  bytes=$((SIZE - offset)); [ "$bytes" -gt 24576 ] && bytes=24576
  offset=$((offset + bytes)); index=$((index + 1))
done
"$TOOL" upload-finish 0123abcd > "$TMP/upload-preview"
grep -q 'Архив загружен:' "$TMP/upload-preview"
UPLOADED="$TMP/backups/nightfall-backup-upload-0123abcd.tar.gz"
cmp "$ARCHIVE" "$UPLOADED"
tar -xOzf "$ARCHIVE" etc/nightfall-monitor.conf | grep -q '^TG_TOKEN=$'
tar -xOzf "$ARCHIVE" etc/nightfall-monitor.conf | grep -q '^TG_PROXY=$'
! tar -xOzf "$ARCHIVE" etc/nightfall-monitor.conf | grep -q 'old-secret-token'
! tar -xOzf "$ARCHIVE" etc/nightfall-monitor.conf | grep -q 'user:password'

echo "== preview and restore =="
echo '{"theme":"changed"}' > "$ROOT/etc/nightfall-prefs.json"
sed -i 's/^TG_TOKEN=.*/TG_TOKEN=current-secret-token/' "$ROOT/etc/nightfall-monitor.conf"
"$TOOL" restore "$ARCHIVE" > "$TMP/preview"
grep -q 'Предварительный просмотр' "$TMP/preview"
grep -q 'changed' "$ROOT/etc/nightfall-prefs.json"
"$TOOL" restore "$ARCHIVE" apply > "$TMP/restore"
grep -q 'night' "$ROOT/etc/nightfall-prefs.json"
grep -q '^TG_TOKEN=current-secret-token$' "$ROOT/etc/nightfall-monitor.conf"

echo "== rollback after an injected mid-restore failure =="
ROOT2="$TMP/rollback-root"
mkdir -p "$ROOT2/etc"
printf 'TG=1\nTG_TOKEN=rollback-token\n' > "$ROOT2/etc/nightfall-monitor.conf"
echo '{"theme":"keep"}' > "$ROOT2/etc/nightfall-prefs.json"
echo '{"logo":"keep"}' > "$ROOT2/etc/nightfall-logo.json"
mkdir -p "$TMP/failbin"
cat > "$TMP/failbin/mv" <<'EOF'
#!/bin/sh
if [ "$2" = "$FAIL_TARGET" ] && [ ! -f "$FAIL_MARKER" ]; then
  : > "$FAIL_MARKER"
  exit 1
fi
exec /bin/mv "$@"
EOF
chmod +x "$TMP/failbin/mv"
if PATH="$TMP/failbin:$PATH" FAIL_TARGET="$ROOT2/etc/nightfall-prefs.json" FAIL_MARKER="$TMP/mv-failed" NF_ROOT="$ROOT2" NF_TMP="$TMP" NF_BACKUP_DIR="$TMP/backups" "$TOOL" restore "$ARCHIVE" apply > "$TMP/rollback.out" 2>&1; then
  echo "restore unexpectedly succeeded despite injected mv failure" >&2
  exit 1
fi
grep -q 'исходные настройки возвращены' "$TMP/rollback.out"
grep -q '^TG_TOKEN=rollback-token$' "$ROOT2/etc/nightfall-monitor.conf"
grep -q '"theme":"keep"' "$ROOT2/etc/nightfall-prefs.json"
grep -q '"logo":"keep"' "$ROOT2/etc/nightfall-logo.json"

echo 'Nightfall backup/restore tests passed'
