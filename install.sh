#!/bin/sh
# Установка темы Nightfall (Windows 11) и страницы «Монитор ресурсов» на OpenWrt 25.12.
# Запуск на роутере:  sh install.sh [--activate]
# Архив nightfall-root.tar.gz берётся из папки скрипта, а если его нет — скачивается с GitHub Releases.
set -e
REPO="Nikolai752/nightfall-openwrt"
DIR=$(cd "$(dirname "$0")" && pwd)
T="$DIR/nightfall-root.tar.gz"
if [ ! -f "$T" ]; then
	T=/tmp/nightfall-root.tar.gz
	echo "Скачиваю архив с GitHub…"
	wget -qO "$T" "https://github.com/$REPO/releases/latest/download/nightfall-root.tar.gz" || { echo "Не удалось скачать архив. Положите nightfall-root.tar.gz рядом со скриптом."; exit 1; }
fi
# остановить старый сборщик перед заменой файлов (при обновлении), включая процессы вне procd
[ -x /etc/init.d/nightfall-collector ] && /etc/init.d/nightfall-collector stop 2>/dev/null || true
for p in /proc/[0-9]*; do
	pid=${p#/proc/}
	[ "$pid" = "$$" ] && continue
	cmd=$( { tr '\0' ' ' < "$p/cmdline"; } 2>/dev/null )
	case "$cmd" in "/bin/sh /usr/libexec/nightfall-collector "*|"sh /usr/libexec/nightfall-collector "*) kill "$pid" 2>/dev/null ;; esac
done
sleep 1
tar -xzf "$T" -C /
chmod 755 /usr/libexec/nightfall-stats /usr/libexec/nightfall-history /usr/libexec/nightfall-collector /usr/libexec/nightfall-config /usr/libexec/nightfall-speed /usr/libexec/nightfall-update /usr/libexec/nightfall-apps /usr/libexec/nightfall-notify /usr/libexec/nightfall-bot /usr/libexec/nightfall-block /usr/libexec/nightfall-diag /usr/libexec/nightfall-guest /etc/init.d/nightfall-collector
for f in /etc/uci-defaults/30_luci-theme-nightfall /etc/uci-defaults/40_nightfall-collector; do
	[ -f "$f" ] && { sh "$f"; rm -f "$f"; }
done
if [ "$1" = "--activate" ]; then
	uci set luci.main.mediaurlbase=/luci-static/nightfall
	uci commit luci
fi
rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache 2>/dev/null || true
/etc/init.d/rpcd reload 2>/dev/null || true
echo "Готово. Тема: System → System → Language and Style → Nightfall."
echo "Монитор: Status → Монитор ресурсов (перезайдите в LuCI, если пункта нет)."
echo "Сборщик истории запущен (/etc/init.d/nightfall-collector), настройки: /etc/nightfall-monitor.conf"
echo "Для учёта трафика по устройствам: sysctl net.netfilter.nf_conntrack_acct (должно быть 1)."
