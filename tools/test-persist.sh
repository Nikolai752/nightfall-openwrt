#!/bin/sh
# Regression tests for persistent history, mount loss, recovery and internal flash opt-in.
set -eu
cd "$(dirname "$0")/.."
COLLECTOR="luci-app-nightfall-monitor/root/usr/libexec/nightfall-collector"
CONFIG="luci-app-nightfall-monitor/root/usr/libexec/nightfall-config"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT HUP INT TERM
mkdir -p "$T/usb/nightfall" "$T/ram"
: > "$T/events"

# Existing archive on USB.
echo 'old persistent history' > "$T/usb/nightfall/hist.coarse"
echo '20261117' > "$T/usb/nightfall/day.date"
echo '192.168.1.2 100 200' > "$T/usb/nightfall/dev.day"
echo '192.168.1.2|video|Direct|1000|2000' > "$T/usb/nightfall/apps.day"
echo '2' > "$T/usb/nightfall/apps.v"
echo '20261117 10000 20000' > "$T/usb/nightfall/traffic.daily"
echo '20261116 192.168.1.2 500 600 aa:bb:cc:dd:ee:ff' > "$T/usb/nightfall/dev.daily"
echo '20261116|192.168.1.2|video|Direct|700|800' > "$T/usb/nightfall/apps.hist"

