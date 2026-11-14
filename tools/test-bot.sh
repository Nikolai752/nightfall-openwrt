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
txt=""; for a in "$@"; do case "$a" in text@*|caption@*|chat_data@*) txt="$txt [${a%%@*}] $(cat "${a#*@}" 2>/dev/null | tr '\n' ' ')" ;; allow_queries=*|reply_markup=*) txt="$txt [$a]" ;; esac; done
printf 'METHOD %s TEXT %s STDIN %s\n' "$m" "$txt" "$(printf '%s' "$in" | tr '\n' ' ')" >> "$T/calls"
if [ "$m" = getUpdates ]; then
	if [ -s "$T/updates" ] && ! printf '%s' "$*" | grep -q 'offset=-1'; then cat "$T/updates"; : > "$T/updates"; else echo '{"ok":true,"result":[]}'; fi
elif [ "$m" = sendMessage ] || { [ "$m" = sendWidget ] && [ ! -e "$T/widget.fail" ]; }; then
	n=$(( $(cat "$T/mid" 2>/dev/null || echo 100) + 1 )); echo $n > "$T/mid"; printf '{"ok":true,"result":{"message_id":%s,"chat":{"id":1}}}' "$n"
elif [ "$m" = sendWidget ]; then
	echo '{"ok":false,"error_code":400,"description":"Bad Request: widgets are not supported"}'
else
	case "$m" in deleteMessages|editMessageText|answerWidgetQuery) printf '%s %s\n' "$m" "$*" | sed 's/^deleteMessages/DEL/;s/^editMessageText/EDIT/;s/^answerWidgetQuery/ANS/' >> "$T/calls" ;; esac
	echo '{"ok":true,"result":{}}'
fi
SH
chmod +x "$T/curl"
export T

conf() {  # conf CHAT USERS [PROXY] [TG_CLEAN] [TG_WIDGETS]
	printf 'TG=1\nTG_TOKEN=123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nTG_CHAT=%s\nTG_USERS=%s\nTG_PROXY=%s\nTG_CLEAN=%s\nTG_WIDGETS=%s\n' "$1" "$2" "$3" "${4:-1}" "${5:-0}" > "$T/conf"
}
upd() {  # upd ЧАТ ОТПРАВИТЕЛЬ ТЕКСТ | upd cb ЧАТ ОТПРАВИТЕЛЬ ДАННЫЕ
	if [ "$1" = cb ]; then
		printf '{"ok":true,"result":[{"update_id":10,"callback_query":{"id":"77","from":{"id":%s,"is_bot":false},"message":{"message_id":5,"from":{"id":999,"is_bot":true},"chat":{"id":%s,"type":"supergroup"},"text":"x"},"data":"%s"}}]}' "$3" "$2" "$4" > "$T/updates"
	else
		printf '{"ok":true,"result":[{"update_id":10,"message":{"message_id":5,"from":{"id":%s,"is_bot":false},"chat":{"id":%s,"type":"supergroup"},"text":"%s"}}]}' "$2" "$1" "$3" > "$T/updates"
	fi
}
runbot() {
	: > "$T/calls"; rm -f "$T/rebooted" "$T/wifi.done" "$T/speed.started" "$T/guest.calls"
	NF_CONF="$T/conf" NF_DIR="$T" NF_CURL="$T/curl" NF_NOSLEEP=1 NF_ONCE=1 NF_NOTIFY="$L/nightfall-notify" NF_REBOOT="touch $T/rebooted" NF_PROC="$T/proc" NF_LEASES="$T/leases" \
		NF_WIDGETS="${NF_W:-$T/widgets}" NF_SPEEDBIN="$T/speedbin" NF_GUESTBIN="$T/guestbin" NF_WIFI="$T/wifibin" NF_INITD="$T/initd" sh "$L/nightfall-bot" >/dev/null 2>&1
}
# заглушки: замер скорости, гостевая сеть, wifi и init-скрипты
printf '#!/bin/sh\ntouch "$T/speed.started"\n' > "$T/speedbin"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "$T/guest.calls"\ncase "$1" in cands) printf "wifinet1|Guest|0|\\nwifinet2|Kids WiFi|1|1900000000\\n" ;; *) echo "{\\"ok\\":true}" ;; esac\n' > "$T/guestbin"
printf '#!/bin/sh\ntouch "$T/wifi.done"\n' > "$T/wifibin"
mkdir -p "$T/initd"; printf '#!/bin/sh\ntouch "$T/dns.done"\n' > "$T/initd/dnsmasq"
chmod +x "$T/speedbin" "$T/guestbin" "$T/wifibin" "$T/initd/dnsmasq"
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

