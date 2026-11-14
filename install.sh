#!/bin/sh
# Установка Nightfall. Оставлен для совместимости: всё делает install-update.sh (установка и обновление
# теперь один скрипт, версия определяется автоматически). Те же параметры: --activate, --force, --file, --help.
#   Из интернета:  wget -qO- https://raw.githubusercontent.com/Nikolai752/nightfall-openwrt/main/install-update.sh | sh
#   Вручную:       положите nightfall-root.tar.gz рядом со скриптами и выполните  sh install.sh [--activate]
DIR=$(cd "$(dirname "$0")" && pwd)
if [ -f "$DIR/install-update.sh" ]; then
	exec sh "$DIR/install-update.sh" "$@"
fi
S=/tmp/nightfall-install-update.$$.sh
trap 'rm -f "$S"' EXIT
URL=https://raw.githubusercontent.com/Nikolai752/nightfall-openwrt/main/install-update.sh
{ wget -qO "$S" "$URL" || curl -fsSL -o "$S" "$URL"; } 2>/dev/null || { echo "Не удалось скачать install-update.sh. Скачайте его рядом с этим файлом."; exit 1; }
sh "$S" "$@"
