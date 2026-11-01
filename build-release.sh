#!/bin/sh
# Собирает dist/nightfall-root.tar.gz — файлы, которые install.sh/install-update.sh раскладывают по роутеру.
# Запуск из корня репозитория:  sh build-release.sh
set -e
cd "$(dirname "$0")"
OUT=$(pwd)/dist
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
for pkg in luci-theme-nightfall luci-app-nightfall-monitor; do
	[ -d "$pkg/htdocs" ] && { mkdir -p "$STAGE/www"; cp -a "$pkg/htdocs/." "$STAGE/www/"; }
	[ -d "$pkg/root" ]   && cp -a "$pkg/root/." "$STAGE/"
	[ -d "$pkg/ucode" ]  && { mkdir -p "$STAGE/usr/share/ucode/luci"; cp -a "$pkg/ucode/." "$STAGE/usr/share/ucode/luci/"; }
done
# ссылки не хранятся в репозитории (ломаются на Windows), создаём их здесь
ln -s nightfall "$STAGE/www/luci-static/nightfall-light"
ln -s nightfall "$STAGE/www/luci-static/nightfall-dark"
ln -s nightfall "$STAGE/usr/share/ucode/luci/template/themes/nightfall-light"
ln -s nightfall "$STAGE/usr/share/ucode/luci/template/themes/nightfall-dark"
ln -s /etc/nightfall-prefs.json "$STAGE/www/luci-static/nightfall/prefs.json"
# права на исполнение (в git на Windows они теряются)
chmod 755 "$STAGE"/usr/libexec/nightfall-* "$STAGE"/etc/init.d/nightfall-collector "$STAGE"/etc/uci-defaults/* 2>/dev/null || true
mkdir -p "$OUT"
# владелец root:root, чтобы файлы на роутере не получили чужой uid
tar --owner=0 --group=0 --numeric-owner -czf "$OUT/nightfall-root.tar.gz" -C "$STAGE" . 2>/dev/null \
	|| tar -czf "$OUT/nightfall-root.tar.gz" -C "$STAGE" .
echo "Готово: $OUT/nightfall-root.tar.gz"