# 6. очистка чата: ответ внизу, команда и старые ответы удаляются
conf 111 ""; rm -f "$T/mid"; printf '41\n42\n' > "$T/bot.msgs"; upd 111 111 "/status"; runbot; sleep 1
grep -E '^DEL .*message_ids=\[(5,41,42|41,42,5|5,42,41)\]|^DEL .*message_ids=\[[0-9,]*\]' "$T/calls" | grep -q '41' && grep '^DEL' "$T/calls" | grep -q '5,41,42' && ok "очистка: команда и старые ответы удалены" || bad "очистка: удаление не сработало: $(grep DEL "$T/calls")"
[ "$(cat "$T/bot.msgs")" = "101" ] && ok "очистка: в списке остался только новый ответ" || bad "очистка: список сообщений: $(tr '\n' ' ' < "$T/bot.msgs")"
conf 111 "" "" 0; rm -f "$T/mid"; printf '41\n' > "$T/bot.msgs"; upd 111 111 "/status"; runbot; sleep 1
grep -q '^DEL' "$T/calls" && bad "TG_CLEAN=0: сообщения удалены" || ok "TG_CLEAN=0: ничего не удаляется"
conf -100500 111; rm -f "$T/mid"; : > "$T/bot.msgs"; upd -100500 111 "/status"; runbot; sleep 1
grep -q '^DEL' "$T/calls" && bad "группа: сообщения удалены автоматически" || ok "группа: автоматическая очистка выключена"
# нажатие на последнем ответе правит его на месте, на старом приходит новое сообщение внизу
conf 111 ""; printf '41\n42\n' > "$T/bot.msgs"; upd cb 111 111 "status"; sed -i 's/"message_id":5/"message_id":42/' "$T/updates"; runbot; sleep 1
grep -q '^EDIT' "$T/calls" && ! grep -q '^DEL' "$T/calls" && ok "кнопка на последнем ответе: правка на месте" || bad "кнопка на последнем ответе: $(cat "$T/calls" | cut -c1-80)"
conf 111 ""; rm -f "$T/mid"; printf '41\n42\n' > "$T/bot.msgs"; upd cb 111 111 "status"; sed -i 's/"message_id":5/"message_id":41/' "$T/updates"; runbot; sleep 1
grep -q 'METHOD sendMessage' "$T/calls" && grep '^DEL' "$T/calls" | grep -q '41' && ok "кнопка на старом ответе: новое сообщение внизу, старые удалены" || bad "кнопка на старом ответе: $(cat "$T/calls" | cut -c1-80)"
# кнопка на уведомлении (его бот не отслеживает) правит его на месте и ничего не удаляет
conf 111 ""; printf '41\n' > "$T/bot.msgs"; upd cb 111 111 "status"; runbot; sleep 1
grep -q '^EDIT' "$T/calls" && ! grep -q '^DEL' "$T/calls" && ok "кнопка на уведомлении: правка на месте, ничего не удаляется" || bad "кнопка на уведомлении"
# «Очистить чат»
conf 111 ""; rm -f "$T/mid"; printf '41\n42\n' > "$T/bot.msgs"; upd cb 111 111 "cl"; sed -i 's/"message_id":5/"message_id":42/' "$T/updates"; runbot; sleep 1
grep '^DEL' "$T/calls" | grep -q '41' && grep -q 'Чат очищен' "$T/calls" && ok "«Очистить чат»: удалены все сообщения бота" || bad "«Очистить чат»: $(cat "$T/calls" | cut -c1-80)"
conf -100500 111; upd -100500 222 "/clear"; runbot; sleep 1
grep -q '^DEL' "$T/calls" && bad "группа: посторонний очистил чат" || ok "группа: посторонний не очищает чат"

