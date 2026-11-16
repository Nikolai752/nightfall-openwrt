#!/bin/sh
# Тест nightfall-sec (вкладка «Безопасность»): журнал входов, порты, проброс, новые устройства. Без роутера, на заглушках.
cd "$(dirname "$0")/.." || exit 1
S="$PWD/luci-app-nightfall-monitor/root/usr/libexec/nightfall-sec"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
ok=0; bad=0
want() { case "$3" in *"$2"*) ok=$((ok + 1)); echo "ok  $1" ;; *) bad=$((bad + 1)); echo "ОШИБКА: $1 — нет «$2» в: $3" ;; esac; }
nowant() { case "$3" in *"$2"*) bad=$((bad + 1)); echo "ОШИБКА: $1 — лишнее «$2»" ;; *) ok=$((ok + 1)); echo "ok  $1" ;; esac; }

T=$T . "$PWD/tools/sec-fixtures.sh" "$T"
export NF_SHADOW="$T/shadow" NF_DIR="$T/d"
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
want "проверка: пустой пароль root" '["bad","Пароль root не задан' "$out"
want "проверка: сеть без пароля" '["bad","Сеть «Guest» без пароля' "$out"
want "проверка: устаревшее шифрование" '["warn","Сеть «Old» допускает устаревшее' "$out"
want "проверка: хорошее шифрование" '["ok","Сеть «Home»: шифрование sae-mixed' "$out"
nowant "проверка: выключенная сеть не считается" "«Off»" "$out"
want "проверка: SSH только по ключам" '["ok","SSH: вход по паролю выключен' "$out"
want "проверка: LuCI по http" '["warn","LuCI доступен по http' "$out"
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

