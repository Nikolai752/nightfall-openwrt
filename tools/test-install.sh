#!/bin/sh
# Тесты install-update.sh, install.sh и uninstall.sh без роутера: корень «роутера» — временная папка (NF_ROOT),
# «GitHub» — локальный http-сервер. Запуск из корня репозитория: sh tools/test-install.sh
cd "$(dirname "$0")/.." || exit 1
REPO=$(pwd)
T=$(mktemp -d); PIDF=$T/srv.pid
trap 'kill $(cat "$PIDF" 2>/dev/null) 2>/dev/null; rm -rf "$T"' EXIT
ok=0; bad=0
pass() { ok=$((ok + 1)); echo "ok   $*"; }
fail() { bad=$((bad + 1)); echo "FAIL $*"; }
check() { # описание, команда...
	d=$1; shift
	if "$@" >/dev/null 2>&1; then pass "$d"; else fail "$d"; fi
}
has() { grep -q -- "$2" "$1" 2>/dev/null; }

# --- «релизы»: версия N -> архив с version.json и парой файлов ---
mkrel() { # версия [версия_внутри_архива]
	v=$1; inner=${2:-$1}
	s=$T/stage.$v; rm -rf "$s"
	mkdir -p "$s/www/luci-static/nightfall" "$s/usr/libexec" "$s/etc/init.d" "$s/usr/share/luci/menu.d"
	printf '{ "version": "%s" }\n' "$inner" > "$s/www/luci-static/nightfall/version.json"
	echo "css $v" > "$s/www/luci-static/nightfall/cascade.css"
	printf '#!/bin/sh\necho %s\n' "$v" > "$s/usr/libexec/nightfall-config"
	printf '#!/bin/sh\n' > "$s/etc/init.d/nightfall-collector"
	echo '{}' > "$s/usr/share/luci/menu.d/luci-theme-nightfall.json"
	d=$T/www/dl/download/v$v; mkdir -p "$d"
	tar -czf "$d/nightfall-root.tar.gz" -C "$s" .
	( cd "$d" && sha256sum nightfall-root.tar.gz > nightfall-root.tar.gz.sha256 )
}
mkrel 1.0.0; mkrel 2.0.0; mkrel 3.0.0 2.0.0   # у релиза v3.0.0 внутри лежит архив версии 2.0.0 (ошибка публикации)
mkdir -p "$T/www/dl/latest"; cp -r "$T/www/dl/download/v2.0.0" "$T/www/dl/latest/download"
printf '{ "tag_name": "v2.0.0", "name": "v2.0.0" }\n' > "$T/www/api.json"
printf '{ "version": "2.0.0" }\n' > "$T/www/latest.json"

PORT=$((20000 + $$ % 20000))
( cd "$T/www" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) &
echo $! > "$PIDF"
i=0; while [ $i -lt 30 ]; do curl -fs "http://127.0.0.1:$PORT/api.json" >/dev/null 2>&1 && break; sleep 0.2; i=$((i + 1)); done
B="http://127.0.0.1:$PORT"

# запуск как «wget -qO- URL | sh -s -- ...»: скрипт приходит со stdin, $0 = sh
run() { # корень, параметры...
	r=$1; shift
	mkdir -p "$r" "$T/tmp"
	cat "$REPO/install-update.sh" | NF_ROOT="$r" NF_TMP="$T/tmp" NF_API="${API:-$B/api.json}" NF_RAW="$B" NF_DL="$B/dl" sh -s -- "$@" 2>&1
}
ver() { sed -n 's/.*"version"[^"]*"\([^"]*\)".*/\1/p' "$1/www/luci-static/nightfall/version.json" 2>/dev/null; }

echo "== установка с нуля =="
R=$T/r1
out=$(run "$R"); echo "$out" | sed 's/^/   | /'
[ "$(ver "$R")" = 2.0.0 ] && pass "ставится последняя версия 2.0.0" || fail "версия после установки: $(ver "$R")"
echo "$out" | grep -q "Установлена версия 2.0.0" && pass "в конце сказано, какая версия установлена" || fail "нет строки об установленной версии"
[ -x "$R/usr/libexec/nightfall-config" ] && pass "скрипты исполняемые" || fail "нет прав на исполнение"