# 7. замер скорости по кнопке
conf 111 ""; printf '1700000000 94.20 25000000 12.0 0 ok\n' > "$T/speed.log"; upd cb 111 111 "sp:run"; runbot; sleep 3
[ -e "$T/speed.started" ] && ok "скорость: замер запущен" || bad "скорость: замер не запущен"
grep -q 'Замеряю скорость' "$T/calls" && grep -q 'Последний замер скорости' "$T/calls" && ok "скорость: результат показан в том же сообщении" || bad "скорость: нет результата"
grep -q 'sp:run' "$T/calls" || true
conf -100500 111; upd -100500 222 "/speed"; runbot
[ -e "$T/speed.started" ] && bad "скорость: просмотр запустил замер" || ok "скорость: просмотр не запускает замер"
conf -100500 111; upd cb -100500 222 "sp:run"; runbot; sleep 1
[ -e "$T/speed.started" ] && bad "скорость: посторонний в группе запустил замер" || ok "скорость: посторонний не запускает замер"

# 8. гостевой Wi-Fi
conf 111 ""; upd 111 111 "/guest"; runbot
grep -q 'Guest' "$T/calls" && grep -q 'Kids WiFi: включена до' "$T/calls" && ok "гостевой Wi-Fi: список сетей" || bad "гостевой Wi-Fi: список: $(cat "$T/calls" | cut -c1-120)"
conf 111 ""; upd cb 111 111 "gs:on:wifinet1:60"; runbot
grep -qx 'on wifinet1 60' "$T/guest.calls" && ok "гостевой Wi-Fi: включение на час" || bad "гостевой Wi-Fi: включение: $(cat "$T/guest.calls" 2>/dev/null)"
conf 111 ""; upd cb 111 111 "gs:off:wifinet2"; runbot
grep -qx 'off wifinet2' "$T/guest.calls" && ok "гостевой Wi-Fi: выключение" || bad "гостевой Wi-Fi: выключение"
conf 111 ""; upd cb 111 111 "gs:on:wifinet1:abc"; runbot
grep -q '^on' "$T/guest.calls" 2>/dev/null && bad "гостевой Wi-Fi: принято неверное время" || ok "гостевой Wi-Fi: неверное время отклонено"
conf -100500 111; upd cb -100500 222 "gs:on:wifinet1:60"; runbot
[ -s "$T/guest.calls" ] && bad "гостевой Wi-Fi: посторонний в группе включил сеть" || ok "гостевой Wi-Fi: посторонний не управляет"

# 9. перезапуск служб
conf 111 ""; upd cb 111 111 "rs:wifi"; runbot
grep -q 'Подтвердите в течение минуты' "$T/calls" && grep -q 'Перезапустить: Wi-Fi' "$T/calls" && ok "службы: просьба подтверждения" || bad "службы: нет подтверждения"
[ -e "$T/wifi.done" ] && bad "службы: перезапуск без подтверждения"
conf 111 ""; echo "wifi $(date +%s)" > "$T/restart.ask"; upd cb 111 111 "rs:y:wifi"; runbot; sleep 3
[ -e "$T/wifi.done" ] && ok "службы: Wi-Fi перезапущен после подтверждения" || bad "службы: Wi-Fi не перезапущен"
[ -e "$T/restart.ask" ] && bad "службы: подтверждение не одноразовое" || ok "службы: подтверждение одноразовое"
conf 111 ""; echo "dns $(date +%s)" > "$T/restart.ask"; upd cb 111 111 "rs:y:wifi"; runbot; sleep 3
[ -e "$T/wifi.done" ] && bad "службы: подтверждение чужой службы сработало" || ok "службы: подтверждение привязано к службе"
conf 111 ""; echo "dns $(( $(date +%s) - 120 ))" > "$T/restart.ask"; upd cb 111 111 "rs:y:dns"; runbot; sleep 3
[ -e "$T/dns.done" ] && bad "службы: устаревшее подтверждение сработало" || ok "службы: устаревшее подтверждение отклонено"
conf 111 ""; rm -f "$T/restart.ask"; upd cb 111 111 "rs:y:dns"; runbot; sleep 3
[ -e "$T/dns.done" ] && bad "службы: сработало без запроса" || ok "службы: без запроса не срабатывает"
conf -100500 111; echo "wifi $(date +%s)" > "$T/restart.ask"; upd cb -100500 222 "rs:y:wifi"; runbot; sleep 3
[ -e "$T/wifi.done" ] && bad "службы: посторонний в группе перезапустил Wi-Fi" || ok "службы: посторонний не перезапускает"