# закрытие адреса через nft (заглушка)
cat > "$T/nft" <<'N'
#!/bin/sh
echo "$*" >> "$NFT_LOG"
case "$1 $2" in
"-f -") cat >> "$NFT_LOG"; touch "$NFT_LOG.on" ;;
"list table") [ -f "$NFT_LOG.on" ] && echo "ip saddr @b4 drop" ;;
"list set") case "$5" in b4) printf 'table inet nightfall_ban {\n\tset b4 {\n\t\ttype ipv4_addr\n\t\tflags timeout\n\t\telements = { 203.0.113.5 timeout 1d expires 23h59m10s,\n\t\t\t     198.51.100.7 timeout 1h expires 59m1s }\n\t}\n}\n' ;; esac ;;
esac
exit 0
N
chmod +x "$T/nft"; export NFT_LOG="$T/nft.log"; : > "$NFT_LOG"; rm -f "$NFT_LOG.on"
b=$(NF_NFT="$T/nft" sh "$S" ban 203.0.113.5 2)
want "ban: внешний адрес закрывается" '"ok":true,"ip":"203.0.113.5","hours":2' "$b"
want "ban: таблица nft создана" "add rule inet nightfall_ban input ip saddr @b4 drop" "$(cat $NFT_LOG)"
want "ban: адрес добавлен на 2 часа" "add element inet nightfall_ban b4 { 203.0.113.5 timeout 2h }" "$(cat $NFT_LOG)"
b=$(NF_NFT="$T/nft" sh "$S" ban 192.168.1.10); want "ban: локальный адрес нельзя" '"ok":false' "$b"
b=$(NF_NFT="$T/nft" sh "$S" ban 10.0.0.5); want "ban: 10.x нельзя" '"ok":false' "$b"
b=$(NF_NFT="$T/nft" sh "$S" ban 127.0.0.1); want "ban: loopback нельзя" '"ok":false' "$b"
b=$(NF_NFT="$T/nft" sh "$S" ban 'a;rm -rf /'); want "ban: мусор вместо адреса отклоняется" '"ok":false' "$b"
b=$(NF_NFT="$T/nft" sh "$S" ban 256.1.1.1); want "ban: некорректный адрес отклоняется" '"ok":false' "$b"
b=$(NF_NFT="$T/nft" sh "$S" ban fe80::1); want "ban: link-local IPv6 нельзя" '"ok":false' "$b"
b=$(NF_NFT="$T/nft" sh "$S" ban 2001:db8::5 99999); want "ban: IPv6 принимается, срок ограничен" '"hours":24' "$b"
want "ban: IPv6 попал в свой набор" "add element inet nightfall_ban b6 { 2001:db8::5 timeout 24h }" "$(cat $NFT_LOG)"
b=$(NF_NFT="$T/nft" sh "$S" bans)
want "bans: список с оставшимся временем" '["203.0.113.5","23h59m10s"]' "$b"
want "bans: второй адрес" '["198.51.100.7","59m1s"]' "$b"
NF_NFT="$T/nft" sh "$S" unban 203.0.113.5 >/dev/null
want "unban: адрес снят" "delete element inet nightfall_ban b4 { 203.0.113.5 }" "$(cat $NFT_LOG)"
# уведомление о всплеске неудачных входов
rm -rf "$T/wd"; mkdir -p "$T/wd"
w=$(NF_DIR="$T/wd" NF_SECFAILS=3 sh "$S" watch); [ -z "$w" ] && { ok=$((ok + 1)); echo "ok  watch: первый запуск молчит (запоминает счётчик)"; } || { bad=$((bad + 1)); echo "ОШИБКА: watch первый запуск: $w"; }
echo 0 > "$T/wd/sec.fails"
w=$(NF_DIR="$T/wd" NF_SECFAILS=3 sh "$S" watch); want "watch: рост неудачных входов даёт сообщение" "Много неудачных входов" "$w"
w=$(NF_DIR="$T/wd" NF_SECFAILS=3 sh "$S" watch); [ -z "$w" ] && { ok=$((ok + 1)); echo "ok  watch: без нового роста молчит"; } || { bad=$((bad + 1)); echo "ОШИБКА: watch повторно: $w"; }
# журнал роутера
L="$PWD/luci-app-nightfall-monitor/root/usr/libexec/nightfall-log"
r=$(sh "$L" read 100)
echo "$r" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' 2>/dev/null && { ok=$((ok + 1)); echo "ok  nightfall-log: корректный JSON"; } || { bad=$((bad + 1)); echo "ОШИБКА: nightfall-log не JSON: $r"; }
want "log: служба без номера процесса" '"authpriv.warn","dropbear","Bad password attempt for' "$r"
want "log: текст сообщения целиком" "from 203.0.113.5:40022" "$r"
r=$(sh "$L" read 2); nowant "log: N ограничивает число строк" "02:10:01" "$r"
r=$(sh "$L" read abc); want "log: мусор вместо N не ломает" '"ok":true' "$r"


# DNS-статистика
N="$PWD/luci-app-nightfall-monitor/root/usr/libexec/nightfall-dns"
d=$(NF_LOGREAD="$T/dnslogread" NF_UCI="$T/uci_dns" sh "$N" top)
echo "$d" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' 2>/dev/null && { ok=$((ok + 1)); echo "ok  dns: корректный JSON"; } || { bad=$((bad + 1)); echo "ОШИБКА: dns не JSON: $d"; }
want "dns: всего запросов" '"total":6' "$d"
want "dns: сайты сводятся к основному домену" '["youtube.com",2]' "$d"
want "dns: bbc.co.uk учитывается как bbc.co.uk" '["bbc.co.uk",1]' "$d"
want "dns: клиент 192.168.1.11 — 3 запроса" '["192.168.1.11",3]' "$d"
want "dns: NXDOMAIN посчитан" '"nx":2' "$d"
want "dns: список NXDOMAIN" '["nope.example.org",2]' "$d"
want "dns: типы запросов" '["A",5]' "$d"
nowant "dns: чужие службы не считаются" "fake.test" "$d"
d=$(NF_LOGREAD=true NF_UCI="$T/uci_off" sh "$N" top); want "dns: без запросов и без журнала — выключено" '"enabled":false' "$d"

echo; echo "ИТОГО: ok=$ok, ошибок=$bad"; [ "$bad" = 0 ]