# Extract the production persistence functions; tests exercise the real collector logic.
awk '
  /^PFILES=/ { print; next }
  /^(persist_mount_info|on_flash|persist_overlay_space_ok|persist_warn|persist|persist_check|restore)\(\) \{/ { inside=1 }
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
expect_external() { if on_flash "$1"; then fail "$2"; else pass "$2"; fi; }
expect_internal() { if on_flash "$1"; then pass "$2"; else fail "$2"; fi; }

# Unmounted USB resolves to root: never create a fallback directory there.
printf '/dev/root / ext4 rw 0 0\n' > "$NF_MOUNTS"
expect_internal "$PERSIST_DIR" "unmounted USB path resolves to root filesystem"
PERSIST_DIR="$T/not-mounted/nightfall"
if persist; then fail "do not create a missing USB path on root storage"; else pass "do not create a missing USB path on root storage"; fi
[ ! -e "$T/not-mounted" ] && pass "no fallback directory is created on root storage" || fail "no fallback directory is created on root storage"
PERSIST_DIR="$T/usb/nightfall"

# RAM data collected while USB is unavailable.
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

# USB returns: merge history and counters exactly once.
printf '/dev/root / ext4 rw 0 0\n/dev/sda1 %s exfat rw 0 0\n' "$T/usb" > "$NF_MOUNTS"
expect_external "$PERSIST_DIR" "USB mount is recognized through nested data directory"
if persist; then pass "persistence resumes after USB mount returns"; else fail "persistence resumes after USB mount returns"; fi
grep -q 'old persistent history' "$PERSIST_DIR/hist.coarse" && grep -q 'new RAM history' "$PERSIST_DIR/hist.coarse" && pass "USB and RAM history are merged" || fail "USB and RAM history are merged"
grep -q '^192\.168\.1\.2 130 240$' "$PERSIST_DIR/dev.day" && pass "device daily counters are added" || fail "device daily counters are added"
grep -q '^192\.168\.1\.2|video|Direct|1300|2400$' "$PERSIST_DIR/apps.day" && pass "application daily counters are added" || fail "application daily counters are added"
grep -q '^20261117 10300 20400$' "$PERSIST_DIR/traffic.daily" && pass "WAN daily counters are added" || fail "WAN daily counters are added"
grep -q '^20261116 192\.168\.1\.2 550 660 aa:bb:cc:dd:ee:ff$' "$PERSIST_DIR/dev.daily" && pass "historical device counters are merged" || fail "historical device counters are merged"
grep -q '^20261116|192\.168\.1\.2|video|Direct|770|880$' "$PERSIST_DIR/apps.hist" && pass "historical application counters are merged" || fail "historical application counters are merged"
[ "$persist_ok" = 1 ] && pass "storage status returns to available" || fail "storage status returns to available"

# Disconnect, collect in RAM, reconnect and verify no double-counting.
printf '/dev/root / ext4 rw 0 0\n' > "$NF_MOUNTS"
echo 'changed while USB absent' >> "$DIR/hist.coarse"
if persist_check; then fail "detect USB removal"; else pass "detect USB removal"; fi
[ "$persist_ok" = 0 ] && pass "storage status marks unavailable" || fail "storage status marks unavailable"
grep -q 'old persistent history' "$PERSIST_DIR/hist.coarse" && grep -q 'new RAM history' "$PERSIST_DIR/hist.coarse" && pass "USB archive is untouched while unmounted" || fail "USB archive is untouched while unmounted"
printf '/dev/root / ext4 rw 0 0\n/dev/sda1 %s exfat rw 0 0\n' "$T/usb" > "$NF_MOUNTS"
if persist_check; then pass "persistence resumes after remount"; else fail "persistence resumes after remount"; fi
grep -q 'changed while USB absent' "$PERSIST_DIR/hist.coarse" && pass "RAM history survives remount" || fail "RAM history survives remount"
grep -q '^192\.168\.1\.2 130 240$' "$PERSIST_DIR/dev.day" && pass "daily totals are not double-counted" || fail "daily totals are not double-counted"
rm -f "$DIR/hist.coarse"
persist_need_restore=1
restore
grep -q 'changed while USB absent' "$DIR/hist.coarse" && pass "history restores from mounted USB" || fail "history restores from mounted USB"

# PERSIST_ANY may allow an explicitly selected custom non-root mount.
printf '/dev/root / ext4 rw 0 0\n/dev/mapper/data %s ext4 rw 0 0\n' "$T/usb" > "$NF_MOUNTS"
PERSIST_ANY=0
expect_internal "$PERSIST_DIR" "unknown block source denied by default"
PERSIST_ANY=1
expect_external "$PERSIST_DIR" "PERSIST_ANY permits a custom non-root mount"

# Internal overlay is opt-in; root and ROM remain prohibited even with opt-in.
printf '/dev/root / ext4 rw 0 0\n/dev/ubi0_1 /overlay ubifs rw 0 0\n' > "$NF_MOUNTS"
PERSIST_DIR=/overlay/nightfall
PERSIST_ANY=0
expect_internal "$PERSIST_DIR" "internal overlay denied without opt-in"
PERSIST_ANY=1
expect_external "$PERSIST_DIR" "explicit opt-in permits internal overlay"

# Internal flash must retain at least 2 MiB for the router.
cat > "$T/df-low" <<'DF'
#!/bin/sh
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/ubi0_1 20000 19000 1000 95%% /overlay\n'
DF
cat > "$T/df-high" <<'DF'
#!/bin/sh
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/ubi0_1 20000 15000 5000 75%% /overlay\n'
DF
chmod +x "$T/df-low" "$T/df-high"
NF_DF="$T/df-low" NF_PERSIST_MIN_FREE_KB=2048
if persist_overlay_space_ok /overlay; then fail "deny internal flash with less than 2 MiB free"; else pass "deny internal flash with less than 2 MiB free"; fi
NF_DF="$T/df-high"
if persist_overlay_space_ok /overlay; then pass "allow internal flash when reserve is available"; else fail "allow internal flash when reserve is available"; fi
PERSIST_DIR="$T/rootdata"
printf '/dev/root / ext4 rw 0 0\n' > "$NF_MOUNTS"
expect_internal "$PERSIST_DIR" "PERSIST_ANY never permits root filesystem"
PERSIST_DIR=/rom/nightfall
printf '/dev/root / ext4 rw 0 0\n/dev/root /rom squashfs ro 0 0\n' > "$NF_MOUNTS"
expect_internal "$PERSIST_DIR" "PERSIST_ANY never permits ROM"

# Legacy app rows without the route-aware schema marker are not merged.
printf '/dev/root / ext4 rw 0 0\n/dev/sda1 %s exfat rw 0 0\n' "$T/usb" > "$NF_MOUNTS"
PERSIST_DIR="$T/usb/legacy"
DIR="$T/ram-legacy"
mkdir -p "$PERSIST_DIR" "$DIR"
PFILES="apps.day apps.hist apps.v"
echo '192.168.1.2|video|900|901' > "$PERSIST_DIR/apps.day"
echo '20261116|192.168.1.2|video|700|701' > "$PERSIST_DIR/apps.hist"
echo '192.168.1.2|video|Direct|100|101' > "$DIR/apps.day"
echo '20261117|192.168.1.2|video|Direct|200|201' > "$DIR/apps.hist"
echo '2' > "$DIR/apps.v"
persist_need_restore=1
restore
grep -q '^192\.168\.1\.2|video|Direct|100|101$' "$DIR/apps.day" && pass "legacy daily app rows are not merged" || fail "legacy daily app rows are not merged"
grep -q '^20261117|192\.168\.1\.2|video|Direct|200|201$' "$DIR/apps.hist" && pass "legacy app history rows are not merged" || fail "legacy app history rows are not merged"
[ "$(cat "$DIR/apps.v")" = 2 ] && pass "route-aware app schema marker is preserved" || fail "route-aware app schema marker is preserved"

# Configuration validation must require opt-in for /overlay and always reject /.
printf 'PERSIST_ANY=0\n' > "$T/config.default"
if NF_CONF="$T/config" NF_DEF="$T/config.default" NF_NORESTART=1 "$CONFIG" set PERSIST_DIR=/overlay/nightfall PERSIST_ANY=0 > "$T/config-denied"; then :; fi
grep -q '"ok":false' "$T/config-denied" || { echo "FAIL: /overlay accepted without opt-in" >&2; exit 1; }
NF_CONF="$T/config" NF_DEF="$T/config.default" NF_NORESTART=1 "$CONFIG" set PERSIST_DIR=/overlay/nightfall PERSIST_ANY=1 > "$T/config-allowed"
grep -q '"ok":true' "$T/config-allowed" || { cat "$T/config-allowed"; echo "FAIL: /overlay rejected with opt-in" >&2; exit 1; }
if NF_CONF="$T/config" NF_DEF="$T/config.default" NF_NORESTART=1 "$CONFIG" set PERSIST_DIR=/ PERSIST_ANY=1 > "$T/config-root"; then :; fi
grep -q '"ok":false' "$T/config-root" || { echo "FAIL: root path accepted" >&2; exit 1; }

echo
echo "ИТОГО: ok=$ok, ошибок=$bad"
[ "$bad" -eq 0 ]