# 11. виджет «Статус» (Bot API 10.4)
mkdir -p "$T/widgets"; cp "$L/../share/nightfall/widgets/status.html" "$T/widgets/status.html"
printf '1700000000 12 0 61.5 1250000 125000 0 12.3\n' > "$T/hist.fine"
printf 'MemTotal: 1000 kB\nMemAvailable: 400 kB\n' > "$T/proc/meminfo"
wq() {  # wq ЧАТ ДАННЫЕ
	printf '{"ok":true,"result":[{"update_id":10,"widget_query":{"id":"wq77","from":{"id":111,"is_bot":false},"chat":{"id":%s,"type":"private"},"message_id":88,"data":"%s"}}]}' "$1" "$2" > "$T/updates"
}
conf 111 "" "" 1 0; rm -f "$T/mid"; upd 111 111 "/status"; runbot
grep -q 'METHOD sendWidget' "$T/calls" && bad "виджет: отправлен при выключенной настройке" || ok "виджет: выключен по умолчанию, приходит обычный текст"
conf 111 "" "" 1 1; rm -f "$T/mid" "$T/bot.widgets"; : > "$T/bot.msgs"; upd 111 111 "/status"; runbot
[ ! -e "$T/bot.widget.err" ] && ok "виджет: после удачной отправки ошибка стёрта" || bad "виджет: старая ошибка осталась"
grep -q 'METHOD sendWidget' "$T/calls" && ok "виджет: отправлен" || bad "виджет: не отправлен: $(cut -c1-80 "$T/calls")"
grep 'METHOD sendWidget' "$T/calls" | grep -q 'allow_queries=true' && ok "виджет: разрешены запросы из виджета" || bad "виджет: нет allow_queries"
grep 'METHOD sendWidget' "$T/calls" | grep -q '\[caption\] 📊 testrouter' && ok "виджет: подпись с текстом статуса для старых клиентов" || bad "виджет: нет подписи"
cd=$(grep 'METHOD sendWidget' "$T/calls" | sed 's/.*\[chat_data\] \({[^}]*}\).*/\1/')
printf '%s' "$cd" | python3 -I -c 'import sys,json; d=json.loads(sys.stdin.read()); assert d["h"]=="testrouter" and d["c"]==12 and d["m"]==60 and d["t"]==61.5 and d["p"]==12 and d["d"]==10.0 and d["u"]==1.0 and "r" in d and "w" in d' 2>/dev/null && ok "виджет: данные верные и это корректный JSON" || bad "виджет: данные: $cd"
[ ${#cd} -lt 1024 ] && ok "виджет: данные меньше 1024 байт" || bad "виджет: данные слишком большие"
[ "$(cat "$T/bot.widgets" 2>/dev/null)" = 101 ] && ok "виджет: сообщение запомнено" || bad "виджет: не запомнено: $(cat "$T/bot.widgets" 2>/dev/null)"
conf 111 "" "" 1 1; rm -f "$T/mid"; upd cb 111 111 "status"; runbot; sleep 1
grep -q 'METHOD sendWidget' "$T/calls" && grep '^DEL' "$T/calls" | grep -q 'message_ids=\[5\]' && ok "виджет: из меню присылается новый, сообщение с кнопкой убрано" || bad "виджет: из меню: $(cut -c1-90 "$T/calls")"
touch "$T/widget.fail"; conf 111 "" "" 1 1; rm -f "$T/mid"; upd 111 111 "/status"; runbot
grep -q 'METHOD sendMessage' "$T/calls" && grep 'METHOD sendMessage' "$T/calls" | grep -q '📊 testrouter' && ok "виджет: ошибка Telegram, пришёл обычный текст" || bad "виджет: нет запасного текста"
rm -f "$T/widget.fail"
[ -s "$T/bot.widget.err" ] && ok "виджет: причина отказа записана в bot.widget.err" || bad "виджет: причина отказа не записана"
conf 111 "" "" 1 1; rm -f "$T/mid"; upd 111 111 "/widget"; runbot
grep 'METHOD sendMessage' "$T/calls" | grep -q 'Живые виджеты' && grep 'METHOD sendMessage' "$T/calls" | grep -q 'последняя ошибка' && ok "/widget: показывает последнюю ошибку" || bad "/widget: $(cut -c1-120 "$T/calls")"
printf '%s %s\n' "$(date +%s)" '{"ok":false,"error_code":400,"description":"Bad Request: INPUT_MEDIA_WIDGET_NOT_ALLOWED"}' > "$T/bot.widget.err"; rm -f "$T/mid"; upd 111 111 "/widget"; runbot
grep 'METHOD sendMessage' "$T/calls" | grep -q 'включаются постепенно' && ok "/widget: объясняет ошибку INPUT_MEDIA_WIDGET_NOT_ALLOWED" || bad "/widget: нет пояснения к NOT_ALLOWED: $(cut -c1-160 "$T/calls")"
grep 'METHOD sendMessage' "$T/calls" | grep -q 'Настройка: включены' && ok "/widget: показывает, что виджеты включены" || bad "/widget: нет состояния настройки"
NF_W="$T/nowidgets" conf 111 "" "" 1 1; rm -f "$T/mid"; upd 111 111 "/status"; NF_W="$T/nowidgets" runbot
grep -q 'METHOD sendWidget' "$T/calls" && bad "виджет: отправлен без файла" || ok "виджет: нет файла шаблона, пришёл обычный текст"
conf -100500 111 "" 1 1; upd -100500 111 "/status"; runbot
grep -q 'METHOD sendWidget' "$T/calls" && bad "виджет: отправлен в группу" || ok "виджет: в группе не отправляется"
conf 111 "" "" 1 0; rm -f "$T/mid"; upd 111 111 "/widget"; runbot
grep 'METHOD sendMessage' "$T/calls" | grep -q 'Настройка: выключены' && ok "/widget: показывает, что виджеты выключены" || bad "/widget (выключены): $(cut -c1-120 "$T/calls")"
# текст «Статуса»: полоски и цветные точки
conf 111 "" "" 1 0; rm -f "$T/mid"; upd 111 111 "/status"; runbot
st=$(grep 'METHOD sendMessage' "$T/calls")
case "$st" in *'Процессор'*'▰▱▱▱▱▱▱▱▱▱'*'12%'*) ok "статус: полоска процессора (12% = 1 деление)" ;; *) bad "статус: нет полоски процессора: $st" ;; esac
case "$st" in *'🟢 Память'*'▰▰▰▰▰▰▱▱▱▱'*'60%'*) ok "статус: память 60% (6 делений)" ;; *) bad "статус: память: $st" ;; esac
case "$st" in *'🟢 Интернет: есть, 12 мс'*'🟢 Температура: 61.5'*) ok "статус: интернет и температура" ;; *) bad "статус: интернет/температура: $st" ;; esac
printf '1700000000 95 0 88.0 1250000 125000 0 -1\n' > "$T/hist.fine"; rm -f "$T/mid"; upd 111 111 "/status"; runbot
st=$(grep 'METHOD sendMessage' "$T/calls")
case "$st" in *'🔴 Процессор'*'▰▰▰▰▰▰▰▰▰▰'*) ok "статус: высокая загрузка красная" ;; *) bad "статус: загрузка 95%: $st" ;; esac
case "$st" in *'🔴 Температура: 88.0'*'🔴 Интернет: НЕТ СВЯЗИ'*|*'🔴 Интернет: НЕТ СВЯЗИ'*'🔴 Температура: 88.0'*) ok "статус: нет связи и жара красные" ;; *) bad "статус: красные: $st" ;; esac
printf '1700000000 12 0 61.5 1250000 125000 0 12.3\n' > "$T/hist.fine"
# запрос из виджета
conf 111 "" "" 1 1; wq 111 s; runbot
a=$(grep '^ANS' "$T/calls" | sed 's/.*widget_query_id=wq77.*data=\({.*}\).*/\1/')
printf '%s' "$a" | python3 -I -c 'import sys,json; d=json.loads(sys.stdin.read()); assert d["c"]==12 and d["m"]==60' 2>/dev/null && ok "виджет: запрос «s» получил свежие данные" || bad "виджет: ответ на запрос: $(grep '^ANS' "$T/calls")"
conf 111 "" "" 1 1; wq 111 zzz; runbot
grep '^ANS' "$T/calls" | grep -q 'widget_query_id=wq77' && ! grep '^ANS' "$T/calls" | grep -q '{' && ok "виджет: на незнакомый запрос ответ пустой, но ответ есть" || bad "виджет: неизвестный запрос"
conf 111 "" "" 1 1; wq 999 s; runbot
grep -q '^ANS' "$T/calls" && bad "виджет: ответ в чужой чат" || ok "виджет: запрос из чужого чата игнорируется"
conf 111 "" "" 1 1; wq 111 s; runbot
grep -q 'METHOD sendMessage\|METHOD sendWidget' "$T/calls" && bad "виджет: запрос породил сообщение в чате" || ok "виджет: запрос не плодит сообщения"
# кнопка под виджетом: приходит новое сообщение, виджет удаляется
conf 111 "" "" 1 1; rm -f "$T/mid"; echo 88 > "$T/bot.widgets"; printf '88\n' > "$T/bot.msgs"; upd cb 111 111 "menu"; sed -i 's/"message_id":5/"message_id":88/' "$T/updates"; runbot; sleep 1
grep -q 'METHOD sendMessage' "$T/calls" && ! grep -q '^EDIT' "$T/calls" && grep '^DEL' "$T/calls" | grep -q '88' && ok "виджет: «Меню» под виджетом шлёт новое сообщение и удаляет виджет" || bad "виджет: меню под виджетом: $(cut -c1-90 "$T/calls")"
# настройка
printf 'TG_WIDGETS=0\n' > "$T/c3"
r=$(NF_CONF="$T/c3" NF_DEF="$T/c3" NF_NORESTART=1 sh "$L/nightfall-config" set TG_WIDGETS=1); case "$r" in *'"ok":true'*) ok "TG_WIDGETS: значение принято" ;; *) bad "TG_WIDGETS: $r" ;; esac
r=$(NF_CONF="$T/c3" NF_DEF="$T/c3" NF_NORESTART=1 sh "$L/nightfall-config" set TG_WIDGETS=5); case "$r" in *'"ok":false'*) ok "TG_WIDGETS: мусор отклонён" ;; *) bad "TG_WIDGETS: мусор принят" ;; esac
# размер шаблона: после сжатия zlib не больше 4096 байт, сырой не больше 32768
python3 -I -c 'import sys,zlib; d=open(sys.argv[1],"rb").read(); assert len(d)<=32768 and len(zlib.compress(d,9))<=4096, (len(d), len(zlib.compress(d,9)))' "$L/../share/nightfall/widgets/status.html" && ok "виджет: размер в пределах лимитов Telegram" || bad "виджет: превышен размер"

