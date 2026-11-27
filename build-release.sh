#!/bin/sh
# Собирает dist/nightfall-root.tar.gz — файлы, которые install.sh/install-update.sh раскладывают по роутеру.
# Запуск из корня репозитория: VERSION=v1.29.1 PO2LMO=/path/to/po2lmo sh build-release.sh
set -eu
cd "$(dirname "$0")"
VERSION=${VERSION:-}
OUT=$(pwd)/dist
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

for pkg in luci-theme-nightfall luci-app-nightfall-monitor; do
	[ -d "$pkg/htdocs" ] && { mkdir -p "$STAGE/www"; cp -a "$pkg/htdocs/." "$STAGE/www/"; }
	[ -d "$pkg/root" ]   && cp -a "$pkg/root/." "$STAGE/"
	[ -d "$pkg/ucode" ]  && { mkdir -p "$STAGE/usr/share/ucode/luci"; cp -a "$pkg/ucode/." "$STAGE/usr/share/ucode/luci/"; }
done

# В исходном дереве уже есть семь штатных symlink. cp -a переносит их в staging,
# поэтому нельзя повторно вызывать ln -s поверх этих путей. Если ссылки отсутствуют
# (например, после нестандартной выгрузки исходников), создаём их; чужие пути не затираем.
ensure_symlink() {
	target=$1
	link=$2

	if [ -L "$link" ]; then
		actual=$(readlink "$link") || {
			echo "ОШИБКА: не удалось прочитать symlink: $link" >&2
			exit 1
		}
		[ "$actual" = "$target" ] || {
			echo "ОШИБКА: symlink $link указывает на '$actual', ожидалось '$target'; путь не изменён." >&2
			exit 1
		}
		return 0
	fi

	if [ -e "$link" ]; then
		echo "ОШИБКА: путь $link уже существует и не является symlink; путь не изменён." >&2
		exit 1
	fi

	mkdir -p "$(dirname "$link")"
	ln -s "$target" "$link"
}

ensure_symlink nightfall "$STAGE/www/luci-static/nightfall-light"
ensure_symlink nightfall "$STAGE/www/luci-static/nightfall-dark"
ensure_symlink nightfall "$STAGE/usr/share/ucode/luci/template/themes/nightfall-light"
ensure_symlink nightfall "$STAGE/usr/share/ucode/luci/template/themes/nightfall-dark"
ensure_symlink /etc/nightfall-prefs.json "$STAGE/www/luci-static/nightfall/prefs.json"
ensure_symlink /etc/nightfall-logo.json "$STAGE/www/luci-static/nightfall/logo.json"
ensure_symlink /etc/nightfall-bg.json "$STAGE/www/luci-static/nightfall/bg.json"

# LuCI использует скомпилированные LMO-каталоги, а не исходные .po.
# Для zh_Hans alias в LuCI — zh-cn; имена выходных файлов соответствуют
# luci.mk: <basename>.<language-alias>.lmo.
PO2LMO=${PO2LMO:-po2lmo}
I18N_COUNT=0
for pkg in luci-theme-nightfall luci-app-nightfall-monitor; do
	for po in "$pkg"/po/zh_Hans/*.po; do
		[ -f "$po" ] || continue
		command -v "$PO2LMO" >/dev/null 2>&1 || {
			echo "ОШИБКА: найден перевод $po, но po2lmo не найден. Выполните: PO2LMO=\$(sh tools/prepare-po2lmo.sh) sh build-release.sh" >&2
			exit 1
		}
		mkdir -p "$STAGE/usr/lib/lua/luci/i18n"
		name=$(basename "$po" .po)
		"$PO2LMO" "$po" "$STAGE/usr/lib/lua/luci/i18n/$name.zh-cn.lmo"
		[ -s "$STAGE/usr/lib/lua/luci/i18n/$name.zh-cn.lmo" ] || {
			echo "ОШИБКА: po2lmo не создал каталог перевода для $po." >&2
			exit 1
		}
		I18N_COUNT=$((I18N_COUNT + 1))
	done
done

if [ "$I18N_COUNT" -gt 0 ]; then
	mkdir -p "$STAGE/etc/uci-defaults"
	cat > "$STAGE/etc/uci-defaults/41_luci-i18n-nightfall-zh-cn" <<'EOF'
#!/bin/sh
uci -q set luci.languages.zh_cn='简体中文 (Simplified Chinese)' || exit 1
uci -q commit luci || exit 1
EOF
fi

# Версия темы для страницы «О теме»: из тега релиза (VERSION=v1.0.4), сборка = сегодняшняя дата.
V=${VERSION#v}
[ -n "$V" ] && printf '{ "version": "%s", "build": "%s" }\n' "$V" "$(date -u +%Y%m%d)" > "$STAGE/www/luci-static/nightfall/version.json"
# Версия кэша ассетов в header.ut (?v=…): после обновления браузер не держит старые CSS и JS.
H="$STAGE/usr/share/ucode/luci/template/themes/nightfall/header.ut"
[ -n "$V" ] && [ -f "$H" ] && sed -i -E "s/[0-9]{8}[a-z]/$V/g" "$H"
# История изменений: тема показывает её после обновления.
[ -f CHANGELOG.md ] && cp CHANGELOG.md "$STAGE/www/luci-static/nightfall/CHANGELOG.md"
# Права на исполнение (в git на Windows они теряются).
chmod 755 "$STAGE"/usr/libexec/nightfall-* "$STAGE"/etc/init.d/nightfall-collector "$STAGE"/etc/uci-defaults/* 2>/dev/null || true

mkdir -p "$OUT"
# Владелец root:root, чтобы файлы на роутере не получили чужой uid.
tar --owner=0 --group=0 --numeric-owner -czf "$OUT/nightfall-root.tar.gz" -C "$STAGE" . 2>/dev/null \
	|| tar -czf "$OUT/nightfall-root.tar.gz" -C "$STAGE" .
( cd "$OUT" && sha256sum nightfall-root.tar.gz > nightfall-root.tar.gz.sha256 )
echo "Готово: $OUT/nightfall-root.tar.gz (+ .sha256); LMO каталогов: $I18N_COUNT"
