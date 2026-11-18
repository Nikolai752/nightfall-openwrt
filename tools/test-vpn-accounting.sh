#!/bin/sh
# Проверка разделения известного VPN-туннеля от обычных приложений.
set -eu
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
COLLECTOR=luci-app-nightfall-monitor/root/usr/libexec/nightfall-collector
CONFIG=luci-app-nightfall-monitor/root/usr/libexec/nightfall-config
DEF=luci-app-nightfall-monitor/root/usr/share/nightfall/nightfall-monitor.conf.default

# Проверяем именно функцию appof() из production-сборщика.
sed -n '/function appof(ip, port/,/^[[:space:]]*}/p' "$COLLECTOR" > "$TMP/appof.awk"
cat >> "$TMP/appof.awk" <<'AWK'
BEGIN {
  am["8.8.8.8"] = "Google"
  vpns = "195.19.105.24:44444,203.0.113.8:443"
  if (appof("195.19.105.24", "44444") != "VPN") exit 1
  if (appof("195.19.105.24", "443") != "Прочее") exit 1
  if (appof("8.8.8.8", "443") != "Google") exit 1
  if (appof("203.0.113.8", "443") != "VPN") exit 1
  print "VPN endpoint classification: OK"
}
AWK
awk -f "$TMP/appof.awk"

# Проверяем безопасную валидацию и сохранение настроек через штатный конфигуратор.
cp "$DEF" "$TMP/default"
NF_CONF="$TMP/config" NF_DEF="$TMP/default" NF_NORESTART=1 sh "$CONFIG" set VPN_ENDPOINTS=195.19.105.24:44444,203.0.113.8:443 | grep -q '"ok":true'
grep -q '^VPN_ENDPOINTS=195.19.105.24:44444,203.0.113.8:443$' "$TMP/config"
if NF_CONF="$TMP/config" NF_DEF="$TMP/default" NF_NORESTART=1 sh "$CONFIG" set VPN_ENDPOINTS='195.19.105.24:bad' | grep -q '"ok":true'; then
  echo "FAIL: invalid VPN endpoint was accepted"; exit 1
fi
grep -q '^VPN_ENDPOINTS=195.19.105.24:44444,203.0.113.8:443$' "$TMP/config"
sh -n "$COLLECTOR"
sh -n "$CONFIG"
echo "VPN traffic accounting tests: all passed."
