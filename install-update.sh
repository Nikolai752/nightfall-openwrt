#!/bin/sh
# Установка и обновление Nightfall на роутере (OpenWrt, busybox sh).
#
#   wget -qO- https://raw.githubusercontent.com/Nikolai752/nightfall-openwrt/main/install-update.sh | sh
#   (или curl -fsSL ... | sh)
#
# Параметры (после «| sh -s --»):
#   --check            только показать установленную и последнюю версию
#   --force            переустановить, даже если версия уже последняя
#   --version vX.Y.Z   поставить конкретную версию (в том числе более старую)
#   --activate         сразу выбрать Nightfall темой по умолчанию
#   --file ПУТЬ        поставить из локального архива nightfall-root.tar.gz (без интернета)
#   -h, --help         эта справка
#
# Вручную без интернета: положите nightfall-root.tar.gz и этот скрипт в одну папку на роутере и запустите
#   sh install-update.sh
#
# Что делает: узнаёт последнюю версию -> скачивает именно её архив -> сверяет sha256 и подпись (usign) ->
# проверяет, что версия внутри архива совпадает с ожидаемой -> сохраняет копию заменяемых файлов ->
# распаковывает (при ошибке возвращает прежние файлы) -> сверяет версию после установки.
# Старые архивы, оставшиеся в /tmp от прошлых установок, НЕ используются.
#
# Для тестов: NF_ROOT (корень вместо /), NF_TMP, NF_API, NF_RAW, NF_DL.

REPO="Nikolai752/nightfall-openwrt"
ROOT=${NF_ROOT:-}
TMP=${NF_TMP:-/tmp}
API=${NF_API:-https://api.github.com/repos/$REPO/releases/latest}
RAW=${NF_RAW:-https://raw.githubusercontent.com/$REPO/main}
DL=${NF_DL:-https://github.com/$REPO/releases}
VERF="$ROOT/www/luci-static/nightfall/version.json"
PUB="$ROOT/etc/nightfall-release.pub"
WORK="$TMP/nightfall-install.$$"

say() { echo "$*"; }
die() { echo "ОШИБКА: $*" >&2; exit 1; }
usage() {
	cat <<'EOT'
Установка и обновление Nightfall: wget -qO- https://raw.githubusercontent.com/Nikolai752/nightfall-openwrt/main/install-update.sh | sh
Параметры (после «| sh -s --»):
  --check            показать установленную и последнюю версию
  --force            переустановить, даже если версия уже последняя
  --version vX.Y.Z   поставить конкретную версию (в том числе старую)
  --activate         сразу выбрать Nightfall темой по умолчанию
  --file ПУТЬ        поставить из локального архива nightfall-root.tar.gz
  -h, --help         эта справка
EOT
}

FORCE=0; ACTIVATE=0; CHECK=0; WANT=; FILE=
while [ $# -gt 0 ]; do
	case "$1" in
	--force|-f) FORCE=1 ;;
	--activate) ACTIVATE=1 ;;
	--check) CHECK=1 ;;
	--version) shift; WANT=$1; [ -n "$WANT" ] || die "после --version нужен номер, например v1.16.2" ;;
	--file) shift; FILE=$1; [ -f "$FILE" ] || die "файл не найден: $FILE" ;;
	-h|--help) usage; exit 0 ;;
	*) die "неизвестный параметр: $1 (справка: --help)" ;;
	esac
	shift
done

rm -rf "$WORK"; mkdir -p "$WORK" || die "не удалось создать рабочую папку $WORK"
trap 'rm -rf "$WORK"' EXIT

fetch() { # url out
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 2 --connect-timeout 15 --max-time 300 -o "$2" "$1"
	elif command -v uclient-fetch >/dev/null 2>&1; then
		uclient-fetch -q -O "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1"
	else
		return 127
	fi
}

json_ver() { sed -n 's/.*"version"[^"]*"\([^"]*\)".*/\1/p' | head -n1; }
installed() { json_ver < "$VERF" 2>/dev/null; }

# версия из архива: файл version.json лежит внутри, путь с «./» или без
archive_ver() {
	{ tar -xzOf "$1" ./www/luci-static/nightfall/version.json 2>/dev/null || tar -xzOf "$1" www/luci-static/nightfall/version.json 2>/dev/null; } | json_ver
}

