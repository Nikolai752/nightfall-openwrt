#!/bin/sh
# Тесты расписания блокировки (дни недели, несколько окон, ночные окна, группы): sh tools/test-block.sh
cd "$(dirname "$0")/.." || exit 1
B=$(pwd)/luci-app-nightfall-monitor/root/usr/libexec/nightfall-block
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
ok=0; bad=0
export NF_BLOCK=$T/b.list NF_GROUPS=$T/g.list NF_DEVICES=$T/d.list NF_BLOCKLOG=$T/log NF_DIR=$T/dir NF_NFT=true NF_NOTIFY=true NF_PROC=$T/proc NF_LEASES=$T/leases
mkdir -p "$T/dir" "$T/proc/net"; : > "$T/leases"
M=aa:bb:cc:dd:ee:01
run() { sh "$B" "$@"; }
want() { case "$3" in *"$2"*) ok=$((ok+1)); echo "ok   $1" ;; *) bad=$((bad+1)); echo "FAIL $1: ждали «$2», получили «$3»" ;; esac; }
# состояние устройства в заданный день недели и время: sched или пусто
st() { NF_DOW=$1 NF_NOW=$2 run list | tr '{' '\n' | grep "\"mac\":\"$M\"" | sed -n 's/.*"reason":"\([a-z]*\)".*/\1/p'; }
chk() { # день время ожидание(sched|-) описание
	r=$(st "$1" "$2"); [ -n "$r" ] || r=-
	[ "$r" = "$3" ] && { ok=$((ok+1)); echo "ok   $4"; } || { bad=$((bad+1)); echo "FAIL $4: день $1, $2 -> «$r», ждали «$3»"; }
}

want "неверные дни отклонены" "дни недели" "$(run sched $M 23:00 09:00 Тест 89)"
want "одинаковые начало и конец отклонены" "не должны совпадать" "$(run sched $M 10:00 10:00 Тест 5)"
want "sched с днями 65 (Пт, Сб)" '"ok":true' "$(run sched $M 23:00 09:00 Тест 65)"
want "дни нормализованы по возрастанию" "|56|" "$(cat $NF_BLOCK)"
chk 5 2330 sched "Пт 23:30 — ночь с пятницы: отключено"
chk 6 0100 sched "Сб 01:00 — продолжение пятничной ночи"
chk 7 0100 sched "Вс 01:00 — продолжение субботней ночи"
chk 6 2330 sched "Сб 23:30 — отключено"
chk 7 2330 - "Вс 23:30 — воскресенье не в списке"
chk 5 0100 - "Пт 01:00 — ночь с четверга не входит"
chk 6 0900 - "Сб 09:00 — окно закончилось"
chk 3 1200 - "Ср днём — свободно"

want "второе окно (выходные днём)" '"ok":true' "$(run sadd $M 10:00 12:00 67)"
want "второе окно записано" "10:00-12:00@67" "$(cat $NF_BLOCK)"
chk 6 1100 sched "Сб 11:00 — второе окно"
chk 7 1130 sched "Вс 11:30 — второе окно"
chk 5 1100 - "Пт 11:00 — второе окно не действует"
chk 6 1200 - "Сб 12:00 — второе окно закончилось"
want "окно на каждый день (1234567 = все)" '"ok":true' "$(run sadd $M 14:00 15:00 7654321)"
chk 3 1430 sched "Ср 14:30 — окно каждый день"
want "лишний номер" "такого окна нет" "$(run sdel $M 9)"
want "нет номера" "номер окна" "$(run sdel $M x)"
want "sdel 3" '"ok":true' "$(run sdel $M 3)"
chk 3 1430 - "после удаления окна Ср 14:30 свободно"
chk 6 1100 sched "второе окно осталось"
want "замена первого окна сохраняет остальные" "10:00-12:00@67" "$(run sched $M 22:00 06:00 Тест 12345 >/dev/null; cat $NF_BLOCK)"
chk 2 2300 sched "новое первое окно: Вт 23:00"
chk 6 2300 - "новое первое окно: Сб 23:00 не входит"
want "list отдаёт days и rules" '"rules":"10:00-12:00@67"' "$(run list)"
want "list отдаёт days" '"days":"12345"' "$(run list)"
want "пустые дни: окно каждый день" '"ok":true' "$(run sched $M 08:00 09:00 Тест)"
chk 4 0830 sched "без дней — каждый день"
want "off убирает всё расписание" '"ok":true' "$(run sched $M off)"
chk 6 1100 - "после off окон нет"

