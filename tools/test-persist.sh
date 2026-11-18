#!/bin/sh
# Regression tests for USB persistence mount-loss handling and recovery.
set -eu
cd "$(dirname "$0")/.."
COLLECTOR="luci-app-nightfall-monitor/root/usr/libexec/nightfall-collector"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/usb/nightfall" "$T/ram"
: > "$T/events"

# Existing data on USB is hidden by the simulated root mount while USB is absent.
echo 'old persistent history' > "$T/usb/nightfall/hist.coarse"
echo '20261117' > "$T/usb/nightfall/day.date"
echo '192.168.1.2 100 200' > "$T/usb/nightfall/dev.day"
echo '192.168.1.2|video|Direct|1000|2000' > "$T/usb/nightfall/apps.day"
echo '2' > "$T/usb/nightfall/apps.v"
echo '20261117 10000 20000' > "$T/usb/nightfall/traffic.daily"
echo '20261116 192.168.1.2 500 600 aa:bb:cc:dd:ee:ff' > "$T/usb/nightfall/dev.daily"
echo '20261116|192.168.1.2|video|Direct|700|800' > "$T/usb/nightfall/apps.hist"

awk '
  /^PFILES=/ { print; next }
  /^(persist_mount_info|on_flash|persist_warn|persist|persist_check|restore)\(\) \{/ { inside=1 }
  inside { print }
  inside && /^}/ { inside=0 }
' "$COLLECTOR" > "$T/functions.sh"

event() { printf '%s|%s\n' "$1" "$2" >> "$T/events"; }
. "$T/functions.sh"

PERSIST_DIR="$T/usb/nightfall"
DIR="$T/ram"
PFILES="hist.coarse day.date dev.day apps.day apps.v traffic.daily dev.daily apps.hist"
PERSIST_ANY=0
persist_ok=1
persist_error=0
persist_error_notified=0
persist_need_restore=1
AGG=1
PERSIST_HOURS=1
tick=1
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

# No USB: the configured path resolves to root storage and must remain untouched.
printf '/dev/root / ext4 rw 0 0\n' > "$NF_MOUNTS"
expect_internal "$PERSIST_DIR" "unmounted USB path resolves to root filesystem"
PERSIST_DIR="$T/not-mounted/nightfall"
if persist; then fail "do not create a missing USB path on root storage"; else pass "do not create a missing USB path on root storage"; fi
[ ! -e "$T/not-mounted" ] && pass "no fallback directory is created on root storage" || fail "no fallback directory is created on root storage"
PERSIST_DIR="$T/usb/nightfall"

# Data collected in RAM while USB is unavailable.
echo '20261117' > "$DIR/day.date"
echo '192.168.1.2 30 40' > "$DIR/dev.day"
echo '192.168.1.2|video|Direct|300|400' > "$DIR/apps.day"
echo '2' > "$DIR/apps.v"
echo '20261117 300 400' > "$DIR/traffic.daily"
echo '20261116 192.168.1.2 50 60 aa:bb:cc:dd:ee:ff' > "$DIR/dev.daily"
echo '20261116|192.168.1.2|video|Direct|70|80' > "$DIR/apps.hist"
echo 'new RAM history' > "$DIR/hist.coarse"

if persist; then fail "refuse persistence when USB is absent"; else pass "refuse persistence when USB is absent"; fi
grep -q 'old persistent history' "$PERSIST_DIR/hist.coarse" && pass "USB history is not overwritten while unmounted" || fail "USB history is not overwritten while unmounted"
[ "$persist_ok" = 0 ] && pass "storage status becomes unavailable" || fail "storage status becomes unavailable"

# USB returns: append-only history is deduplicated, counters are combined.
printf '/dev/root / ext4 rw 0 0\n/dev/sda1 %s exfat rw 0 0\n' "$T/usb" > "$NF_MOUNTS"
expect_external "$PERSIST_DIR" "USB mount is recognized through nested data directory"
if persist; then pass "persistence resumes after USB mount returns"; else fail "persistence resumes after USB mount returns"; fi
grep -q 'old persistent history' "$PERSIST_DIR/hist.coarse" && grep -q 'new RAM history' "$PERSIST_DIR/hist.coarse" && pass "USB history and RAM history are merged" || fail "USB history and RAM history are merged"
grep -q '^192\.168\.1\.2 130 240$' "$PERSIST_DIR/dev.day" && pass "device daily counters are added" || fail "device daily counters are added"
grep -q '^192\.168\.1\.2|video|Direct|1300|2400 && pass "application daily counters are added" || fail "application daily counters are added"
grep -q '^20261117 10300 20400$' "$PERSIST_DIR/traffic.daily" && pass "WAN daily counters are added" || fail "WAN daily counters are added"
grep -q '^20261116 192\.168\.1\.2 550 660 aa:bb:cc:dd:ee:ff$' "$PERSIST_DIR/dev.daily" && pass "historical device counters are merged" || fail "historical device counters are merged"
grep -q '^20261116|192\.168\.1\.2|video|Direct|770|880 && pass "historical application counters are merged" || fail "historical application counters are merged"
[ "$persist_ok" = 1 ] && pass "storage status returns to available" || fail "storage status returns to available"

