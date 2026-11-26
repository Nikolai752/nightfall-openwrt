#!/bin/sh
# Собирает dist/nightfall-root.tar.gz — файлы, которые install.sh/install-update.sh раскладывают по роутеру.
# Запуск из корня репозитория: sh build-release.sh
set -e
cd "$(dirname "$0")"
OUT=$(pwd)/dist
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
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
