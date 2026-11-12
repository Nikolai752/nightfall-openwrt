#!/bin/sh
# Тесты бота и уведомлений без Telegram и роутера: вместо curl подставляется заглушка.
# Запуск из корня репозитория: sh tools/test-bot.sh
cd "$(dirname "$0")/.." || exit 1
L=$(pwd)/luci-app-nightfall-monitor/root/usr/libexec
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
ok()  { echo "ok: $1"; }
bad() { echo "ОШИБКА: $1"; fail=1; }

# заглушка curl: пишет в журнал метод API, текст сообщения и то, что пришло в stdin (аргументы отдельно, в $T/args);
# на getUpdates отдаёт заранее заготовленный ответ из $T/updates (один раз), на остальное {"ok":true}
cat > "$T/curl" <<'SH'
#!/bin/sh
in=$(cat)
m=$(printf '%s' "$in" | sed -n 's|.*api.telegram.org/bot[^/]*/\([A-Za-z]*\).*|\1|p')
printf '%s\n' "$*" >> "$T/args"
txt=""; for a in "$@"; do case "$a" in text@*) txt="$txt $(cat "${a#text@}" 2>/dev/null | tr '\n' ' ')" ;; esac; done
printf 'METHOD %s TEXT %s STDIN %s\n' "$m" "$txt" "$(printf '%s' "$in" | tr '\n' ' ')" >> "$T/calls"
if [ "$m" = getUpdates ]; then
	if [ -s "$T/updates" ] && ! printf '%s' "$*" | grep -q 'offset=-1'; then cat "$T/updates"; : > "$T/updates"; else echo '{"ok":true,"result":[]}'; fi
else echo '{"ok":true,"result":{}}'; fi
SH
chmod +x "$T/curl"
export T

conf() {  # conf CHAT USERS [PROXY]
	printf 'TG=1\nTG_TOKEN=123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nTG_CHAT=%s\nTG_USERS=%s\nTG_PROXY=%s\n' "$1" "$2" "$3" > "$T/conf"
}
upd() {  # upd ЧАТ ОТПРАВИТЕЛЬ ТЕКСТ | upd cb ЧАТ ОТПРАВИТЕЛЬ ДАННЫЕ
	if [ "$1" = cb ]; then
		printf '{"ok":true,"result":[{"update_id":10,"callback_query":{"id":"77","from":{"id":%s,"is_bot":false},"message":{"message_id":5,"from":{"id":999,"is_bot":true},"chat":{"id":%s,"type":"supergroup"},"text":"x"},"data":"%s"}}]}' "$3" "$2" "$4" > "$T/updates"
	else
		printf '{"ok":true,"result":[{"update_id":10,"message":{"message_id":5,"from":{"id":%s,"is_bot":false},"chat":{"id":%s,"type":"supergroup"},"text":"%s"}}]}' "$2" "$1" "$3" > "$T/updates"
	fi
}
runbot() {
	: > "$T/calls"; rm -f "$T/rebooted"
	NF_CONF="$T/conf" NF_DIR="$T" NF_CURL="$T/curl" NF_NOSLEEP=1 NF_ONCE=1 NF_NOTIFY="$L/nightfall-notify" NF_REBOOT="touch $T/rebooted" NF_PROC="$T/proc" NF_LEASES="$T/leases" sh "$L/nightfall-bot" >/dev/null 2>&1
}
mkdir -p "$T/proc/sys/kernel"; echo 100 > "$T/proc/uptime"; echo "0.1 0.1 0.1" > "$T/proc/loadavg"; echo testrouter > "$T/proc/sys/kernel/hostname"
printf 'MemTotal: 1000 kB\nMemAvailable: 500 kB\n' > "$T/proc/meminfo"

# 1. личный чат: свой пользователь обслуживается, чужой нет
conf 111 ""; upd 111 111 "/status"; runbot
grep -q 'METHOD sendMessage' "$T/calls" && ok "личный чат: владелец получает ответ" || bad "личный чат: владелец без ответа"
conf 111 ""; upd 222 222 "/status"; runbot
grep -q 'METHOD sendMessage' "$T/calls" && bad "чужой чат получил ответ" || ok "чужой чат игнорируется"

# 2. группа: участник вне TG_USERS может смотреть, но не управлять
conf -100500 111; upd -100500 222 "/status"; runbot
grep -q 'METHOD sendMessage' "$T/calls" && ok "группа: просмотр доступен всем участникам" || bad "группа: просмотр не работает"
conf -100500 111; upd -100500 222 "/reboot"; runbot
grep -q 'Управление доступно только администраторам' "$T/calls" && ok "группа: посторонний не может запросить перезагрузку" || bad "группа: посторонний прошёл"
[ -e "$T/rebooted" ] && bad "группа: посторонний перезагрузил роутер"
conf -100500 111; upd cb -100500 222 "rb:yes"; date +%s > "$T/reboot.ask"; runbot
[ -e "$T/rebooted" ] && bad "группа: посторонний подтвердил перезагрузку" || ok "группа: посторонний не подтверждает перезагрузку"
conf -100500 111; upd -100500 111 "/reboot"; runbot
grep -q 'Подтвердите в течение минуты' "$T/calls" && ok "группа: администратор запрашивает перезагрузку" || bad "группа: администратор не прошёл"
# без TG_USERS управление в группе закрыто
conf -100500 ""; upd -100500 111 "/reboot"; runbot
grep -q 'Управление доступно только администраторам' "$T/calls" && ok "группа без TG_USERS: управление закрыто" || bad "группа без TG_USERS: управление открыто"

# 3. подтверждение перезагрузки: свежее срабатывает один раз, старое нет
conf 111 ""; upd cb 111 111 "rb:yes"; date +%s > "$T/reboot.ask"; runbot; sleep 3
[ -e "$T/rebooted" ] && ok "перезагрузка: свежее подтверждение работает" || bad "перезагрузка: свежее подтверждение не сработало"
[ -e "$T/reboot.ask" ] && bad "перезагрузка: подтверждение не одноразовое" || ok "перезагрузка: подтверждение одноразовое"
conf 111 ""; upd cb 111 111 "rb:yes"; echo $(( $(date +%s) - 120 )) > "$T/reboot.ask"; runbot; sleep 3
[ -e "$T/rebooted" ] && bad "перезагрузка: сработало устаревшее подтверждение" || ok "перезагрузка: устаревшее подтверждение отклонено"
conf 111 ""; upd cb 111 111 "rb:yes"; rm -f "$T/reboot.ask"; runbot; sleep 3
[ -e "$T/rebooted" ] && bad "перезагрузка: сработало без запроса" || ok "перезагрузка: без запроса не срабатывает"

# 4. прокси с паролем не должен попадать в аргументы curl
conf 111 "" "socks5h://user:secret@127.0.0.1:1080"
: > "$T/calls"; : > "$T/args"; NF_CONF="$T/conf" NF_DIR="$T" NF_CURL="$T/curl" NF_NOSLEEP=1 sh "$L/nightfall-notify" test >/dev/null
grep -q secret "$T/args" && bad "прокси виден в аргументах curl" || ok "прокси не в аргументах curl"
grep -q 'STDIN.*proxy = "socks5h://user:secret@127.0.0.1:1080"' "$T/calls" && ok "прокси передан через stdin" || bad "прокси не передан"

# 5. настройка TG_USERS проверяется
printf 'TG_USERS=\n' > "$T/c2"; cp "$T/c2" "$T/c3"
r=$(NF_CONF="$T/c3" NF_DEF="$T/c2" NF_NORESTART=1 sh "$L/nightfall-config" set TG_USERS=123456789,987654321)
case "$r" in *'"ok":true'*) ok "TG_USERS: верное значение принято" ;; *) bad "TG_USERS: верное значение отклонено: $r" ;; esac
r=$(NF_CONF="$T/c3" NF_DEF="$T/c2" NF_NORESTART=1 sh "$L/nightfall-config" set 'TG_USERS=12;reboot')
case "$r" in *'"ok":false'*) ok "TG_USERS: мусор отклонён" ;; *) bad "TG_USERS: мусор принят: $r" ;; esac

[ $fail = 0 ] && echo "ВСЁ В ПОРЯДКЕ" || { echo "ЕСТЬ ОШИБКИ"; exit 1; }
