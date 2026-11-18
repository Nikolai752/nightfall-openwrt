#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
HELPER="$ROOT/luci-app-nightfall-monitor/root/usr/libexec/nightfall-dns-map"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
NOW=1795032000
printf '192.0.2.1|StaleApp|%s\n192.0.2.2|FreshApp|%s\n192.0.2.3|Прочее · okcdn.ru|%s\n192.0.2.4|Прочее · rtbcdn.ru|%s\n' "$((NOW-30000))" "$((NOW-60))" "$((NOW-60))" "$((NOW-60))" > "$TMP/map"
cat > "$TMP/dns.log" <<'LOG'
Nov 18 19:10:58 dnsmasq[1]: query[A] www.youtube.com from 127.0.0.1
Nov 18 19:10:58 dnsmasq[1]: reply www.youtube.com is <CNAME>
Nov 18 19:10:58 dnsmasq[1]: reply r1---sn.googlevideo.com is 203.0.113.10
Nov 18 19:10:59 dnsmasq[1]: query[A] api.unknown.example.com from 127.0.0.1
Nov 18 19:10:59 dnsmasq[1]: reply api.unknown.example.com is 203.0.113.11
Nov 18 19:11:00 dnsmasq[1]: query[A] static.netflix.com from 127.0.0.1
Nov 18 19:11:00 dnsmasq[1]: reply static.netflix.com is 203.0.113.12
Nov 18 19:11:01 dnsmasq[1]: query[A] video.youtube.com from 127.0.0.1
Nov 18 19:11:01 dnsmasq[1]: reply video.youtube.com is 203.0.113.12
LOG
sh "$HELPER" "$ROOT/luci-app-nightfall-monitor/root/usr/share/nightfall/apps.list" "$TMP/no-user-rules" "$TMP/map" "$NOW" < "$TMP/dns.log"
has() { grep -Fqx "$1" "$TMP/map" || { echo "FAIL: missing $1" >&2; cat "$TMP/map" >&2; exit 1; }; }
lacks() { grep -Fq "$1" "$TMP/map" && { echo "FAIL: unexpected $1" >&2; exit 1; } || :; }
has "192.0.2.2|FreshApp|$NOW"
has "192.0.2.3|Одноклассники|$NOW"
has "192.0.2.4|Прочее · rtbcdn.ru|$NOW"
lacks "192.0.2.1|"
has "203.0.113.10|YouTube|$NOW"
has "203.0.113.11|Прочее · example.com|$NOW"
has "203.0.113.12|Netflix|$NOW"
has "203.0.113.12|YouTube|$NOW"
echo "DNS application map tests: all passed."
