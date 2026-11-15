#!/bin/sh
# Тесты истории температур по датчикам (сборщик + nightfall-history temps): sh tools/test-temps.sh
cd "$(dirname "$0")/.." || exit 1
L=$(pwd)/luci-app-nightfall-monitor/root/usr/libexec
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
ok=0; bad=0
want() { case "$3" in *"$2"*) ok=$((ok+1)); echo "ok   $1" ;; *) bad=$((bad+1)); echo "FAIL $1: ждали «$2», получили «$3»" ;; esac; }
S=$T/sys; mkdir -p "$S/class/thermal/thermal_zone0" "$S/class/hwmon/hwmon0" "$S/class/hwmon/hwmon1" "$S/class/hwmon/hwmon2"
echo cpu_thermal > "$S/class/thermal/thermal_zone0/type"; echo 70412 > "$S/class/thermal/thermal_zone0/temp"
echo mt7915_phy0 > "$S/class/hwmon/hwmon0/name"; echo 65000 > "$S/class/hwmon/hwmon0/temp1_input"
echo mt7915_phy0 > "$S/class/hwmon/hwmon1/name"; echo 66500 > "$S/class/hwmon/hwmon1/temp1_input"   # повтор имени
echo broken > "$S/class/hwmon/hwmon2/name"; echo 0 > "$S/class/hwmon/hwmon2/temp1_input"            # нулевой замер игнорируется
run() { NF_SYS=$S NF_DIR=$T/d NF_CONF=/dev/null NF_LOOPS=5 NF_STEP=1 NF_AGG=2 NF_NOTIFY=true NF_KNOWN=$T/k NF_BLOCK=$T/b NF_GROUPS=$T/g NF_JOURNAL=$T/j timeout 60 sh "$L/nightfall-collector" >/dev/null 2>&1; }
hist() { NF_DIR=$T/d sh "$L/nightfall-history" "$@"; }

want "до запуска: пустой ответ" '"rows":[]' "$(hist temps fine)"
run
want "в файле час: имя:°C со десятой долей" "cpu_thermal:70.4 mt7915_phy0:65.0 mt7915_phy0#2:66.5" "$(cat $T/d/temps.fine)"
want "нулевой датчик не пишется" "" "$(grep -c broken $T/d/temps.fine | grep -x 0)"
want "есть 5-минутные точки" "cpu_thermal:70.4" "$(cat $T/d/temps.coarse)"
J=$(hist temps fine)
want "JSON: имена по порядку" '"names":["cpu_thermal","mt7915_phy0","mt7915_phy0#2"]' "$J"
want "JSON: шаг 15 с" '"step":15' "$J"
want "JSON: строка со значениями" ',70.4,65.0,66.5]' "$J"
want "coarse: шаг 300 с" '"step":300' "$(hist temps coarse)"
# датчик появился позже: у прежних строк -1
printf '1800000000 cpu_thermal:50.0\n1800000015 cpu_thermal:51.0 wifi:40.0\n' > "$T/d/temps.fine"
J=$(hist temps fine)
want "новый датчик: у старых строк -1" '[1800000000,50.0,-1]' "$J"
want "новый датчик: у новых значение" '[1800000015,51.0,40.0]' "$J"
want "JSON корректен" "" "$(printf '%s' "$J" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("" if len(d["rows"][0])==len(d["names"])+1 else "x")')"
grep -q 'temps.coarse' "$L/nightfall-collector" && grep -q 'PFILES="hist.coarse temps.coarse' "$L/nightfall-collector" && { ok=$((ok+1)); echo "ok   temps.coarse сохраняется на флеш при включённом хранении"; } || { bad=$((bad+1)); echo "FAIL temps.coarse не в списке сохранения"; }
echo; echo "ИТОГО: ok=$ok, ошибок=$bad"
[ "$bad" -eq 0 ]
