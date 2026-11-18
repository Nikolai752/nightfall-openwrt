#!/bin/sh
set -eu
SRC="luci-theme-nightfall/htdocs/luci-static/nightfall/nightfall.js"
grep -q "ACKKEY = 'nightfall-whatsnew-ack-v1'" "$SRC"
grep -q "function versionParts(s)" "$SRC"
grep -q "if (x.pre && !y.pre) return true" "$SRC"
grep -q "var legacy = !ack && !!seen;" "$SRC"
grep -q "lsSet(ACKKEY, cur); lsSet(SEENKEY, cur); closeUpd();" "$SRC"
grep -q "catch(function () { /\* не отмечаем просмотренным: повторим после следующего входа \*/ });" "$SRC"
node tools/test-whats-new.js
echo "Проверка восстановления окна «Что нового» пройдена."
grep -q "function showWhatsNew()" "$SRC"
grep -q "text: 'Что нового', onclick: showWhatsNew" "$SRC"
grep -q "Не подтверждаем просмотр: возможно, CHANGELOG ещё не опубликован" "$SRC"
sh tools/check-release.sh v1.27.12
if sh tools/check-release.sh v9.9.9 >/dev/null 2>&1; then
  echo "Ошибка: проверка пропустила релиз без раздела CHANGELOG" >&2
  exit 1
fi
