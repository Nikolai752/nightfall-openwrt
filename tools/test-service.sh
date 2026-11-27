#!/bin/sh
# Static lifecycle guards for the procd collector and its runtime entry points.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
INIT="$ROOT/luci-app-nightfall-monitor/root/etc/init.d/nightfall-collector"
COLLECTOR="$ROOT/luci-app-nightfall-monitor/root/usr/libexec/nightfall-collector"
BACKUP="$ROOT/luci-app-nightfall-monitor/root/usr/libexec/nightfall-backup"
TGROUTE="$ROOT/luci-app-nightfall-monitor/root/usr/libexec/nightfall-telegram-route"
TGCONFIG="$ROOT/luci-app-nightfall-monitor/root/usr/libexec/nightfall-config"
TGACL="$ROOT/luci-app-nightfall-monitor/root/usr/share/rpcd/acl.d/luci-app-nightfall-monitor.json"
UPDATE="$ROOT/luci-app-nightfall-monitor/root/usr/libexec/nightfall-update"
UNINSTALL="$ROOT/uninstall.sh"

# Telegram routing: syntax, real Steer status adapter, per-socket mark and fail-closed egress guards.
sh -n "$TGROUTE"
grep -Fq '"$STEER" status' "$TGROUTE"
grep -Fq 'type route hook output priority mangle' "$TGROUTE"
grep -Fq 'meta mark set' "$TGROUTE"
grep -Fq 'meta skuid' "$TGROUTE"
grep -Fq 'oifname !=' "$TGROUTE"
grep -Fq 'uidrange' "$TGROUTE"
grep -Fq 'steer:*)' "$TGROUTE"
grep -Fq 'steer:*)' "$TGCONFIG"
grep -Fq 'nightfall-telegram-route' "$TGACL"
grep -Fq 'TG_ROUTE_MODE' "$TGCONFIG"

for f in "$INIT" "$COLLECTOR" "$BACKUP" "$UPDATE" "$UNINSTALL"; do
  sh -n "$f"
done

grep -Fq 'USE_PROCD=1' "$INIT"
grep -Fq 'procd_set_param command /usr/libexec/nightfall-collector' "$INIT"
grep -Fq 'procd_set_param respawn' "$INIT"
grep -Fq 'procd_set_param nice 10' "$INIT"
grep -Fq 'procd_set_param command /usr/libexec/nightfall-bot' "$INIT"
grep -Fq 'if [ "$(cfg TG)" = 1 ]' "$INIT"

# Lite mode must lower collection frequency and disable the two optional collectors.
grep -Fq 'if [ "$LITE" = 1 ]' "$COLLECTOR"
grep -Fq 'WIFI_HIST=0; APPS=0' "$COLLECTOR"

# Update and restore must have explicit rollback paths; uninstall must stop/disable procd.
grep -Fq 'rollback()' "$UPDATE"
grep -Fq 'исходные настройки возвращены' "$BACKUP"
grep -Fq '/etc/init.d/nightfall-collector stop' "$UNINSTALL"
grep -Fq '/etc/init.d/nightfall-collector disable' "$UNINSTALL"

echo "Nightfall service lifecycle checks passed"
