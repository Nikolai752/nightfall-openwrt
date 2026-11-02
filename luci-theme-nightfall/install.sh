#!/bin/sh
# Установка темы Nightfall на OpenWrt 25.12 (LuCI).
# Использование на роутере:  sh install.sh [--activate]
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
tar -xzf "$DIR/luci-theme-nightfall-root.tar.gz" -C /
[ -x /etc/uci-defaults/30_luci-theme-nightfall ] || chmod +x /etc/uci-defaults/30_luci-theme-nightfall
sh /etc/uci-defaults/30_luci-theme-nightfall && rm -f /etc/uci-defaults/30_luci-theme-nightfall
if [ "$1" = "--activate" ]; then
	uci set luci.main.mediaurlbase=/luci-static/nightfall
	uci commit luci
fi
rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache 2>/dev/null || true
echo "Готово. Выберите тему: System → System → Language and Style → Nightfall"
