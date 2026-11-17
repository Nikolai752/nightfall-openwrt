#!/bin/sh
# Regression tests for USB persistence mount-loss handling.
set -eu
cd "$(dirname "$0")/.."

COLLECTOR="luci-app-nightfall-monitor/root/usr/libexec/nightfall-collector"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/usb/nightfall" "$T/ram"
: > "$T/events"
echo 'old persistent history' > "$T/usb/nightfall/hist.coarse"

# Load only the real persistence helpers from the collector.
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
persist_ok=1
persist_error=0
persist_error_notified=0
NF_MOUNTS="$T/mounts"

ok=0
bad=0
pass() { ok=$((ok + 1)); echo "ok   $1"; }
fail() { bad=$((bad + 1)); echo "FAIL $1" >&2; }
expect_external() {
  if on_flash "$1"; then fail "$2"; else pass "$2"; fi
}
expect_internal() {
  if on_flash "$1"; then pass "$2"; else fail "$2"; fi
}

# No USB mount: the path resolves to the root filesystem and must never be written.
printf '/dev/root / ext4 rw 0 0\n' > "$NF_MOUNTS"
expect_internal "$PERSIST_DIR" "unmounted USB path resolves to root filesystem"
PERSIST_DIR="$T/not-mounted/nightfall"
if persist; then fail "persistence is refused while USB is absent"; else pass "persistence is refused while USB is absent"; fi
[ ! -e "$T/not-mounted" ] && pass "no fallback directory is created on root storage" || fail "no fallback directory is created on root storage"
PERSIST_DIR="$T/usb/nightfall"
echo 'new RAM history' > "$DIR/hist.coarse"
if persist; then fail "no write is attempted while USB is absent"; else pass "no write is attempted while USB is absent"; fi
grep -q 'old persistent history' "$PERSIST_DIR/hist.coarse" && pass "underlying directory is not overwritten" || fail "underlying directory is not overwritten"
[ "$persist_ok" = 0 ] && pass "storage status becomes unavailable" || fail "storage status becomes unavailable"

# USB returns: the real mount is detected and history from RAM is merged.
printf '/dev/root / ext4 rw 0 0\n/dev/sda1 %s exfat rw 0 0\n' "$T/usb" > "$NF_MOUNTS"
expect_external "$PERSIST_DIR" "USB mount is recognized through nested data directory"
if persist; then pass "persistence resumes after USB mount returns"; else fail "persistence resumes after USB mount returns"; fi
grep -q 'old persistent history' "$PERSIST_DIR/hist.coarse" && pass "old USB history is preserved" || fail "old USB history is preserved"
grep -q 'new RAM history' "$PERSIST_DIR/hist.coarse" && pass "RAM history is merged into USB history" || fail "RAM history is merged into USB history"
[ "$persist_ok" = 1 ] && pass "storage status returns to available" || fail "storage status returns to available"

# Disconnect again: the mount table no longer contains USB, so no overwrite is allowed.
printf '/dev/root / ext4 rw 0 0\n' > "$NF_MOUNTS"
echo 'changed while USB absent' >> "$DIR/hist.coarse"
if persist; then fail "writes are skipped after USB removal"; else pass "writes are skipped after USB removal"; fi
grep -q 'old persistent history' "$PERSIST_DIR/hist.coarse" && grep -q 'new RAM history' "$PERSIST_DIR/hist.coarse" && pass "USB data remains untouched while unmounted" || fail "USB data remains untouched while unmounted"

# Remount: persistence resumes and the newly collected line is saved.
printf '/dev/root / ext4 rw 0 0\n/dev/sda1 %s exfat rw 0 0\n' "$T/usb" > "$NF_MOUNTS"
if persist; then pass "persistence resumes after second mount"; else fail "persistence resumes after second mount"; fi
grep -q 'changed while USB absent' "$PERSIST_DIR/hist.coarse" && pass "RAM data collected during disconnection is saved" || fail "RAM data collected during disconnection is saved"

# Restore the archived history into an empty RAM directory.
rm -f "$DIR/hist.coarse"
persist_ok=0
restore
grep -q 'old persistent history' "$DIR/hist.coarse" && pass "restore loads history from mounted USB" || fail "restore loads history from mounted USB"
grep -q 'changed while USB absent' "$DIR/hist.coarse" && pass "restore includes history collected during disconnection" || fail "restore includes history collected during disconnection"

# PERSIST_ANY permits a non-root custom mount, but never root/overlay/ROM.
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
