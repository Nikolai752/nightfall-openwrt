#!/bin/sh
# Regression test for removal of stale WAN-subnet rows from archived device traffic.
set -eu
cd "$(dirname "$0")/.."
COLLECTOR="luci-app-nightfall-monitor/root/usr/libexec/nightfall-collector"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
sed -n '/^filter_dev_archive() {/,/^}/p' "$COLLECTOR" > "$TMP/filter.sh"
[ -s "$TMP/filter.sh" ] || { echo "FAIL: production archive filter not found"; exit 1; }
. "$TMP/filter.sh"
cat > "$TMP/router.nets" <<'NETS'
10.108.0.0/16
NETS
cat > "$TMP/dev.daily" <<'ROWS'
20261116 10.108.207.42 163031953452 9831118471 -
20261116 10.108.46.235 91728351537 4561692812 -
20261116 192.168.1.214 5743000000 5450000000 04:7c:16:17:ab:ea
20261116 8.8.8.8 1000 200 -
20261116 fd61:bde8:2d8d::805 500 100 -
ROWS
filter_dev_archive "$TMP/dev.daily" "$TMP/router.nets"
! grep -q '10\.108\.' "$TMP/dev.daily"
grep -q '192\.168\.1\.214' "$TMP/dev.daily"
grep -q '8\.8\.8\.8' "$TMP/dev.daily"
grep -q 'fd61:bde8:2d8d::805' "$TMP/dev.daily"
[ "$(wc -l < "$TMP/dev.daily" | tr -d ' ')" = 3 ]
echo "OK: stale WAN rows removed; LAN, public and IPv6 rows preserved."
