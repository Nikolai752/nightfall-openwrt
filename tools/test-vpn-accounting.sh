#!/bin/sh
# Route-aware VPN accounting regression tests. Runs with POSIX shell + awk.
set -eu
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
COLLECTOR=luci-app-nightfall-monitor/root/usr/libexec/nightfall-collector
CONFIG=luci-app-nightfall-monitor/root/usr/libexec/nightfall-config

# Exercise the exact production classifier functions, not a copied implementation.
sed -n '/function hexdec(s/,/function appof(ip/{ /function appof(ip/d; p; }' "$COLLECTOR" > "$TMP/classifier.awk"
sed -n '/function appof(ip,   i)/,/^[[:space:]]*}/p' "$COLLECTOR" >> "$TMP/classifier.awk"
cat >> "$TMP/classifier.awk" <<'AWK'
function check(name, got, want) {
  if (got != want) {
    printf "FAIL: %s: got <%s>, expected <%s>\n", name, got, want > "/dev/stderr"
    failed++
  } else printf "OK: %s\n", name
}
BEGIN {
  # Typical selective-routing marks, discovered from ip rule at runtime.
  nr = 2
  rv[1] = 1048576; rm[1] = 267386880; rc[1] = "VPN"
  rv[2] = 5242880; rm[2] = 267386880; rc[2] = "VPN"
  main_dev = "eth0"; main_tunnel = 0; policy_unknown = 0
  check("VLESS/WARP route mark 0x40100000", routeof("1074790400"), "VPN")
  check("second VPN route mark 0x40500000", routeof("1078984704"), "VPN")
  check("Zapret-only mark is not mistaken for VPN", routeof("1073741824"), "Direct")
  check("unmarked flow on ordinary WAN", routeof("0"), "Direct")

  nr = 0
  check("router without VPN classifies WAN as Direct", routeof("0"), "Direct")
  main_dev = "wg0"; main_tunnel = 1
  check("full-tunnel WireGuard default route", routeof("0"), "VPN")
  main_dev = "eth0"; main_tunnel = 0; policy_unknown = 1
  check("unsupported source-policy routing stays Unknown", routeof("0"), "Unknown")
  nr = 1; rv[1] = 123; rm[1] = 255; rc[1] = "Unknown"
  check("matching non-tunnel policy route stays Unknown", routeof("123"), "Unknown")

  am["8.8.8.8"] = "Google"
  check("application identity remains Google", appof("8.8.8.8"), "Google")
  check("VPN endpoint is not renamed to VPN application", appof("195.19.105.24"), "Прочее")
  if (failed) exit 1
}
AWK
awk -f "$TMP/classifier.awk"
sh -n "$COLLECTOR"
sh -n "$CONFIG"
echo "VPN route accounting tests: all passed."