echo "== группы =="
want "gadd" '"ok":true' "$(run gadd Дети)"
want "meta: устройство в группу" '"ok":true' "$(run meta $M Тест phone Дети)"
want "gsched с днями" '"ok":true' "$(run gsched Дети 20:00 22:00 12345)"
want "gsadd" '"ok":true' "$(run gsadd Дети 21:00 23:00 67)"
chk 2 2100 sched "группа: Вт 21:00"
chk 6 2200 sched "группа: Сб 22:00 (второе окно)"
chk 6 1900 - "группа: Сб 19:00 свободно"
want "groups отдаёт rules" '"rules":"21:00-23:00@67"' "$(run groups)"
want "gsdel" '"ok":true' "$(run gsdel Дети 2)"
chk 6 2200 - "после gsdel второго окна нет"
want "gsched off" '"ok":true' "$(run gsched Дети off)"
chk 2 2100 - "расписание группы снято"


echo "== суточная квота по всем адресам устройства =="
mkdir -p "$T/proc/net"
cat > "$T/proc/net/arp" <<EOF
IP address       HW type     Flags       HW address            Mask     Device
192.168.1.20     0x1         0x2         $M                   *        br-lan
EOF
cat > "$T/quota.neigh" <<EOF
192.168.1.20 dev br-lan lladdr $M REACHABLE
fd00::20 dev br-lan lladdr $M REACHABLE
EOF
cat > "$T/dir/dev.day" <<EOF
192.168.1.20 1200000000 0 1200000000
fd00::20 950000000 0 950000000
EOF
export NF_NEIGH=$T/quota.neigh NF_IP=true NF_TODAY=20261128
r=$(run quota "$M" 2000 TV)
want "квота сохранена" '"ok":true' "$r"
r=$(run list)
want "IPv4 и IPv6 суммируются без двойного учёта одного IP" '"used":2150000000' "$r"
want "общий расход по двум адресам включает блокировку" '"reason":"quota"' "$r"

# IPv6-only: устройство без IPv4 ARP-записи также должно получать квоту.
: > "$T/proc/net/arp"
printf 'fd00::20 15000000 0 15000000\n' > "$T/dir/dev.day"
printf 'fd00::20 dev br-lan lladdr %s REACHABLE\n' "$M" > "$T/quota.neigh"
r=$(run quota "$M" 10 TV)
want "IPv6-only квота сохранена" '"ok":true' "$r"
r=$(run list)
want "IPv6-only расход учитывается" '"used":15000000' "$r"
want "IPv6-only устройство блокируется после превышения" '"reason":"quota"' "$r"
unset NF_NEIGH NF_IP NF_TODAY

# Проверка передачи физического LAN-порта из FDB в JSON.
PORTMAC=aa:bb:cc:dd:ee:02
printf '%s LAN4\n' "$PORTMAC" > "$T/ports"
printf '192.168.1.20 dev br-lan lladdr %s REACHABLE\n' "$PORTMAC" > "$T/neigh"
export NF_NEIGH=$T/neigh NF_WIFI=$T/wifi NF_PORTMAP=$T/ports NF_IP=true NF_PING=false
: > "$T/wifi"
r=$(run list)
want "LAN-порт добавлен в JSON" '"connection":"LAN4"' "$r"
unset NF_NEIGH NF_WIFI NF_PORTMAP NF_IP NF_PING

echo; echo "ИТОГО: ok=$ok, ошибок=$bad"
[ "$bad" -eq 0 ]
