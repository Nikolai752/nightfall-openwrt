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
  nr = 3
  rf[1] = "4"; rv[1] = 1048576; rm[1] = 267386880; rc[1] = "VPN"
  rf[2] = "4"; rv[2] = 5242880; rm[2] = 267386880; rc[2] = "VPN"
  rf[3] = "6"; rv[3] = 1048576; rm[3] = 267386880; rc[3] = "VPN"
  main_dev["4"] = "eth0"; main_tunnel["4"] = 0; policy_unknown["4"] = 0; tunnel_present["4"] = 1; vpn_rule_found["4"] = 1
  main_dev["6"] = "eth0"; main_tunnel["6"] = 0; policy_unknown["6"] = 0; tunnel_present["6"] = 1; vpn_rule_found["6"] = 1
  check("VLESS/WARP route mark 0x40100000", routeof("1074790400", "4"), "VPN")
  check("second VPN route mark 0x40500000", routeof("1078984704", "4"), "VPN")
  check("IPv6 selective VPN route mark", routeof("1074790400", "6"), "VPN")
  check("Zapret-only mark is not mistaken for VPN", routeof("1073741824", "4"), "Direct")
  check("unmarked flow on ordinary WAN", routeof("0", "4"), "Direct")
  check("missing conntrack mark with VPN rules is Unknown", routeof("", "4"), "Unknown")

  nr = 0; tunnel_present["4"] = 0; vpn_rule_found["4"] = 0
  check("router without VPN classifies WAN as Direct", routeof("0", "4"), "Direct")
  tunnel_present["4"] = 1
  check("unmapped active tunnel is not called Direct", routeof("0", "4"), "Unknown")
  main_dev["4"] = "wg0"; main_tunnel["4"] = 1
  check("full-tunnel WireGuard default route", routeof("0", "4"), "VPN")
  main_dev["4"] = "eth0"; main_tunnel["4"] = 0; policy_unknown["4"] = 1; tunnel_present["4"] = 1; vpn_rule_found["4"] = 0
  check("unsupported source-policy routing stays Unknown", routeof("0", "4"), "Unknown")
  nr = 1; rf[1] = "4"; rv[1] = 123; rm[1] = 255; rc[1] = "VPN"
  check("source policy takes precedence over a matching VPN mark", routeof("123", "4"), "Unknown")
  policy_unknown["4"] = 0; rc[1] = "Unknown"
  check("matching non-tunnel policy route stays Unknown", routeof("123", "4"), "Unknown")

  check("stable VPN flow remains VPN", route_delta("VPN", "VPN"), "VPN")
  check("stable Direct flow remains Direct", route_delta("Direct", "Direct"), "Direct")
  check("VPN-to-Direct transition interval is Unknown", route_delta("VPN", "Direct"), "Unknown")
  check("Direct-to-VPN transition interval is Unknown", route_delta("Direct", "VPN"), "Unknown")
  check("legacy state without route is Unknown for transition interval", route_delta("Unknown", "Direct"), "Unknown")

  am["8.8.8.8"] = "Google"
  check("application identity remains Google", appof("8.8.8.8"), "Google")
  check("unmapped VPN endpoint is identified as lacking DNS", appof("195.19.105.24"), "Прочее · Нет DNS-имени")
  mapadd("203.0.113.1", "YouTube")
  mapadd("203.0.113.1", "Прочее · googlevideo.com")
  mapfinish()
  check("one known service wins over generic DNS alias", appof("203.0.113.1"), "YouTube")
  mapadd("203.0.113.2", "YouTube")
  mapadd("203.0.113.2", "Netflix")
  mapfinish()
  check("shared IP for two known services stays unclassified with reason", appof("203.0.113.2"), "Прочее · Общий IP (CDN)")
  mapadd("203.0.113.3", "Прочее · cdn.example")
  mapadd("203.0.113.3", "Прочее · media.example")
  mapfinish()
  check("ambiguous unknown domains do not pick the last DNS name", appof("203.0.113.3"), "Прочее · Несколько доменов")
  mapadd("203.0.113.4", "Прочее · unique.example")
  mapfinish()
  check("single unknown domain remains available for detail", appof("203.0.113.4"), "Прочее · unique.example")
  check("destination without DNS map gets explicit reason", appof("203.0.113.99"), "Прочее · Нет DNS-имени")
  if (failed) exit 1
}
AWK
awk -f "$TMP/classifier.awk"
sh -n "$COLLECTOR"
sh -n "$CONFIG"
echo "VPN route accounting tests: all passed."
