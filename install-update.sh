#!/bin/sh
# Обновление Nightfall на роутере (тема уже установлена).
#   Из интернета:  wget -qO- https://raw.githubusercontent.com/Nikolai752/nightfall-openwrt/main/install-update.sh | sh
#   Вручную:       scp -O nightfall-root.tar.gz install-update.sh root@192.168.1.1:/tmp/
#                  ssh root@192.168.1.1 'sh /tmp/install-update.sh'
set -e
REPO="Nikolai752/nightfall-openwrt"
T=/tmp/nightfall-root.tar.gz
[ -f "$T" ] || T=/tmp/nightfall-root_tar.gz
if [ ! -f "$T" ]; then
	T=/tmp/nightfall-root.tar.gz
	echo "Скачиваю архив с GitHub…"
	wget -qO "$T" "https://github.com/$REPO/releases/latest/download/nightfall-root.tar.gz" || { echo "Не удалось скачать архив. Загрузите nightfall-root.tar.gz в /tmp вручную."; exit 1; }
fi
tar -xzf "$T" -C /
chmod 755 /usr/libexec/nightfall-collector /usr/libexec/nightfall-history /usr/libexec/nightfall-config /usr/libexec/nightfall-speed /usr/libexec/nightfall-stats /usr/libexec/nightfall-update /usr/libexec/nightfall-apps /usr/libexec/nightfall-notify /usr/libexec/nightfall-bot /usr/libexec/nightfall-block /etc/init.d/nightfall-collector
# регистрация темы и включение сборщика (нужно при первой установке этой же командой)
for f in /etc/uci-defaults/30_luci-theme-nightfall /etc/uci-defaults/40_nightfall-collector; do
	[ -f "$f" ] && { sh "$f"; rm -f "$f"; }
done
rm -f /www/luci-static/resources/view/nightfall/sysauth.js
rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache 2>/dev/null || true
/etc/init.d/rpcd reload 2>/dev/null || /etc/init.d/rpcd restart 2>/dev/null || true
/etc/init.d/nightfall-collector restart 2>/dev/null || true
echo "Готово. Выйдите из LuCI и войдите снова (права обновляются при входе), затем Ctrl+F5."
echo "На iPhone закройте приложение с экрана «Домой» и откройте заново."