echo "== старый архив в /tmp не используется (v1.0.9 из отчёта) =="
R=$T/r2
mkdir -p "$T/tmp"; cp "$T/www/dl/download/v1.0.0/nightfall-root.tar.gz" "$T/tmp/nightfall-root.tar.gz"; cp "$T/www/dl/download/v1.0.0/nightfall-root.tar.gz" "$T/tmp/nightfall-root_tar.gz"
run "$R" >/dev/null
[ "$(ver "$R")" = 2.0.0 ] && pass "несмотря на старый архив в /tmp, поставлена 2.0.0" || fail "поставлена $(ver "$R") (использован старый архив?)"

echo "== повторный запуск и обновление =="
out=$(run "$R"); echo "$out" | grep -q "Уже установлена" && pass "повтор: «уже установлена»" || fail "повтор не распознан: $out"
R=$T/r3; run "$R" --version v1.0.0 >/dev/null
[ "$(ver "$R")" = 1.0.0 ] && pass "--version v1.0.0 ставит старую версию" || fail "--version: $(ver "$R")"
out=$(run "$R"); echo "$out" | grep -q "(была 1.0.0)" && [ "$(ver "$R")" = 2.0.0 ] && pass "обновление 1.0.0 -> 2.0.0 показывает «была 1.0.0»" || fail "обновление: $out"
out=$(run "$R" --force); echo "$out" | grep -q "Установлена версия 2.0.0" && pass "--force переустанавливает" || fail "--force: $out"
out=$(run "$R" --check); echo "$out" | grep -q "Обновление не требуется" && pass "--check при актуальной версии" || fail "--check: $out"
out=$(run "$T/r3b" --check); echo "$out" | grep -q "Доступно обновление" && pass "--check при чистой системе" || fail "--check (чисто): $out"

echo "== защита от битых релизов =="
R=$T/r4; run "$R" --version v1.0.0 >/dev/null
out=$(run "$R" --version v3.0.0); echo "$out" | grep -q "лежит архив версии 2.0.0" && [ "$(ver "$R")" = 1.0.0 ] && pass "архив не той версии отклонён, файлы не тронуты" || fail "не той версии: $out ($(ver "$R"))"
mkdir -p "$T/bad" && cp -r "$T/www/dl/download/v2.0.0" "$T/www/dl/download/v4.0.0" && echo "0000000000000000000000000000000000000000000000000000000000000000  nightfall-root.tar.gz" > "$T/www/dl/download/v4.0.0/nightfall-root.tar.gz.sha256"
out=$(run "$R" --version v4.0.0); echo "$out" | grep -q "контрольная сумма не совпала" && [ "$(ver "$R")" = 1.0.0 ] && pass "неверная sha256 отклонена" || fail "sha256: $out"
out=$(run "$R" --version v9.9.9); echo "$out" | grep -q "не удалось скачать" && pass "несуществующая версия: понятная ошибка" || fail "нет версии: $out"

echo "== источники версии =="
R=$T/r5; API="$B/нет.json" run "$R" >/dev/null; [ "$(ver "$R")" = 2.0.0 ] && pass "API недоступен -> версия из latest.json" || fail "запасной источник: $(ver "$R")"
R=$T/r6; API="$B/нет.json" NF_RAW="$B/нет" run "$R" >/dev/null; [ "$(ver "$R")" = 2.0.0 ] && pass "версия не определилась -> архив из latest, версия проверена по архиву" || fail "latest/download: $(ver "$R")"

