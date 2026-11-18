#!/bin/sh
# Regression checks for the built-in application domain catalog.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
RULES="$ROOT/luci-app-nightfall-monitor/root/usr/share/nightfall/apps.list"
[ -r "$RULES" ] || { echo "Missing app catalog: $RULES" >&2; exit 1; }
awk -v rules="$RULES" '
function load(f, line, a, d, n, i) {
  while ((getline line < f) > 0) {
    if (line ~ /^#/ || line == "") continue
    n = split(line, a, "|")
    if (n < 2 || a[1] == "") { print "FAIL: malformed rule: " line > "/dev/stderr"; failed++; continue }
    split(a[2], d, " ")
    for (i in d) if (d[i] != "" && !(d[i] in dom)) dom[d[i]] = a[1]
  }
  close(f)
}
function cls(n, p) { n = tolower(n); while (1) { if (n in dom) return dom[n]; p = index(n, "."); if (!p) return ""; n = substr(n, p + 1) } }
function check(host, want, got) { got = cls(host); if (got != want) { printf "FAIL: %s -> <%s>, expected <%s>\n", host, got, want > "/dev/stderr"; failed++ } else printf "OK: %s -> %s\n", host, got }
BEGIN {
  load(rules)
  check("www.youtube.com", "YouTube")
  check("rr1---sn.googlevideo.com", "YouTube")
  check("video.rutube.ru", "RuTube")
  check("cdn.rtbcdn.ru", "RuTube")
  check("video.vkvideo.ru", "VK Видео")
  check("api.max.ru", "MAX")
  check("static.wb.ru", "Wildberries")
  check("cdn.ozon.ru", "Ozon")
  check("githubusercontent.com", "GitHub")
  check("drive.google.com", "Google Drive")
  check("photos.google.com", "Google Photos")
  check("p123-icloud.com", "")
  check("api.icloud.com", "Apple iCloud")
  check("api.oneme.ru", "MAX")
  check("static.wildberries.ru", "Wildberries")
  check("m.avito.ru", "Avito")
  check("dzen.ru", "Дзен")
  check("app.rustore.ru", "RuStore")
  check("api.tbank.ru", "Т-Банк")
  check("download.kaspersky.com", "Kaspersky")
  check("githubassets.com", "GitHub")
  check("unmapped.cdn77.org", "")
  if (failed) exit 1
}'
echo "Application catalog tests: all passed."
