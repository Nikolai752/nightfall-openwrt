#!/bin/sh
# Собирает dist/nightfall-root.tar.gz — файлы, которые install.sh/install-update.sh раскладывают по роутеру.
# Запуск из корня репозитория: sh build-release.sh
set -e
cd "$(dirname "$0")"
OUT=$(pwd)/dist
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# Compile LuCI PO catalogs into the LMO format used by LuCI at runtime.
# OpenWrt's po2lmo host utility must be supplied by the build environment.
PO2LMO_BIN=${PO2LMO:-$(command -v po2lmo || true)}
if [ -z "$PO2LMO_BIN" ] || [ ! -x "$PO2LMO_BIN" ]; then
	echo "Ошибка: не найден исполняемый po2lmo. Укажите PO2LMO=/path/to/po2lmo." >&2
	exit 1
fi

I18N_DIR="$STAGE/usr/lib/lua/luci/i18n"
mkdir -p "$I18N_DIR"

compile_po() {
	po_file="$1"
	output_file="$2"
	[ -s "$po_file" ] || {
		echo "Ошибка: PO-файл отсутствует или пуст: $po_file" >&2
		exit 1
	}
	"$PO2LMO_BIN" "$po_file" "$output_file"
	[ -s "$output_file" ] || {
		echo "Ошибка: po2lmo не создал файл: $output_file" >&2
		exit 1
	}
	echo "LMO: $output_file"
}

# Nightfall theme and monitor translations (zh_Hans is exposed by LuCI as zh-cn).
for pkg in luci-theme-nightfall luci-app-nightfall-monitor; do
	for po in "$pkg"/po/zh_Hans/*.po; do
		[ -f "$po" ] || continue
		name=$(basename "${po%.po}")
		compile_po "$po" "$I18N_DIR/$name.zh-cn.lmo"
	done
done

# The base LuCI catalog covers the standard Network/System/Status pages.
# The workflow supplies the catalog from the matching OpenWrt 25.12 LuCI branch.
if [ -n "${LUCI_BASE_PO:-}" ]; then
	compile_po "$LUCI_BASE_PO" "$I18N_DIR/base.zh-cn.lmo"
else
	echo "Предупреждение: LUCI_BASE_PO не задан — стандартный LuCI не будет переведён." >&2
fi

for pkg in luci-theme-nightfall luci-app-nightfall-monitor; do
	[ -d "$pkg/htdocs" ] && { mkdir -p "$STAGE/www"; cp -a "$pkg/htdocs/." "$STAGE/www/"; }
	[ -d "$pkg/root" ] && cp -a "$pkg/root/." "$STAGE/"
	[ -d "$pkg/ucode" ] && { mkdir -p "$STAGE/usr/share/ucode/luci"; cp -a "$pkg/ucode/." "$STAGE/usr/share/ucode/luci/"; }
done
# Normalize links: these are tracked in the PR as well as generated for source archives.
mkdir -p "$STAGE/www/luci-static" "$STAGE/www/luci-static/nightfall" "$STAGE/usr/share/ucode/luci/template/themes"
ln -sfn nightfall "$STAGE/www/luci-static/nightfall-light"
ln -sfn nightfall "$STAGE/www/luci-static/nightfall-dark"
ln -sfn nightfall "$STAGE/usr/share/ucode/luci/template/themes/nightfall-light"
ln -sfn nightfall "$STAGE/usr/share/ucode/luci/template/themes/nightfall-dark"
ln -sfn /etc/nightfall-prefs.json "$STAGE/www/luci-static/nightfall/prefs.json"
ln -sfn /etc/nightfall-logo.json "$STAGE/www/luci-static/nightfall/logo.json"
ln -sfn /etc/nightfall-bg.json "$STAGE/www/luci-static/nightfall/bg.json"
V=${VERSION#v}
[ -n "$V" ] && printf '{ "version": "%s", "build": "%s" }\n' "$V" "$(date -u +%Y%m%d)" > "$STAGE/www/luci-static/nightfall/version.json"
H="$STAGE/usr/share/ucode/luci/template/themes/nightfall/header.ut"
[ -n "$V" ] && [ -f "$H" ] && sed -i -E "s/[0-9]{8}[a-z]/$V/g" "$H"
[ -f CHANGELOG.md ] && cp CHANGELOG.md "$STAGE/www/luci-static/nightfall/CHANGELOG.md"
chmod 755 "$STAGE"/usr/libexec/nightfall-* "$STAGE"/etc/init.d/nightfall-collector "$STAGE"/etc/uci-defaults/* 2>/dev/null || true
mkdir -p "$OUT"
tar --owner=0 --group=0 --numeric-owner -czf "$OUT/nightfall-root.tar.gz" -C "$STAGE" . 2>/dev/null || tar -czf "$OUT/nightfall-root.tar.gz" -C "$STAGE" .
(cd "$OUT" && sha256sum nightfall-root.tar.gz > nightfall-root.tar.gz.sha256)
echo "Готово: $OUT/nightfall-root.tar.gz (+ .sha256)"
