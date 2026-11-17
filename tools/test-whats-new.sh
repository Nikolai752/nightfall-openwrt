#!/bin/sh
set -eu
SRC="luci-theme-nightfall/htdocs/luci-static/nightfall/nightfall.js"
grep -q "ACKKEY = 'nightfall-whatsnew-ack-v1'" "$SRC"
grep -q "if (!ack && !seen).*lsSet(SEENKEY, cur); lsSet(ACKKEY, cur); return;" "$SRC"
grep -q "var legacy = !ack && !!seen;" "$SRC"
grep -q "lsSet(ACKKEY, cur); lsSet(SEENKEY, cur); closeUpd();" "$SRC"
grep -q "catch(function () { /\* не отмечаем просмотренным: повторим после следующего входа \*/ });" "$SRC"
echo "Проверка восстановления окна «Что нового» пройдена."
