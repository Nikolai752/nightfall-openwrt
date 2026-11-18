#!/bin/sh
# Проверка перед релизом: ./tools/check.sh [предыдущий_тег]
# Ловит усечённый CSS/JS, битые скобки, синтаксис JS и sh.
cd "$(dirname "$0")/.." || exit 1
fail=0
err() { echo "ОШИБКА: $*"; fail=1; }
T=luci-theme-nightfall/htdocs/luci-static
M=luci-app-nightfall-monitor/htdocs/luci-static
FILES="$T/nightfall/cascade.css $T/nightfall/mobile.css $T/nightfall/nightfall.js $T/nightfall/nightfall-empty.js $T/resources/nightfall-overview.js $M/resources/view/nightfall/monitor.js"

prev=${1:-$(git tag --sort=-v:refname 2>/dev/null | head -1)}
echo "== Размеры (сравнение с ${prev:-—}) =="
for f in $FILES; do
  [ -f "$f" ] || { err "нет файла $f"; continue; }
  now=$(wc -c < "$f")
  old=0
  [ -n "$prev" ] && old=$(git show "$prev:$f" 2>/dev/null | wc -c)
  echo "$f: $now (было $old)"
  # усадка более чем на 10% — подозрение на усечение
  if [ "$old" -gt 0 ] && [ $((now * 100 / old)) -lt 90 ]; then err "$f уменьшился более чем на 10%"; fi
done

echo "== Баланс скобок CSS =="
for f in $T/nightfall/*.css; do
  o=$(tr -cd '{' < "$f" | wc -c); c=$(tr -cd '}' < "$f" | wc -c)
  [ "$o" = "$c" ] && echo "$f: ok ($o)" || err "$f: { = $o, } = $c"
done

echo "== node --check =="
if command -v node >/dev/null; then
  for f in $(find luci-theme-nightfall luci-app-nightfall-monitor -name '*.js'); do
    node --check "$f" 2>/dev/null || {
      # LuCI-модули используют 'require ...' строки — это валидный JS; ошибка настоящая
      err "синтаксис JS: $f"; }
  done
fi

echo "== sh -n =="
for f in luci-app-nightfall-monitor/root/usr/libexec/* *.sh; do
  head -1 "$f" | grep -q 'sh' || continue
  sh -n "$f" 2>/dev/null || err "sh: $f"
done

echo "== Параметры монитора: у каждого есть значение по умолчанию =="
DEFC=luci-app-nightfall-monitor/root/usr/share/nightfall/nightfall-monitor.conf.default
for k in $(sed -n 's/^KEYS="\(.*\)"/\1/p' luci-app-nightfall-monitor/root/usr/libexec/nightfall-config); do
  grep -q "^$k=" "$DEFC" || err "в $DEFC нет строки $k (страница покажет пустое поле и не сохранится)"
done

echo "== VPN accounting ==\n"
sh tools/test-vpn-accounting.sh || err "проверка VPN accounting"

echo "== Application catalog ==\n"
sh tools/test-app-catalog.sh || err "проверка каталога приложений"
echo "== DNS app map ==\n"
sh tools/test-dns-map.sh || err "проверка DNS-карты приложений"
if command -v node >/dev/null; then node tools/test-app-traffic-ui.js || err "проверка интерфейса статистики приложений"; fi
if command -v node >/dev/null; then node tools/test-app-traffic-monitor.js || err "проверка вкладки трафика монитора"; fi

echo "== Версия кэша =="
b=$(grep -o '[0-9]\{8\}[a-z]' luci-theme-nightfall/ucode/template/themes/nightfall/header.ut | sort -u)
echo "$b"
[ "$(echo "$b" | wc -l)" = 1 ] || err "в header.ut разные версии кэша"

echo "== Версия темы =="
cv=$(sed -n 's/^## v\([0-9][0-9.]*\).*/\1/p' CHANGELOG.md | head -n 1)
vv=$(sed -n 's/.*"version"[^"]*"\([^"]*\)".*/\1/p' luci-theme-nightfall/htdocs/luci-static/nightfall/version.json)
echo "CHANGELOG: $cv, version.json: $vv"
[ -n "$cv" ] && [ "$cv" = "$vv" ] || err "version.json ($vv) не совпадает с верхней записью CHANGELOG.md ($cv)"

[ $fail = 0 ] && echo "ВСЁ В ПОРЯДКЕ" || { echo "ЕСТЬ ОШИБКИ"; exit 1; }
