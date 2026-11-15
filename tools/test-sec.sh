#!/bin/sh
# Тест nightfall-sec (вкладка «Безопасность»): журнал входов, порты, проброс, новые устройства. Без роутера, на заглушках.
cd "$(dirname "$0")/.." || exit 1
S="$PWD/luci-app-nightfall-monitor/root/usr/libexec/nightfall-sec"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
ok=0; bad=0
want() { case "$3" in *"$2"*) ok=$((ok + 1)); echo "ok  $1" ;; *) bad=$((bad + 1)); echo "ОШИБКА: $1 — нет «$2» в: $3" ;; esac; }
nowant() { case "$3" in *"$2"*) bad=$((bad + 1)); echo "ОШИБКА: $1 — лишнее «$2»" ;; *) ok=$((ok + 1)); echo "ok  $1" ;; esac; }

T=$T . "$PWD/tools/sec-fixtures.sh" "$T"
export NF_LOGREAD="$T/logread" NF_PROC="$T/proc" NF_KNOWN="$T/known" NF_UCI="$T/uci" NF_UPDATEBIN="$T/upd"
out=$(sh "$S" summary)
echo "$out" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' 2>/dev/null && { ok=$((ok + 1)); echo "ok  summary — корректный JSON"; } || { bad=$((bad + 1)); echo "ОШИБКА: summary не JSON: $out"; }
want "неудачных входов по SSH: 3" '"failed_ssh":3' "$out"
want "неудачных входов в LuCI: 1" '"failed_luci":1' "$out"
want "самый частый адрес-нарушитель" '["203.0.113.5",2]' "$out"
want "успешный вход виден" '"ssh",1,"root","192.168.1.10"' "$out"
want "LuCI: вход отмечен" '"luci",0,"root","203.0.113.9"' "$out"
want "новые устройства: последнее первым" '["aa:bb:cc:dd:ee:02","Камера",1700001000]' "$out"
want "порт 22 слушает dropbear на всех адресах" '["tcp",22,"all","dropbear"]' "$out"
want "порт 8080 слушает только локально" '["tcp",8080,"local"' "$out"
want "порт 80 по IPv6 — uhttpd" '["tcp",80,"all","uhttpd"]' "$out"
want "UDP 53 виден" '["udp",53,"all"' "$out"
want "проброс порта из интернета" '["Web","tcp","8080","192.168.1.5","80"]' "$out"
nowant "выключенный проброс не показывается" "Off" "$out"
want "политика входящего на WAN" '"wan_input":"REJECT"' "$out"
nowant "соединение ESTABLISHED не считается портом" '50000' "$(echo "$out" | sed 's/"ssh",1,"root","192.168.1.10"//')"
u=$(sh "$S" updates)
want "updates: версия темы" '"installed":"1.0.0"' "$u"
want "updates: есть новая" '"new":1' "$u"
NF_LOGREAD=true sh "$S" summary >/dev/null && { ok=$((ok + 1)); echo "ok  пустой журнал не ломает сводку"; } || { bad=$((bad + 1)); echo "ОШИБКА: пустой журнал"; }
# быстрая диагностика: шлюз, интернет, DNS (заглушки команд)
D="$PWD/luci-app-nightfall-monitor/root/usr/libexec/nightfall-diag"
mkdir -p "$T/bin"
printf '#!/bin/sh\necho "default via 192.168.1.1 dev eth0"\n' > "$T/bin/ip"
printf '#!/bin/sh\necho "round-trip min/avg/max = 9.0/12.4/15.0 ms"\n' > "$T/bin/ping"
printf '#!/bin/sh\nexit 0\n' > "$T/bin/nslookup"
chmod +x "$T/bin/ip" "$T/bin/ping" "$T/bin/nslookup"
c=$(PATH="$T/bin:$PATH" sh "$D" check)
want "check: шлюз отвечает" "✅ Шлюз 192.168.1.1: 12 мс" "$c"
want "check: интернет отвечает" "✅ Интернет: 1.1.1.1 — 12 мс" "$c"
want "check: DNS разрешается" "✅ DNS: ya.ru разрешается" "$c"
printf '#!/bin/sh\nexit 1\n' > "$T/bin/ping"; printf '#!/bin/sh\nexit 1\n' > "$T/bin/nslookup"
c=$(PATH="$T/bin:$PATH" sh "$D" check)
want "check: нет интернета виден" "❌ Интернет: 1.1.1.1 не отвечает" "$c"
want "check: DNS не работает виден" "❌ DNS: google.com не разрешается" "$c"
echo; echo "ИТОГО: ok=$ok, ошибок=$bad"; [ "$bad" = 0 ]