# 10. список сетей для бота из настроек Wi-Fi (uci)
cat > "$T/uci" <<'SH'
#!/bin/sh
cat <<'EOF'
wireless.wifinet0=wifi-iface
wireless.wifinet0.mode='ap'
wireless.wifinet0.ssid='Home'
wireless.wifinet0.network='lan'
wireless.wifinet1=wifi-iface
wireless.wifinet1.mode='ap'
wireless.wifinet1.ssid='Guest "Net"'
wireless.wifinet1.network='guest'
wireless.wifinet1.disabled='1'
wireless.wifinet2=wifi-iface
wireless.wifinet2.mode='ap'
wireless.wifinet2.ssid='Гости'
wireless.wifinet2.network='lan'
wireless.wifinet3=wifi-iface
wireless.wifinet3.mode='sta'
wireless.wifinet3.ssid='Uplink'
wireless.wifinet3.disabled='1'
wireless.@wifi-iface[4]=wifi-iface
wireless.@wifi-iface[4].mode='ap'
wireless.@wifi-iface[4].ssid='Spare'
wireless.@wifi-iface[4].disabled='1'
EOF
SH
chmod +x "$T/uci"; echo 'wifinet2|1900000000' > "$T/guest.list"
c=$(NF_UCI="$T/uci" NF_GUESTF="$T/guest.list" sh "$L/nightfall-guest" cands)
[ "$(printf '%s\n' "$c" | wc -l)" = 3 ] && ok "cands: найдено три сети (выключенная, с «гост» в названии и без привязки)" || bad "cands: $(printf '%s' "$c" | tr '\n' ';')"
printf '%s\n' "$c" | grep -qx 'wifinet1|Guest Net|0|' && ok "cands: кавычки в имени сети убраны" || bad "cands: имя сети"
printf '%s\n' "$c" | grep -qx 'wifinet2|Гости|1|1900000000' && ok "cands: включённая сеть с временем выключения" || bad "cands: включённая сеть"
printf '%s\n' "$c" | grep -q 'Home\|Uplink' && bad "cands: попали обычная сеть или клиент" || ok "cands: обычная сеть и клиент не попали"

