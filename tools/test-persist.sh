#!/bin/sh
# Regression tests for USB persistence mount-loss handling.
set -eu
cd "$(dirname "$0")/.."
COLLECTOR="luci-app-nightfall-monitor/root/usr/libexec/nightfall-collector"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/usb/nightfall" "$T/ram"
: > "$T/events"
cat > "$T/functions.sh" <<'EOF'
EOF
awk '
  /^PFILES=/ { print; next }
  /^(persist_mount_info|on_flash|persist_warn|persist|restore)\(\) \{/ { inside=1 }
  inside { print }
  inside && /^}/ { inside=0 }
' "$COLLECTOR" > "$T/functions.sh"
event() { printf '%s|%s\n' "$1" "$2" >> "$T/events"; }
. "$T/functions.sh"
PERSIST_DIR="$T/usb/nightfall"
DIR="$T/ram"
PFILES="hist.coarse"
PERSIST_ANY=0
persist_ok=1; persist_error=0; persist_error_notified=0
NF_MOUNTS="$T/mounts"

ok=0; bad=0
pass() { ok=$((ok + 1)); echo "ok   $1"; }
fail() { bad=$((bad + 1)); echo "FAIL $1" >&2; }
expect_external() {
  if on_flash "$1"; then fail "$2"; else pass "$2"; fi
}
expect_internal() {
  if on_flash "$1"; then pass "$2"; else fail "$2"; fi
}

printf '/dev/root / ext4 rw 0 0\n' > "$NF_MOUNTS"
expect_internal "$PERSIST_DIR" "unmounted USB path resolves to root filesystem"
echo 'new RAM history' > "$DIR/hist.coarse"
if persist; then fail "refuse persistence when USB is absent"; else pass "refuse persistence when USB is absent"; fi
[ ! -e "$PERSIST_DIR/hist.coarse" ] && pass "no file written into underlying directory" || fail "no file written into underlying directory"
[ "$persist_ok" = 0 ] && pass "storage status becomes unavailable" || fail "storage status becomes unavailable"

printf '/dev/root / ext4 rw 0 0\n/dev/sda1 %s exfat rw 0 0\n' "$T/usb" > "$NF_MOUNTS"
expect_external "$PERSIST_DIR" "USB mount is recognized through nested data directory"
if persist; then pass "persistence resumes after USB mount returns"; else fail "persistence resumes after USB mount returns"; fi
grep -q 'new RAM history' "$PERSIST_DIR/hist.coarse" && pass "history copied to external storage" || fail "history copied to external storage"
[ "$persist_ok" = 1 ] && pass "storage status returns to available" || fail "storage status returns to available"

printf '/dev/root / ext4 rw 0 0\n' > "$NF_MOUNTS"
echo 'changed while USB absent' > "$DIR/hist.coarse"
if persist; then fail "skip writes after USB removal"; else pass "skip writes after USB removal"; fi
grep -q 'new RAM history' "$PERSIST_DIR/hist.coarse" && pass "existing USB data is not overwritten while unmounted" || fail "existing USB data is not overwritten while unmounted"

printf '/dev/root / ext4 rw 0 0\n/dev/sda1 %s exfat rw 0 0\n' "$T/usb" > "$NF_MOUNTS"
if persist; then pass "persistence resumes after remount"; else fail "persistence resumes after remount"; fi
grep -q 'changed while USB absent' "$PERSIST_DIR/hist.coarse" && pass "RAM history is saved after remount" || fail "RAM history is saved after remount"

rm -f "$DIR/hist.coarse"
if restore; then :; fi
grep -q 'changed while USB absent' "$DIR/hist.coarse" && pass "history restore works from mounted USB" || fail "history restore works from mounted USB"

printf '/dev/root / ext4 rw 0 0\n/dev/mapper/data %s ext4 rw 0 0\n' "$T/usb" > "$NF_MOUNTS"
PERSIST_ANY=0
expect_internal "$PERSIST_DIR" "unknown block source is denied by default"
PERSIST_ANY=1
expect_external "$PERSIST_DIR" "PERSIST_ANY permits a non-root custom mount"
printf '/dev/root / ext4 rw 0 0\n' > "$NF_MOUNTS"
expect_internal "$PERSIST_DIR" "PERSIST_ANY never permits the root overlay"

echo
echo "ИТОГО: ok=$ok, ошибок=$bad"
[ "$bad" -eq 0 ]