# Disconnect again: RAM keeps collecting; USB data is not touched.
printf '/dev/root / ext4 rw 0 0\n' > "$NF_MOUNTS"
echo 'changed while USB absent' >> "$DIR/hist.coarse"
if persist_check; then fail "detect USB removal during periodic check"; else pass "detect USB removal during periodic check"; fi
[ "$persist_ok" = 0 ] && pass "periodic check marks persistence unavailable" || fail "periodic check marks persistence unavailable"
grep -q 'old persistent history' "$PERSIST_DIR/hist.coarse" && grep -q 'new RAM history' "$PERSIST_DIR/hist.coarse" && pass "existing USB data is not overwritten while unmounted" || fail "existing USB data is not overwritten while unmounted"

# Reconnect: history is merged, already synchronized daily totals are not double-counted.
printf '/dev/root / ext4 rw 0 0\n/dev/sda1 %s exfat rw 0 0\n' "$T/usb" > "$NF_MOUNTS"
if persist_check; then pass "persistence resumes immediately after remount check"; else fail "persistence resumes immediately after remount check"; fi
grep -q 'old persistent history' "$PERSIST_DIR/hist.coarse" && grep -q 'new RAM history' "$PERSIST_DIR/hist.coarse" && grep -q 'changed while USB absent' "$PERSIST_DIR/hist.coarse" && pass "old and new history survives remount" || fail "old and new history survives remount"
grep -q '^192\.168\.1\.2 130 240$' "$PERSIST_DIR/dev.day" && pass "daily counters are not double-counted on repeated remount" || fail "daily counters are not double-counted on repeated remount"

# A fresh RAM directory can restore the archived history.
rm -f "$DIR/hist.coarse"
persist_need_restore=1
restore
grep -q 'changed while USB absent' "$DIR/hist.coarse" && pass "history restore works from mounted USB" || fail "history restore works from mounted USB"

# PERSIST_ANY may allow a custom non-root mount, but never root/overlay.
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
 "$PERSIST_DIR/apps.day" && pass "application daily counters are added" || fail "application daily counters are added"
grep -q '^20261117 10300 20400$' "$PERSIST_DIR/traffic.daily" && pass "WAN daily counters are added" || fail "WAN daily counters are added"
grep -q '^20261116 192\.168\.1\.2 550 660 aa:bb:cc:dd:ee:ff$' "$PERSIST_DIR/dev.daily" && pass "historical device counters are merged" || fail "historical device counters are merged"
grep -q '^20261116|192\.168\.1\.2|video|770|880$' "$PERSIST_DIR/apps.hist" && pass "historical application counters are merged" || fail "historical application counters are merged"
[ "$persist_ok" = 1 ] && pass "storage status returns to available" || fail "storage status returns to available"

# Disconnect again: RAM keeps collecting; USB data is not touched.
printf '/dev/root / ext4 rw 0 0\n' > "$NF_MOUNTS"
echo 'changed while USB absent' >> "$DIR/hist.coarse"
if persist_check; then fail "detect USB removal during periodic check"; else pass "detect USB removal during periodic check"; fi
[ "$persist_ok" = 0 ] && pass "periodic check marks persistence unavailable" || fail "periodic check marks persistence unavailable"
grep -q 'old persistent history' "$PERSIST_DIR/hist.coarse" && grep -q 'new RAM history' "$PERSIST_DIR/hist.coarse" && pass "existing USB data is not overwritten while unmounted" || fail "existing USB data is not overwritten while unmounted"

# Reconnect: history is merged, already synchronized daily totals are not double-counted.
printf '/dev/root / ext4 rw 0 0\n/dev/sda1 %s exfat rw 0 0\n' "$T/usb" > "$NF_MOUNTS"
if persist_check; then pass "persistence resumes immediately after remount check"; else fail "persistence resumes immediately after remount check"; fi
grep -q 'old persistent history' "$PERSIST_DIR/hist.coarse" && grep -q 'new RAM history' "$PERSIST_DIR/hist.coarse" && grep -q 'changed while USB absent' "$PERSIST_DIR/hist.coarse" && pass "old and new history survives remount" || fail "old and new history survives remount"
grep -q '^192\.168\.1\.2 130 240$' "$PERSIST_DIR/dev.day" && pass "daily counters are not double-counted on repeated remount" || fail "daily counters are not double-counted on repeated remount"

# A fresh RAM directory can restore the archived history.
rm -f "$DIR/hist.coarse"
persist_need_restore=1
restore
grep -q 'changed while USB absent' "$DIR/hist.coarse" && pass "history restore works from mounted USB" || fail "history restore works from mounted USB"

