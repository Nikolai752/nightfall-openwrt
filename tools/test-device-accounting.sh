#!/bin/sh
# Проверка классификатора устройств из настоящего nightfall-collector.
set -eu
cd "$(dirname "$0")/.."
COLLECTOR="luci-app-nightfall-monitor/root/usr/libexec/nightfall-collector"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
printf '%s\n' '192.168.1.0/24' > "$TMP/nets"
printf '%s\n' '192.168.1.1' '10.108.218.227' '172.16.0.2' > "$TMP/router"
sed -n '/^[[:space:]]*function isprivate(ip)/,/^[[:space:]]*BEGIN {/p' "$COLLECTOR" | sed '$d' > "$TMP/classifier.awk"
cat >> "$TMP/classifier.awk" <<'AWK'
BEGIN {
  while ((getline l < ENVIRON["NF_TEST_NETS"]) > 0) nets[++nn] = l
  close(ENVIRON["NF_TEST_NETS"])
  while ((getline l < ENVIRON["NF_TEST_ROUTER"]) > 0) router[l] = 1
  close(ENVIRON["NF_TEST_ROUTER"])
}
{
  got = (islan($2) && !isrouter($2)) ? 1 : 0
  if (got != $3) {
    printf "FAIL %s: expected=%s got=%s\n", $1, $3, got
    failed = 1
  } else {
    printf "OK %s\n", $1
  }
}
END { exit failed }
AWK
NF_TEST_NETS="$TMP/nets" NF_TEST_ROUTER="$TMP/router" awk -f "$TMP/classifier.awk" <<'CASES'
lan-client 192.168.1.214 1
lan-router-address 192.168.1.1 0
private-wan-address 10.108.218.227 0
vpn-tunnel-address 172.16.0.2 0
public-address 8.8.8.8 0
ula-client fd61:bde8:2d8d::805 1
CASES
echo "Классификатор LAN: все проверки пройдены."
