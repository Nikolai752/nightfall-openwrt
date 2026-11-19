#!/bin/sh
# Блокирует выпуск тега без соответствующего верхнего раздела CHANGELOG.
set -eu
TAG=${1:-${GITHUB_REF_NAME:-}}
[ -n "$TAG" ] || { echo "ОШИБКА: не передан тег релиза" >&2; exit 1; }
VERSION=${TAG#v}
printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?
FIRST=$(sed -n '1p' CHANGELOG.md)
case "$FIRST" in
  "## v$VERSION · "*) ;;
  *) echo "ОШИБКА: верхний раздел CHANGELOG.md должен начинаться с ## v$VERSION" >&2; exit 1 ;;
esac
COUNT=$(awk 'BEGIN{n=0;active=0} /^## /{if(active)exit; if($0 ~ /^## v[0-9.]+(-[0-9A-Za-z.-]+)? · /)active=1; next} active && /^- /{n++} END{print n}' CHANGELOG.md)
[ "$COUNT" -ge 1 ] || { echo "ОШИБКА: раздел v$VERSION не содержит пунктов изменений" >&2; exit 1; }
echo "CHANGELOG для $TAG проверен: $COUNT пункт(ов)."
 || { echo "ОШИБКА: ожидается тег vMAJOR.MINOR.PATCH[-prerelease], получено: $TAG" >&2; exit 1; }
FIRST=$(sed -n '1p' CHANGELOG.md)
case "$FIRST" in
  "## v$VERSION · "*) ;;
  *) echo "ОШИБКА: верхний раздел CHANGELOG.md должен начинаться с ## v$VERSION" >&2; exit 1 ;;
esac
COUNT=$(awk 'BEGIN{n=0;active=0} /^## /{if(active)exit; if($0 ~ /^## v[0-9.]+ · /)active=1; next} active && /^- /{n++} END{print n}' CHANGELOG.md)
[ "$COUNT" -ge 1 ] || { echo "ОШИБКА: раздел v$VERSION не содержит пунктов изменений" >&2; exit 1; }
echo "CHANGELOG для $TAG проверен: $COUNT пункт(ов)."
