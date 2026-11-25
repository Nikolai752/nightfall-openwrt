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
Nov 25 09:00:01 daemon.err dnsmasq: no upstream servers
EOF
cat > "$T/logread-fail" <<'EOF'
#!/bin/sh
echo "simulated logread failure" >&2
exit 7
EOF
chmod +x "$T/logread-ok" "$T/logread-fail"
r=$(NF_LOGREAD="$T/logread-ok" sh "$L" read 20)
check "обычная запись читается" '"daemon.err","dnsmasq","no upstream servers"' "$r"
r=$(NF_LOGREAD="$T/logread-fail" sh "$L" read 20)
check "ненулевой код logread не маскируется пустым журналом" '"ok":false' "$r"
check "код ошибки logread виден" 'кодом 7' "$r"
r=$(NF_LOGREAD="$T/does-not-exist" sh "$L" read 20)
check "отсутствующий logread диагностируется" 'Команда logread не найдена' "$r"
: > "$T/logread-empty"
chmod +x "$T/logread-empty"
r=$(NF_LOGREAD="$T/logread-empty" sh "$L" read 20)
check "пустой журнал остаётся успешным пустым ответом" '"ok":true,"rows":[]' "$r"
echo "ИТОГО: $ok успешно, $bad ошибок"
[ "$bad" -eq 0 ]
