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
echo '{"logo":"custom"}' > "$ROOT/etc/nightfall-logo.json"
TOOL="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)/luci-app-nightfall-monitor/root/usr/libexec/nightfall-backup"
export NF_ROOT="$ROOT" NF_TMP="$TMP" NF_BACKUP_DIR="$TMP/backups"

"$TOOL" create
ARCHIVE=$(find "$TMP/backups" -name '*.tar.gz' -type f | head -n 1)
[ -n "$ARCHIVE" ]
"$TOOL" list "$ARCHIVE" | grep -q 'files=3'
tar -xOzf "$ARCHIVE" etc/nightfall-monitor.conf | grep -q '^TG_TOKEN=$'
tar -xOzf "$ARCHIVE" etc/nightfall-monitor.conf | grep -q '^TG_PROXY=$'
! tar -xOzf "$ARCHIVE" etc/nightfall-monitor.conf | grep -q 'old-secret-token'
! tar -xOzf "$ARCHIVE" etc/nightfall-monitor.conf | grep -q 'user:password'

echo '{"theme":"changed"}' > "$ROOT/etc/nightfall-prefs.json"
sed -i 's/^TG_TOKEN=.*/TG_TOKEN=current-secret-token/' "$ROOT/etc/nightfall-monitor.conf"
"$TOOL" restore "$ARCHIVE" > "$TMP/preview"
grep -q 'Предварительный просмотр' "$TMP/preview"
grep -q 'changed' "$ROOT/etc/nightfall-prefs.json"
"$TOOL" restore "$ARCHIVE" apply > "$TMP/restore"
grep -q 'night' "$ROOT/etc/nightfall-prefs.json"
grep -q '^TG_TOKEN=current-secret-token$' "$ROOT/etc/nightfall-monitor.conf"
echo 'Nightfall backup/restore tests passed'