latest_tag() {
	t=
	if fetch "$API" "$WORK/api.json" 2>/dev/null; then
		t=$(sed -n 's/.*"tag_name"[^"]*"\([^"]*\)".*/\1/p' "$WORK/api.json" | head -n1)
	fi
	if [ -z "$t" ] && fetch "$RAW/latest.json" "$WORK/latest.json" 2>/dev/null; then
		t=$(json_ver < "$WORK/latest.json")
	fi
	[ -n "$t" ] && echo "v${t#v}"
}

OLD=$(installed)
say "Установленная версия: ${OLD:-не установлена}"

# --- откуда берём архив ---
ARCH=; TAG=; SRC=remote
if [ -z "$FILE" ]; then
	# архив рядом со скриптом (ручная установка); при запуске «| sh» $0 не файл, и /tmp не просматривается
	case "$0" in */*) [ -f "$0" ] && d=$(dirname "$0") && for n in nightfall-root.tar.gz nightfall-root_tar.gz; do
		[ -f "$d/$n" ] && { FILE="$d/$n"; break; }
	done ;; esac
fi
if [ -n "$FILE" ]; then
	SRC=local; ARCH=$FILE
	say "Локальный архив: $FILE"
else
	if [ -n "$WANT" ]; then
		TAG="v${WANT#v}"
	else
		TAG=$(latest_tag)
		[ -n "$TAG" ] || say "Не удалось узнать последнюю версию через GitHub, беру архив из «latest»; версию проверю по содержимому."
	fi
	[ -n "$TAG" ] && say "Последняя версия: ${TAG#v}"
	if [ "$CHECK" = 1 ]; then
		[ -n "$TAG" ] || die "не удалось узнать последнюю версию"
		[ "$OLD" = "${TAG#v}" ] && say "Обновление не требуется." || say "Доступно обновление: ${OLD:-—} -> ${TAG#v}"
		exit 0
	fi
	if [ -n "$TAG" ] && [ "$OLD" = "${TAG#v}" ] && [ "$FORCE" = 0 ]; then
		say "Уже установлена эта версия (${OLD}). Для переустановки добавьте --force."
		exit 0
	fi
	if [ -n "$TAG" ]; then BASE="$DL/download/$TAG"; else BASE="$DL/latest/download"; fi
	command -v curl >/dev/null 2>&1 || command -v uclient-fetch >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 \
		|| die "нет curl или wget. Установите: apk add curl ca-bundle"
	say "Скачиваю ${TAG:-последний релиз}…"
	ARCH="$WORK/nightfall-root.tar.gz"
	fetch "$BASE/nightfall-root.tar.gz" "$ARCH" \
		|| die "не удалось скачать архив (${TAG:-latest}). Проверьте интернет и HTTPS (apk add curl ca-bundle) или положите архив рядом со скриптом."
	fetch "$BASE/nightfall-root.tar.gz.sha256" "$WORK/new.sha256" || die "у релиза нет файла контрольной суммы, установка остановлена"
	WANTSUM=$(sed -n '1s/[[:space:]].*//p' "$WORK/new.sha256" | tr 'A-F' 'a-f')
	GOTSUM=$(sha256sum "$ARCH" | sed 's/[[:space:]].*//')
	[ -n "$WANTSUM" ] && [ "$WANTSUM" = "$GOTSUM" ] || die "контрольная сумма не совпала, архив не установлен"
	say "Контрольная сумма совпала."
	if [ -f "$PUB" ]; then
		if command -v usign >/dev/null 2>&1; then
			fetch "$BASE/nightfall-root.tar.gz.sig" "$WORK/new.sig" || die "у релиза нет подписи, установка остановлена"
			usign -V -m "$ARCH" -p "$PUB" -x "$WORK/new.sig" >/dev/null 2>&1 || die "подпись релиза не подходит, архив не установлен"
			say "Подпись проверена."
		else
			say "Внимание: usign не найден, подпись не проверена (контрольная сумма совпала)."
		fi
	fi
fi

# --- проверка архива ---
tar -tzf "$ARCH" > "$WORK/all.list" 2>/dev/null || die "архив повреждён"
grep -q 'luci-static/nightfall/' "$WORK/all.list" || die "в архиве нет файлов темы Nightfall"
grep -q '^/\|\.\./' "$WORK/all.list" && die "в архиве недопустимые пути"
NEW=$(archive_ver "$ARCH")
[ -n "$NEW" ] || die "в архиве нет файла версии (слишком старый или повреждённый архив)"
if [ -n "$TAG" ] && [ "$NEW" != "${TAG#v}" ]; then
	die "в релизе $TAG лежит архив версии $NEW. Сообщите об этом в Issues, установка остановлена."