# PERSIST_ANY may allow a custom non-root mount, but never root/overlay.
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
 "$PERSIST_DIR/apps.hist" && pass "historical application counters are merged" || fail "historical application counters are merged"
[ "$persist_ok" = 1 ] && pass "storage status returns to available" || fail "storage status returns to available"

# Disconnect again: RAM keeps collecting; USB data is not touched.
printf '/dev/root / ext4 rw 0 0\n' > "$NF_MOUNTS"
echo 'changed while USB absent' >> "$DIR/hist.coarse"
if persist_check; then fail "detect USB removal during periodic check"; else pass "detect USB removal during periodic check"; fi
[ "$persist_ok" = 0 ] && pass "periodic check marks persistence unavailable" || fail "periodic check marks persistence unavailable"
grep -q 'old persistent history' "$PERSIST_DIR/hist.coarse" && grep -q 'new RAM history' "$PERSIST_DIR/hist.coarse" && pass "existing USB data is not overwritten while unmounted" || fail "existing USB data is not overwritten while unmounted"

# Reconnect: history is merged, already synchronized daily totals are not double-counted.
printf '/dev/root / ext4 rw 0 0\n/dev/sda1 %s exfat rw 0 0\n' "$T/usb" > "$NF_MOUNTS"
if persist_check; then pass "persistence resumes immediately after remount check"; else fail "persistence resumes immediately after remount check"; fi
grep -q 'old persistent history' "$PERSIST_DIR/hist.coarse" && grep -q 'new RAM history' "$PERSIST_DIR/hist.coarse" && grep -q 'changed while USB absent' "$PERSIST_DIR/hist.coarse" && pass "old and new history survives remount" || fail "old and new history survives remount"
grep -q '^192\.168\.1\.2 130 240$' "$PERSIST_DIR/dev.day" && pass "daily counters are not double-counted on repeated remount" || fail "daily counters are not double-counted on repeated remount"

# A fresh RAM directory can restore the archived history.
rm -f "$DIR/hist.coarse"
persist_need_restore=1
restore
grep -q 'changed while USB absent' "$DIR/hist.coarse" && pass "history restore works from mounted USB" || fail "history restore works from mounted USB"

# PERSIST_ANY may allow a custom non-root mount, but never root/overlay.
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
 "$PERSIST_DIR/apps.day" && pass "application daily counters are added" || fail "application daily counters are added"
grep -q '^20261117 10300 20400$' "$PERSIST_DIR/traffic.daily" && pass "WAN daily counters are added" || fail "WAN daily counters are added"
grep -q '^20261116 192\.168\.1\.2 550 660 aa:bb:cc:dd:ee:ff$' "$PERSIST_DIR/dev.daily" && pass "historical device counters are merged" || fail "historical device counters are merged"
grep -q '^20261116|192\.168\.1\.2|video|770|880$' "$PERSIST_DIR/apps.hist" && pass "historical application counters are merged" || fail "historical application counters are merged"
[ "$persist_ok" = 1 ] && pass "storage status returns to available" || fail "storage status returns to available"

# Disconnect again: RAM keeps collecting; USB data is not touched.
printf '/dev/root / ext4 rw 0 0\n' > "$NF_MOUNTS"
echo 'changed while USB absent' >> "$DIR/hist.coarse"
if persist_check; then fail "detect USB removal during periodic check"; else pass "detect USB removal during periodic check"; fi
[ "$persist_ok" = 0 ] && pass "periodic check marks persistence unavailable" || fail "periodic check marks persistence unavailable"
grep -q 'old persistent history' "$PERSIST_DIR/hist.coarse" && grep -q 'new RAM history' "$PERSIST_DIR/hist.coarse" && pass "existing USB data is not overwritten while unmounted" || fail "existing USB data is not overwritten while unmounted"

# Reconnect: history is merged, already synchronized daily totals are not double-counted.
printf '/dev/root / ext4 rw 0 0\n/dev/sda1 %s exfat rw 0 0\n' "$T/usb" > "$NF_MOUNTS"
if persist_check; then pass "persistence resumes immediately after remount check"; else fail "persistence resumes immediately after remount check"; fi
grep -q 'old persistent history' "$PERSIST_DIR/hist.coarse" && grep -q 'new RAM history' "$PERSIST_DIR/hist.coarse" && grep -q 'changed while USB absent' "$PERSIST_DIR/hist.coarse" && pass "old and new history survives remount" || fail "old and new history survives remount"
grep -q '^192\.168\.1\.2 130 240$' "$PERSIST_DIR/dev.day" && pass "daily counters are not double-counted on repeated remount" || fail "daily counters are not double-counted on repeated remount"

# A fresh RAM directory can restore the archived history.
rm -f "$DIR/hist.coarse"
persist_need_restore=1
restore
grep -q 'changed while USB absent' "$DIR/hist.coarse" && pass "history restore works from mounted USB" || fail "history restore works from mounted USB"

# PERSIST_ANY may allow a custom non-root mount, but never root/overlay.
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
