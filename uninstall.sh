#!/bin/sh
# Удаление Nightfall с роутера (OpenWrt, busybox sh). Запускать прямо на роутере:
#
#   wget -qO- https://raw.githubusercontent.com/Nikolai752/nightfall-openwrt/main/uninstall.sh | sh
#   (или curl -fsSL ... | sh)
#
# По умолчанию: возвращает стандартную тему и полностью убирает Nightfall: тему, «Монитор ресурсов»,
# Telegram-бота, сборщик истории, пункты меню (в том числе «Nightfall: все элементы»), права rpcd,
# записи в настройках LuCI и кэш. Ваши НАСТРОЙКИ и данные (/etc/nightfall-*) остаются, чтобы при
# повторной установке всё вернулось.
#
# Параметры (после «| sh -s --»):
#   --theme-only   только вернуть стандартную тему, файлы не трогать
#   --wipe         удалить всё, включая настройки, списки устройств, журнал и токен бота
#   --purge        то же, что без параметров (оставлено для совместимости)
#   -h, --help     эта справка
#
# Для тестов: NF_ROOT (корень вместо /).

ROOT=${NF_ROOT:-}
THEME_ONLY=0; WIPE=0
for a in "$@"; do
	case "$a" in
	--theme-only) THEME_ONLY=1 ;;
	--wipe|--all) WIPE=1 ;;
	--purge) ;;
	-h|--help)
		cat <<'EOT'
Удаление Nightfall: wget -qO- https://raw.githubusercontent.com/Nikolai752/nightfall-openwrt/main/uninstall.sh | sh
Параметры (после «| sh -s --»):
  --theme-only   только вернуть стандартную тему, файлы не трогать
  --wipe         удалить всё, включая настройки, списки устройств, журнал и токен бота
  --purge        то же, что без параметров (для совместимости)
  -h, --help     эта справка
Без параметров: тема, монитор, бот, меню, права и кэш удаляются, ваши настройки (/etc/nightfall-*) остаются.
EOT
		exit 0 ;;
	*) echo "ОШИБКА: неизвестный параметр: $a (справка: --help)" >&2; exit 2 ;;
	esac
done
has() { command -v "$1" >/dev/null 2>&1; }

# 1. вернуть стандартную тему, если сейчас выбрана Nightfall
if has uci && [ -z "$ROOT" ]; then
	cur=$(uci -q get luci.main.mediaurlbase)
	case "$cur" in
	*[Nn]ightfall*|"")
		if [ -d /www/luci-static/bootstrap ]; then
			new=/luci-static/bootstrap
		else
			new=$(uci -q show luci.themes | grep -v -i nightfall | sed -n "s/.*='\(\/luci-static\/[^']*\)'.*/\1/p" | head -n1)
		fi
		if [ -n "$new" ]; then
			uci set luci.main.mediaurlbase="$new" && uci commit luci && echo "Тема переключена на $new"
		else
			echo "Внимание: другой темы не нашлось, выберите её в «Система → Система → Язык и стиль»."
		fi ;;
	*) echo "Сейчас выбрана не Nightfall ($cur), тему не меняю." ;;
	esac
fi

if [ "$THEME_ONLY" = 0 ]; then
	# 2. вернуть системные изменения (dnsmasq/sysctl учёта по приложениям, правила блокировки)
	if [ -z "$ROOT" ]; then
		[ -x /usr/libexec/nightfall-apps ] && /usr/libexec/nightfall-apps disable >/dev/null 2>&1
		has nft && nft delete table inet nightfall 2>/dev/null
		# 3. остановить сборщик и бота (в том числе процессы вне procd)
		if [ -x /etc/init.d/nightfall-collector ]; then
			/etc/init.d/nightfall-collector stop 2>/dev/null
			/etc/init.d/nightfall-collector disable 2>/dev/null
		fi
		for p in /proc/[0-9]*; do
			pid=${p#/proc/}; [ "$pid" = "$$" ] && continue
			cmd=$( { tr '\0' ' ' < "$p/cmdline"; } 2>/dev/null )
			case "$cmd" in *"/usr/libexec/nightfall-"*) kill "$pid" 2>/dev/null ;; esac
		done
	fi

	# 4. файлы
	rm -rf "$ROOT/www/luci-static/nightfall" "$ROOT/www/luci-static/nightfall-light" "$ROOT/www/luci-static/nightfall-dark" \
	       "$ROOT/www/luci-static/resources/menu-nightfall.js" "$ROOT/www/luci-static/resources/nightfall-"*.js \
	       "$ROOT/www/luci-static/resources/view/nightfall" \
	       "$ROOT/usr/share/ucode/luci/template/themes/nightfall" "$ROOT/usr/share/ucode/luci/template/themes/nightfall-light" \
	       "$ROOT/usr/share/ucode/luci/template/themes/nightfall-dark" \
	       "$ROOT"/usr/libexec/nightfall-* "$ROOT/etc/init.d/nightfall-collector" "$ROOT/etc/nightfall-release.pub" \
	       "$ROOT/usr/share/nightfall" \
	       "$ROOT/usr/share/luci/menu.d/luci-app-nightfall-monitor.json" "$ROOT/usr/share/luci/menu.d/luci-theme-nightfall.json" \
	       "$ROOT/usr/share/rpcd/acl.d/luci-app-nightfall-monitor.json" \
	       "$ROOT/etc/uci-defaults/30_luci-theme-nightfall" "$ROOT/etc/uci-defaults/40_nightfall-collector" \
	       "$ROOT/etc/sysctl.d/99-nightfall-acct.conf" "$ROOT/etc/nightfall-apps.prev" "$ROOT"/lib/upgrade/keep.d/nightfall-* \
	       "$ROOT/tmp/nightfall" "$ROOT"/tmp/nightfall-* 2>/dev/null
	if [ "$WIPE" = 1 ]; then
		rm -f "$ROOT"/etc/nightfall-* 2>/dev/null
	fi

	# 5. записи в настройках LuCI
	if has uci && [ -z "$ROOT" ]; then
		uci -q delete luci.themes.Nightfall
		uci -q delete luci.themes.NightfallDark
		uci -q delete luci.themes.NightfallLight
		uci commit luci
	fi
fi

# 6. кэш LuCI и права
if [ -z "$ROOT" ]; then
	rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache 2>/dev/null
	/etc/init.d/rpcd reload 2>/dev/null || /etc/init.d/rpcd restart 2>/dev/null
fi

# 7. проверка: что осталось
if [ "$THEME_ONLY" = 0 ]; then
	left=$(find "$ROOT/www" "$ROOT/usr" "$ROOT/etc" "$ROOT/tmp" \( -name '*[Nn]ightfall*' \) 2>/dev/null | grep -v '^'"$ROOT"'/etc/nightfall-' | head -n 20)
	if [ -n "$left" ]; then
		echo "Внимание: остались файлы Nightfall:"; echo "$left"
	else
		echo "Файлы Nightfall удалены."
	fi
	keep=$(ls "$ROOT"/etc/nightfall-* 2>/dev/null | head -n 30)
	if [ -n "$keep" ] && [ "$WIPE" = 0 ]; then
		echo "Остались ваши настройки и данные (для повторной установки). Удалить их: добавьте --wipe"
	fi
else
	echo "Тема отключена, файлы остались. Удалить всё: запустите без --theme-only."
fi
echo "Готово. Обновите страницу браузера (Ctrl+F5), при необходимости выйдите из LuCI и войдите снова."
exit 0