fi
say "Версия в архиве: $NEW"
if [ "$SRC" = local ] && [ "$OLD" = "$NEW" ] && [ "$FORCE" = 0 ]; then
	say "Эта версия уже установлена ($NEW). Для переустановки добавьте --force."
	exit 0
fi

# --- остановить сборщик и бота перед заменой файлов ---
if [ -z "$ROOT" ]; then
	[ -x /etc/init.d/nightfall-collector ] && /etc/init.d/nightfall-collector stop 2>/dev/null
	for p in /proc/[0-9]*; do
		pid=${p#/proc/}; [ "$pid" = "$$" ] && continue
		cmd=$( { tr '\0' ' ' < "$p/cmdline"; } 2>/dev/null )
		case "$cmd" in "/bin/sh /usr/libexec/nightfall-collector "*|"sh /usr/libexec/nightfall-collector "*|"/bin/sh /usr/libexec/nightfall-bot"*|"sh /usr/libexec/nightfall-bot"*) kill "$pid" 2>/dev/null ;; esac
	done
	sleep 1
fi

# --- копия заменяемых файлов, чтобы вернуть всё при сбое ---
sed 's|^\./||; /\/$/d; /^$/d' "$WORK/all.list" > "$WORK/files.list"
: > "$WORK/exist.list"; : > "$WORK/added.list"
while IFS= read -r f; do
	if [ -e "$ROOT/$f" ] || [ -L "$ROOT/$f" ]; then echo "$f" >> "$WORK/exist.list"; else echo "$f" >> "$WORK/added.list"; fi
done < "$WORK/files.list"
HAVEBAK=0
if [ -s "$WORK/exist.list" ]; then
	tar -czf "$WORK/backup.tar.gz" -C "${ROOT:-/}" -T "$WORK/exist.list" 2>/dev/null && HAVEBAK=1 || say "Внимание: копию прежних файлов сохранить не удалось."
fi

[ -n "$ROOT" ] && mkdir -p "$ROOT"
say "Устанавливаю версию $NEW…"
if ! tar -xzf "$ARCH" -C "${ROOT:-/}"; then
	say "Ошибка распаковки, возвращаю прежние файлы…"
	while IFS= read -r f; do rm -rf "${ROOT:?}/$f"; done < "$WORK/added.list"
	[ "$HAVEBAK" = 1 ] && tar -xzf "$WORK/backup.tar.gz" -C "${ROOT:-/}" 2>/dev/null
	die "не удалось распаковать архив (нет места в /overlay? проверьте: df -h)"
fi

# --- права и регистрация ---
chmod 755 "$ROOT"/usr/libexec/nightfall-* "$ROOT"/etc/init.d/nightfall-collector 2>/dev/null
rm -f "$ROOT/www/luci-static/resources/view/nightfall/sysauth.js"
if [ -z "$ROOT" ]; then
	for f in /etc/uci-defaults/30_luci-theme-nightfall /etc/uci-defaults/40_nightfall-collector; do
		[ -f "$f" ] && { sh "$f"; rm -f "$f"; }
	done
	if [ "$ACTIVATE" = 1 ]; then
		uci set luci.main.mediaurlbase=/luci-static/nightfall
		uci commit luci
	fi
	rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache 2>/dev/null
	/etc/init.d/rpcd reload 2>/dev/null || /etc/init.d/rpcd restart 2>/dev/null
	/etc/init.d/nightfall-collector restart 2>/dev/null
fi

# --- итог: версия после установки ---
NOW=$(installed)
if [ "$NOW" != "$NEW" ]; then
	die "после установки версия ${NOW:-не определена}, ожидалась $NEW. Что-то пошло не так: проверьте свободное место (df -h) и повторите с --force."
fi
say "Готово. Установлена версия $NOW${OLD:+ (была $OLD)}."
say "Выйдите из LuCI и войдите снова (права обновляются при входе), затем Ctrl+F5."
say "На iPhone закройте приложение с экрана «Домой» и откройте заново."
[ -z "$OLD" ] && say "Тема выбирается в «Система → Система → Язык и стиль» (или запустите с --activate)."
exit 0