# 12. сохранение всей формы настроек, когда в файле пользователя нет части параметров (ошибка «PERSIST_ANY: допустимо 0 или 1»)
cp "$L/../share/nightfall/nightfall-monitor.conf.default" "$T/def"
grep -v '^PERSIST_ANY=' "$T/def" > "$T/def.old"       # файл по умолчанию из версий, где этого параметра не было
printf 'TG=1\nTG_CHAT=111\n' > "$T/user.conf"           # пользователь раньше сохранял только поля Telegram
form() {   # form ФАЙЛ_ПО_УМОЛЧАНИЮ: форма как на странице (значение из файла пользователя, а если его нет, из файла по умолчанию)
	for k in $(sed -n 's/^KEYS="\(.*\)"/\1/p' "$L/nightfall-config"); do
		if grep -q "^$k=" "$T/user.conf"; then f="$T/user.conf"; else f="$1"; fi
		v=$(sed -n "s/^$k=\"\{0,1\}\([^ #\"]*\).*/\1/p" "$f" | head -n 1)
		[ "$k" = TG_TOKEN ] && v="***"
		printf '%s=%s\n' "$k" "$v"
	done
}
form "$T/def.old" | grep -qx 'PERSIST_ANY=' && ok "форма настроек (старый файл по умолчанию): PERSIST_ANY приходит пустым, как у пользователя" || bad "форма настроек: не воспроизвелась пустое поле"
cp "$T/user.conf" "$T/user.keep"
r=$(form "$T/def.old" | NF_CONF="$T/user.conf" NF_DEF="$T/def.old" NF_NORESTART=1 xargs -d '\n' sh "$L/nightfall-config" set)
case "$r" in *'"ok":true'*) ok "форма настроек: сохраняется, хотя PERSIST_ANY пустой" ;; *) bad "форма настроек: $r" ;; esac
grep -q '^PERSIST_ANY=0' "$T/user.conf" && ok "форма настроек: PERSIST_ANY получил 0" || bad "форма настроек: PERSIST_ANY не записан"
cp "$T/user.keep" "$T/user.conf"
r=$(form "$T/def" | NF_CONF="$T/user.conf" NF_DEF="$T/def" NF_NORESTART=1 xargs -d '\n' sh "$L/nightfall-config" set)
case "$r" in *'"ok":true'*) ok "форма настроек: сохраняется и с новым файлом по умолчанию" ;; *) bad "форма настроек (новый файл): $r" ;; esac
r=$(NF_CONF="$T/user.conf" NF_DEF="$T/def" NF_NORESTART=1 sh "$L/nightfall-config" set TG_WIDGETS=1 TG_CLEAN=)
case "$r" in *'"ok":true'*) ok "TG_WIDGETS=1 вместе с пустым флажком сохраняется" ;; *) bad "TG_WIDGETS: $r" ;; esac
grep -q '^TG_WIDGETS=1' "$T/user.conf" && grep -q '^TG_CLEAN=1' "$T/user.conf" && ok "виджеты включены, пустой TG_CLEAN получил значение по умолчанию 1" || bad "значения не записаны: $(tr '\n' ' ' < "$T/user.conf")"
r=$(NF_CONF="$T/user.conf" NF_DEF="$T/def" NF_NORESTART=1 sh "$L/nightfall-config" set PERSIST_ANY=7)
case "$r" in *'"ok":false'*) ok "неверное значение флажка (7) по-прежнему отклоняется" ;; *) bad "значение 7 принято: $r" ;; esac
r=$(NF_CONF="$T/user.conf" NF_DEF="$T/def" NF_NORESTART=1 sh "$L/nightfall-config" set TEMP_WARN=)
case "$r" in *'"ok":false'*) ok "пустое число (TEMP_WARN) по-прежнему отклоняется" ;; *) bad "пустое число принято: $r" ;; esac
r=$(NF_CONF="$T/user.conf" NF_DEF="$T/def" sh "$L/nightfall-config" get)
printf '%s' "$r" | grep -q '"PERSIST_ANY":"0"' && ok "страница получает PERSIST_ANY=0, а не пустое значение" || bad "get: PERSIST_ANY пустой"

[ $fail = 0 ] && echo "ВСЁ В ПОРЯДКЕ" || { echo "ЕСТЬ ОШИБКИ"; exit 1; }
