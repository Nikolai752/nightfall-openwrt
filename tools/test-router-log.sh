#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
L="luci-app-nightfall-monitor/root/usr/libexec/nightfall-log"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT HUP INT TERM
ok=0; bad=0
check() {
  name="$1"; expected="$2"; output="$3"
  printf '%s' "$output" | grep -Fq "$expected" && { ok=$((ok + 1)); echo "ok  $name"; } || { bad=$((bad + 1)); echo "ОШИБКА: $name: $output"; }
}
cat > "$T/logread-ok" <<'EOF'
#!/bin/sh
cat <<'LOG'
Wed Nov 25 11:00:01 2026 daemon.notice netifd: lease renewed
Nov 25 11:00:02 steerd[12] daemon.warn: tunnel warning
2026-11-25T11:00:03+03:00 router daemon.err dnsmasq[3]: no upstream servers
<27>1 2026-11-25T11:00:04Z router dropbear 123 BADLOGIN - Bad password attempt
[25 нояб., 11:00:05] user.notice dispatcher.uc: accepted login
[25 нояб. 2026 г., 09:42:11 GMT+4] kern.err: [592125.596682] rtw88_8821cu: error beacon valid
LOG
EOF
cat > "$T/logread-fail" <<'EOF'
#!/bin/sh
echo "simulated logread failure" >&2
exit 7
EOF
chmod +x "$T/logread-ok" "$T/logread-fail"
r=$(NF_LOGREAD="$T/logread-ok" sh "$L" read 20)
printf '%s' "$r" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' >/dev/null
check "BusyBox weekday timestamp" '"daemon.notice","netifd","lease renewed' "$r"
check "RFC3164 timestamp" '"daemon.warn","steerd","tunnel warning' "$r"
check "ISO timestamp" '"daemon.err","dnsmasq","no upstream servers' "$r"
check "RFC5424 numeric PRI" '"syslog.err","dropbear","Bad password attempt' "$r"
check "localized short timestamp" '"user.notice","dispatcher.uc","accepted login' "$r"
check "localized long timestamp and kernel facility" '"kern.err","kernel","[592125.596682]' "$r"
r=$(NF_LOGREAD="$T/logread-fail" sh "$L" read 20)
check "non-zero logread status is not empty journal" '"ok":false' "$r"
check "logread exit code is exposed" 'кодом 7' "$r"
r=$(NF_LOGREAD="$T/missing" sh "$L" read 20)
check "missing logread is diagnosed" 'Команда logread не найдена' "$r"
: > "$T/logread-empty"; chmod +x "$T/logread-empty"
r=$(NF_LOGREAD="$T/logread-empty" sh "$L" read 20)
check "empty journal remains a valid empty result" '"ok":true,"rows":[]' "$r"
echo "ИТОГО: $ok успешно, $bad ошибок"
[ "$bad" -eq 0 ]