echo "== локальный файл =="
R=$T/r7; mkdir -p "$T/loc"; cp "$T/www/dl/download/v1.0.0/nightfall-root.tar.gz" "$T/loc/"; cp install-update.sh "$T/loc/"
out=$(cd "$T/loc" && NF_ROOT="$R" NF_TMP="$T/tmp" sh ./install-update.sh 2>&1); [ "$(ver "$R")" = 1.0.0 ] && pass "архив рядом со скриптом ставится без интернета" || fail "локальная установка: $out"
R=$T/r8; out=$(NF_ROOT="$R" NF_TMP="$T/tmp" sh install-update.sh --file "$T/www/dl/download/v2.0.0/nightfall-root.tar.gz" 2>&1); [ "$(ver "$R")" = 2.0.0 ] && pass "--file" || fail "--file: $out"

echo "== install.sh (обёртка) =="
R=$T/r9; out=$(NF_ROOT="$R" NF_TMP="$T/tmp" NF_API="$B/api.json" NF_RAW="$B" NF_DL="$B/dl" sh install.sh 2>&1); [ "$(ver "$R")" = 2.0.0 ] && pass "install.sh вызывает install-update.sh" || fail "install.sh: $out"

echo "== удаление: настоящий архив релиза =="
rm -rf dist; VERSION=v9.9.9 sh build-release.sh >/dev/null 2>&1
ARCH=$REPO/dist/nightfall-root.tar.gz
mkfs() { r=$1; rm -rf "$r"; mkdir -p "$r/tmp" "$r/etc"; tar -xzf "$ARCH" -C "$r"; for f in monitor.conf prefs.json logo.json bg.json known.list block.list; do echo x > "$r/etc/nightfall-$f"; done; echo x > "$r/tmp/nightfall-root.tar.gz"; mkdir -p "$r/tmp/nightfall"; }
un() { r=$1; shift; NF_ROOT="$r" sh uninstall.sh "$@" 2>&1; }
left() { find "$1" -iname '*nightfall*' 2>/dev/null | grep -v '/etc/nightfall-'; }

R=$T/u1; mkfs "$R"
[ -n "$(left "$R")" ] && pass "до удаления файлы Nightfall на месте" || fail "тестовая установка пуста"
out=$(un "$R"); echo "$out" | sed 's/^/   | /'
[ -z "$(left "$R")" ] && pass "по умолчанию удалены ВСЕ файлы темы, монитора, меню и ACL" || { fail "после удаления остались:"; left "$R"; }
[ -f "$R/etc/nightfall-monitor.conf" ] && pass "настройки сохранены" || fail "настройки удалены без --wipe"
[ ! -e "$R/usr/share/luci/menu.d/luci-theme-nightfall.json" ] && pass "пункт меню «Nightfall: все элементы» убран" || fail "осталось меню галереи"
[ ! -e "$R/tmp/nightfall-root.tar.gz" ] && pass "старые архивы в /tmp убраны" || fail "архив в /tmp остался"
R=$T/u2; mkfs "$R"; un "$R" --wipe >/dev/null
[ -z "$(find "$R" -iname '*nightfall*')" ] && pass "--wipe: не осталось ничего, даже настроек" || { fail "--wipe оставил:"; find "$R" -iname '*nightfall*'; }
R=$T/u3; mkfs "$R"; un "$R" --theme-only >/dev/null
[ -n "$(left "$R")" ] && pass "--theme-only файлы не трогает" || fail "--theme-only удалил файлы"
R=$T/u4; mkfs "$R"; un "$R" --purge >/dev/null; [ -z "$(left "$R")" ] && pass "--purge (старое имя) работает как полное удаление" || fail "--purge"
R=$T/u5; mkfs "$R"; un "$R" >/dev/null; un "$R" >/dev/null && pass "повторное удаление не падает" || fail "повторное удаление"
un "$T/u5" --нет >/dev/null 2>&1; [ $? -eq 2 ] && pass "неизвестный параметр -> код 2" || fail "код при неизвестном параметре"
rm -rf dist

echo; echo "ИТОГО: ok=$ok, ошибок=$bad"
[ "$bad" -eq 0 ]
