#!/bin/sh
# Откат Nightfall: возвращает стандартную тему Bootstrap.
# Запуск на роутере:  sh uninstall.sh          — только вернуть стандартную тему
#                     sh uninstall.sh --purge  — ещё и удалить все файлы Nightfall и монитор
set -e

# 1. вернуть стандартную тему (если Bootstrap установлен, иначе — первая доступная)
if [ -d /www/luci-static/bootstrap ]; then
	uci set luci.main.mediaurlbase=/luci-static/bootstrap
else
	other=$(uci show luci.themes 2>/dev/null | grep -v -i nightfall | sed -n "s/.*='\(\/luci-static\/[^']*\)'.*/\1/p" | head -n1)
	[ -n "$other" ] && uci set luci.main.mediaurlbase="$other"
fi
uci commit luci

# 2. по желанию — удалить файлы
if [ "$1" = "--purge" ]; then
	# вернуть настройки dnsmasq, если включали учёт трафика по приложениям
	[ -x /usr/libexec/nightfall-apps ] && /usr/libexec/nightfall-apps disable >/dev/null 2>&1 || true
	if [ -x /etc/init.d/nightfall-collector ]; then
		/etc/init.d/nightfall-collector stop 2>/dev/null || true
		/etc/init.d/nightfall-collector disable 2>/dev/null || true
	fi
	rm -rf /www/luci-static/nightfall /www/luci-static/nightfall-light /www/luci-static/nightfall-dark \
	       /www/luci-static/resources/menu-nightfall.js /www/luci-static/resources/view/nightfall \
	       /usr/share/ucode/luci/template/themes/nightfall /usr/share/ucode/luci/template/themes/nightfall-light \
	       /usr/share/ucode/luci/template/themes/nightfall-dark /usr/libexec/nightfall-stats \
	       /usr/libexec/nightfall-history /usr/libexec/nightfall-collector /usr/libexec/nightfall-config /usr/libexec/nightfall-speed /usr/libexec/nightfall-update /usr/libexec/nightfall-apps /etc/nightfall-release.pub /etc/nightfall-apps.prev /etc/init.d/nightfall-collector \
	       /usr/share/nightfall /tmp/nightfall \
	       /usr/share/luci/menu.d/luci-app-nightfall-monitor.json /usr/share/luci/menu.d/luci-theme-nightfall.json /usr/share/rpcd/acl.d/luci-app-nightfall-monitor.json
	# /etc/nightfall-monitor.conf и /etc/nightfall-prefs.json оставлены: там ваши настройки (удалите вручную, если не нужны)
	uci -q delete luci.themes.Nightfall
	uci -q delete luci.themes.NightfallDark
	uci -q delete luci.themes.NightfallLight
	uci commit luci
fi

rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache 2>/dev/null || true
/etc/init.d/rpcd reload 2>/dev/null || true
echo "Готово. Обновите страницу браузера (Ctrl+F5)."
[ "$1" = "--purge" ] && echo "Файлы Nightfall удалены." || echo "Тема отключена, файлы остались (удалить: sh uninstall.sh --purge)."
