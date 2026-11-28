#!/bin/sh
# Isolated routing regression tests: Steer group output, plain WireGuard,
# and fail-closed behaviour. No real network rules or Telegram account used.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
H="$ROOT/luci-app-nightfall-monitor/root/usr/libexec/nightfall-telegram-route"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
export NF_TG_TEST_STATUS="$T/steer-status.json"
export NF_TG_TEST_NFT="$T/nft-state"
export NF_TG_TEST_IP_LOG="$T/ip-commands.log"
: > "$NF_TG_TEST_IP_LOG"
export NF_TG_TEST_UID=104

ok() { echo "ok: $1"; }
bad() { echo "ОШИБКА: $1" >&2; exit 1; }

# Minimal jshn-compatible shim backed by Node's JSON parser.
cat > "$T/jshn.sh" <<'SH'
json_load() { JSON_DATA=$1; JSON_PATH=; export JSON_DATA; }
json_select() {
	case "$1" in
		..) JSON_PATH=$(printf '%s' "$JSON_PATH" | sed 's/[^.]*$//;s/\.$//') ;;
		*) if [ -n "$JSON_PATH" ]; then JSON_PATH="$JSON_PATH.$1"; else JSON_PATH=$1; fi ;;
	esac
}
_json_value() {
	JSON_PATH="$JSON_PATH" JSON_KEY="$2" node -e '
		const root = JSON.parse(process.env.JSON_DATA);
		let value = root;
		for (const key of (process.env.JSON_PATH || "").split(".").filter(Boolean))
			value = value == null ? undefined : value[key];
		value = value == null ? undefined : value[process.env.JSON_KEY];
		// OpenWrt jshn writes JSON booleans to shell variables as 1/0.
		if (value === true) process.stdout.write("1");
		else if (value === false) process.stdout.write("0");
		else if (value != null) process.stdout.write(String(value));
	'
}
json_get_var() { value=$(_json_value ignored "$2"); eval "$1=\$value"; }
json_get_vars() { for key in "$@"; do json_get_var "$key" "$key"; done; }
json_get_keys() {
	value=$(JSON_PATH="$JSON_PATH" node -e '
		let value = JSON.parse(process.env.JSON_DATA);
		for (const key of (process.env.JSON_PATH || "").split(".").filter(Boolean))
			value = value == null ? undefined : value[key];
		if (value && typeof value === "object") process.stdout.write(Object.keys(value).join(" "));
	')
	eval "$1=\$value"
}
SH

cat > "$T/bin/ip" <<'SH'
#!/bin/sh
args="$*"
printf '%s\n' "$args" >> "$NF_TG_TEST_IP_LOG"
case "$args" in
	*"-o link show dev wg1"*)
		echo '9: wg1: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420'
		;;
	*"-o link show dev wg2"*)
		echo '10: wg2: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420'
		;;
	*"-o link show dev tun-vless"*) echo '12: tun-vless: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420' ;;
	*"-o link show dev xsteer0"*) echo '13: xsteer0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420' ;;
	*"-o link show dev awg0"*) echo '14: awg0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420' ;;
	*"-o link show dev wg3"*)
		echo '11: wg3: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420'
		;;
	*"-o link show dev eth0"*)
		echo '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500'
		;;
	*"-d link show dev wg1"*)
		echo '9: wg1: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 wireguard'
		;;
	*"-d link show dev wg2"*)
		echo '10: wg2: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 wireguard'
		;;
	*"-d link show dev wg3"*)
		echo '11: wg3: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 wireguard'
		;;
	*"-d link show dev eth0"*)
		echo '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 ether'
		;;
	"-o link show"*)
		echo '9: wg1: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 qdisc noqueue state UNKNOWN mode DEFAULT group default'
		echo '10: wg2: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 qdisc noqueue state UNKNOWN mode DEFAULT group default'
		echo '11: wg3: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 qdisc noqueue state UNKNOWN mode DEFAULT group default'
		echo '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP mode DEFAULT group default'
		;;
	*"-4 route show table 300 default"*)
		echo 'default dev wg1 scope link'
		;;
	*"-4 route show table 304 default"*)
		echo 'default dev wg2 scope link'
		;;
	*"-4 route show table 306 default"*)
		echo 'default dev wg3 scope link'
		;;
	*"-4 route show table 307 default"*) echo 'default dev tun-vless scope link' ;;
	*"-4 route show table 308 default"*) echo 'default dev xsteer0 scope link' ;;
	*"-4 route show table 309 default"*) echo 'default dev awg0 scope link' ;;
	*"-4 route show table 42000 default"*)
		echo 'default dev wg1 scope link'
		;;
	*"-4 route get 149.154.167.220"*)
		case "$args" in
			*0x40500000*) echo '149.154.167.220 dev wg2 table steer_zm_vpn2 src 10.10.0.2 mark 0x40500000' ;;
			*0x40700000*) echo '149.154.167.220 dev tun-vless table steer_vlessvpn src 10.7.0.2 mark 0x40700000' ;;
			*0x40800000*) echo '149.154.167.220 dev xsteer0 table steer_xsvpn src 10.8.0.2 mark 0x40800000' ;;
			*0x40900000*) echo '149.154.167.220 dev awg0 table steer_awgvpn src 10.9.0.3 mark 0x40900000' ;;
			*mark*) echo '149.154.167.220 dev wg1 table steer_groupvpn src 10.9.0.2 mark 0x40400000' ;;
			*) echo '149.154.167.220 dev wg1 table 42000 src 10.9.0.2' ;;
		esac
		;;
	*"-4 rule show"*|*"-6 rule show"*|*"route show table all"*) exit 0 ;;
	*) exit 0 ;;
esac
SH

cat > "$T/bin/steer" <<'SH'
#!/bin/sh
case "$1" in
	version|--version) echo 'Steer 2.1.4' ;;
	status) cat "$NF_TG_TEST_STATUS" ;;
	*) exit 1 ;;
esac
SH

cat > "$T/bin/nft" <<'SH'
#!/bin/sh
case "$1" in
	-f) cat > "$NF_TG_TEST_NFT"; exit 0 ;;
	list)
		case "$2" in
			table) [ -s "$NF_TG_TEST_NFT" ] ;;
			chain) [ -s "$NF_TG_TEST_NFT" ] && cat "$NF_TG_TEST_NFT" ;;
			*) exit 1 ;;
		esac ;;
	delete) rm -f "$NF_TG_TEST_NFT" ;;
	*) exit 0 ;;
esac
SH

cat > "$T/bin/id" <<'SH'
#!/bin/sh
case "$1" in
	-u) echo "$NF_TG_TEST_UID" ;;
	*) exit 0 ;;
esac
SH
chmod +x "$T/bin/ip" "$T/bin/steer" "$T/bin/nft" "$T/bin/id"

export PATH="$T/bin:$PATH"
export NF_IP="$T/bin/ip" NF_NFT="$T/bin/nft" NF_STEER="$T/bin/steer" NF_JSHN="$T/jshn.sh"
export NF_TG_STATE="$T/route.state" NF_TG_LOCK="$T/route.lock"

# Synthetic Steer status fixture: mark/table/device values below are test data.
# The production helper must derive the real values from the live `steer status`.
cat > "$NF_TG_TEST_STATUS" <<'JSON'
{"schema":1,"outputs":{
  "groupvpn":{"kind":"group","device":"","up":true,"mark":"0x00400000","table":300,"failed":false,"group":{"selected":"wg1"}},
  "zm_vpn2":{"kind":"group","device":"","up":true,"mark":"0x00500000","table":304,"failed":false,"group":{"selected":"wg2"}},
  "wrongroute":{"kind":"interface","device":"wg3","up":true,"mark":"0x00600000","table":306,"failed":false},
  "vlessvpn":{"kind":"tunnel","device":"tun-vless","up":true,"mark":"0x00700000","table":307,"failed":false},
  "xsvpn":{"kind":"xsteer","device":"xsteer0","up":true,"mark":"0x00800000","table":308,"failed":false},
  "awgvpn":{"kind":"awg","device":"awg0","up":true,"mark":"0x00900000","table":309,"failed":false},
  "wg1":{"kind":"interface","device":"wg1","up":true,"mark":"0x00400000","table":300,"failed":false},
  "wg2":{"kind":"interface","device":"wg2","up":true,"mark":"0x00500000","table":304,"failed":false}
}}
JSON
printf 'TG=1\nTG_TOKEN=x\nTG_CHAT=1\nTG_ROUTE_MODE=vpn\nTG_ROUTE_OUTPUT=steer:groupvpn\n' > "$T/conf"
export NF_CONF="$T/conf"

# Inspect must resolve a logical group to its selected device.
out=$("$H" inspect)
printf '%s' "$out" | node -e '
	const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
	const o = (d.outputs || []).find(x => x.id === "steer:groupvpn");
	if (!o || o.device !== "wg1" || o.table !== 300 || o.ready !== true) process.exit(1);
' || bad "Steer group output was not resolved to its selected device"
ok "Steer group output resolves selected member and table"

# Each Steer output gets its own marked route lookup. The successful result
# must report that output's own device/table, not whichever route is active now.
out=$("$H" probe steer:groupvpn) || bad "groupvpn preflight failed: $out"
printf '%s' "$out" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!d.verified || d.device!=="wg1" || d.table!==300 || d.output!=="steer:groupvpn") process.exit(1)' ||
	bad "groupvpn preflight did not verify its own device/table"
out=$("$H" probe steer:zm_vpn2) || bad "zm_vpn2 preflight failed: $out"
printf '%s' "$out" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!d.verified || d.device!=="wg2" || d.table!==304 || d.output!=="steer:zm_vpn2") process.exit(1)' ||
	bad "zm_vpn2 preflight did not resolve independently"
if "$H" probe steer:wrongroute > "$T/probe-wrong-result"; then bad "mismatched Steer mark/device passed preflight"; fi
grep -Fq 'не подтвердила выход' "$T/probe-wrong-result" ||
	bad "failed Steer preflight did not explain the device mismatch"
ok "Steer outputs are individually preflighted against their own marks and devices"

# Device-backed protocol outputs share the same live device/mark/table contract.
for spec in "vlessvpn|tun-vless|0x40700000|307" "xsvpn|xsteer0|0x40800000|308" "awgvpn|awg0|0x40900000|309"; do
	name=$(printf '%s' "$spec" | cut -d '|' -f 1)
	expected_dev=$(printf '%s' "$spec" | cut -d '|' -f 2)
	expected_mark=$(printf '%s' "$spec" | cut -d '|' -f 3)
	expected_table=$(printf '%s' "$spec" | cut -d '|' -f 4)
	out=$("$H" probe "steer:$name") || bad "Steer $name preflight failed: $out"
	printf '%s' "$out" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!d.verified) process.exit(1)' || bad "Steer $name did not pass its marked route check"
	printf 'TG=1\nTG_TOKEN=x\nTG_CHAT=1\nTG_ROUTE_MODE=vpn\nTG_ROUTE_OUTPUT=steer:%s\n' "$name" > "$T/conf"
	out=$("$H" apply) || bad "Steer $name apply failed: $out"
	grep -Fq "route_output meta skuid 104 meta mark set (meta mark & 0xb00fffff) | $expected_mark" "$NF_TG_TEST_NFT" || bad "Steer $name did not preserve unrelated fwmark bits"
	grep -Fq "egress_guard meta skuid 104 oifname != \"$expected_dev\" drop" "$NF_TG_TEST_NFT" || bad "Steer $name egress guard does not target $expected_dev"
	out=$("$H" status) || bad "Steer $name status failed: $out"
	printf '%s' "$out" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!d.active || d.device!==process.argv[1] || d.table!==Number(process.argv[2])) process.exit(1)' "$expected_dev" "$expected_table" || bad "Steer $name status is not bound to its live device/table"
done
printf 'TG=1\nTG_TOKEN=x\nTG_CHAT=1\nTG_ROUTE_MODE=vpn\nTG_ROUTE_OUTPUT=steer:zm_vpn2\n' > "$T/conf"
out=$("$H" apply) || bad "restoring known-good zm_vpn2 after protocol tests failed: $out"
case "$out" in *'"ok":true'*'"device":"wg2"'*) ;; *) bad "zm_vpn2 was not restored after protocol tests: $out" ;; esac
grep -Fq 'egress_guard meta skuid 104 oifname != "wg2" drop' "$NF_TG_TEST_NFT" || bad "zm_vpn2 guard was not restored after protocol tests"
ok "VLESS, xsteer and AWG use their own Steer device/mark/table; zm_vpn2 is restored afterwards"


# Applying the Steer route must mark Telegram sockets and add an egress guard.
out=$("$H" apply) || bad "Steer route apply failed: $out"
case "$out" in *'"ok":true'*'"source":"steer"'*) ;; *) bad "unexpected Steer apply result: $out" ;; esac
grep -Fq 'route_output meta skuid 104 meta mark set (meta mark & 0xb00fffff) | 0x40400000' "$NF_TG_TEST_NFT" ||
	bad "Steer socket mark was not installed"
grep -Fq 'output_guard meta skuid 104 ct status dnat meta mark & 0x0ff00000 == 0x00400000 ip daddr 127.0.0.1 meta l4proto tcp accept' "$NF_TG_TEST_NFT" ||
	bad "Steer local TCP redirect exception was not installed before the output guard"
grep -Fq 'egress_guard meta skuid 104 ct status dnat meta mark & 0x0ff00000 == 0x00400000 ip daddr 127.0.0.1 meta l4proto tcp accept' "$NF_TG_TEST_NFT" ||
	bad "Steer local TCP redirect exception was not installed before the egress guard"
grep -Fq 'egress_guard meta skuid 104 oifname != "wg1" drop' "$NF_TG_TEST_NFT" ||
	bad "Steer egress guard was not installed"
grep -Fq 'output_guard meta skuid 104 oifname != "wg1" drop' "$NF_TG_TEST_NFT" ||
	bad "Steer output guard was not installed"
if grep -Fq 'dport 9484' "$NF_TG_TEST_NFT"; then
	bad "Steer local redirect exception must not hardcode a dynamic listener port"
fi
ok "Steer route marks sockets, permits only marked local DNAT and keeps both fail-closed guards"

# Reapplying the same route must reuse the guard instead of duplicating rules.
out=$("$H" apply) || bad "idempotent Steer apply failed: $out"
case "$out" in *'"reused":true'*) ;; *) bad "same Steer route was not reused: $out" ;; esac
ok "Steer route apply is idempotent"
out=$("$H" status) || bad "Steer route status failed: $out"
printf '%s' "$out" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!d.active || d.source!=="steer" || d.device!=="wg1") process.exit(1)' ||
	bad "Steer route status did not confirm the active route"
ok "Steer route status confirms device with symbolic table alias"

# Switching between Steer outputs must replace only Nightfall's Telegram
# selector/guard while leaving both Steer-owned routing tables untouched.
printf 'TG=1\nTG_TOKEN=x\nTG_CHAT=1\nTG_ROUTE_MODE=vpn\nTG_ROUTE_OUTPUT=steer:zm_vpn2\n' > "$T/conf"
out=$("$H" apply) || bad "switch to proven zm_vpn2 failed: $out"
case "$out" in *'"ok":true'*'"source":"steer"'*'"device":"wg2"'*) ;; *) bad "zm_vpn2 switch resolved to an unexpected route: $out" ;; esac
grep -Fq 'route_output meta skuid 104 meta mark set (meta mark & 0xb00fffff) | 0x40500000' "$NF_TG_TEST_NFT" ||
	bad "switch to zm_vpn2 did not install its own Steer mark"
grep -Fq 'egress_guard meta skuid 104 oifname != "wg2" drop' "$NF_TG_TEST_NFT" ||
	bad "switch to zm_vpn2 did not replace the egress guard"
out=$("$H" status) || bad "zm_vpn2 status failed: $out"
printf '%s' "$out" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!d.active || d.source!=="steer" || d.output!=="steer:zm_vpn2" || d.device!=="wg2" || d.table!==304) process.exit(1)' ||
	bad "status did not confirm the selected zm_vpn2 route"
out=$( "$H" apply ) || bad "reapplying zm_vpn2 failed: $out"
case "$out" in *'"reused":true'*) ;; *) bad "zm_vpn2 route was not reused idempotently: $out" ;; esac
ok "zm_vpn2 remains active and is reused idempotently"

ok "switch to zm_vpn2 selects its Steer mark/table and confirms active status"

# A failed candidate must not tear down the known-good active zm_vpn2 route.
printf 'TG=1\nTG_TOKEN=x\nTG_CHAT=1\nTG_ROUTE_MODE=vpn\nTG_ROUTE_OUTPUT=steer:wrongroute\n' > "$T/conf"
if "$H" apply > "$T/wrong-apply-result"; then bad "invalid candidate output was applied"; fi
grep -Fq 'другой активный выход сохранён' "$T/wrong-apply-result" ||
	bad "invalid candidate failure did not explain that the old route is retained"
out=$("$H" status) || bad "active route status failed after invalid candidate"
printf '%s' "$out" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!d.active || d.output!=="steer:zm_vpn2" || d.device!=="wg2") process.exit(1)' ||
	bad "invalid candidate damaged the active zm_vpn2 route"
grep -Fq 'egress_guard meta skuid 104 oifname != "wg2" drop' "$NF_TG_TEST_NFT" ||
	bad "invalid candidate replaced the active zm_vpn2 egress guard"
ok "failed candidate preflight preserves the working zm_vpn2 route"

# Return to the original group output. This is the critical regression guard:
# the already-verified Steer route must still work after another output was used.
printf 'TG=1\nTG_TOKEN=x\nTG_CHAT=1\nTG_ROUTE_MODE=vpn\nTG_ROUTE_OUTPUT=steer:groupvpn\n' > "$T/conf"
out=$("$H" apply) || bad "return from zm_vpn2 to original Steer output failed: $out"
case "$out" in *'"ok":true'*'"source":"steer"'*'"device":"wg1"'*) ;; *) bad "return to original Steer output resolved incorrectly: $out" ;; esac
grep -Fq 'route_output meta skuid 104 meta mark set (meta mark & 0xb00fffff) | 0x40400000' "$NF_TG_TEST_NFT" ||
	bad "return to original output did not restore its original Steer mark"
grep -Fq 'egress_guard meta skuid 104 oifname != "wg1" drop' "$NF_TG_TEST_NFT" ||
	bad "return to original output did not restore its original egress guard"
out=$("$H" status) || bad "original output status failed after round trip: $out"
printf '%s' "$out" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!d.active || d.source!=="steer" || d.output!=="steer:groupvpn" || d.device!=="wg1" || d.table!==300) process.exit(1)' ||
	bad "original Steer route was not active after switching back"
ok "return to original Steer output works after zm_vpn2 round trip"
# The Steer-mode round trip must not add/delete/flush/replace any kernel
# route or policy rule. Only Nightfall's private nft table is managed here.
if grep -E '(^| )(-4|-6) (route (add|change|del|delete|flush|replace)|rule (add|del|delete))' "$NF_TG_TEST_IP_LOG" >/dev/null; then
	bad "Steer output switching modified kernel routes or policy rules"
fi
ok "Steer output switching leaves all kernel routing rules and tables untouched"

# A failed Steer output must replace the route with a hard block.
cat > "$NF_TG_TEST_STATUS" <<'JSON'
{"schema":1,"outputs":{
  "groupvpn":{"kind":"group","device":"","up":false,"mark":"0x00400000","table":300,"failed":true,"group":{"selected":"wg1"}},
  "wg1":{"kind":"interface","device":"wg1","up":false,"mark":"0x00400000","table":300,"failed":true}
}}
JSON
if "$H" apply > "$T/fail-result"; then bad "failed Steer output was accepted"; fi
grep -Fq 'fail_closed meta skuid 104 drop' "$NF_TG_TEST_NFT" ||
	bad "failed Steer output did not install a block rule"
ok "failed Steer output blocks Telegram instead of falling back"
out=$("$H" status) || bad "blocked route status failed: $out"
printf '%s' "$out" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(d.active || !d.blocked) process.exit(1)' ||
	bad "failed Steer status did not report fail-closed blocking"
ok "route status reports the fail-closed state"

# A plain WireGuard candidate is checked in a temporary UID policy table.
# The temporary table and rules must be removed after the check.
out=$("$H" probe iface:wg1) || bad "plain interface preflight failed: $out"
printf '%s' "$out" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!d.verified || d.source!=="interface" || d.device!=="wg1") process.exit(1)' ||
	bad "plain interface preflight did not confirm the candidate"
grep -Fq 'route flush table 42000' "$NF_TG_TEST_IP_LOG" ||
	bad "plain interface preflight did not clean up its temporary route table"
ok "plain interface preflight verifies and removes its temporary UID policy rules/table"

# A plain WireGuard interface uses its own UID table and an egress guard.
printf 'TG=1\nTG_TOKEN=x\nTG_CHAT=1\nTG_ROUTE_MODE=vpn\nTG_ROUTE_OUTPUT=iface:wg1\n' > "$T/conf"
out=$("$H" apply) || bad "plain interface apply failed: $out"
case "$out" in *'"ok":true'*'"source":"interface"'*) ;; *) bad "unexpected interface apply result: $out" ;; esac
grep -Fq 'egress_guard meta skuid 104 oifname != "wg1" drop' "$NF_TG_TEST_NFT" ||
	bad "plain VPN interface egress guard was not installed"
if grep -Fq 'nightfall-telegram-steer-local-' "$NF_TG_TEST_NFT"; then
	bad "plain VPN interface must not install Steer-specific local redirect exceptions"
fi
ok "plain WireGuard interface uses private policy table and egress guard without Steer exceptions"
out=$("$H" status) || bad "interface route status failed: $out"
printf '%s' "$out" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!d.active || d.source!=="iface" || d.device!=="wg1") process.exit(1)' ||
	bad "plain VPN interface status did not confirm the active route"
ok "plain VPN interface status confirms the route"

# A physical Ethernet interface is not accepted as a VPN tunnel target.
printf 'TG=1\nTG_TOKEN=x\nTG_CHAT=1\nTG_ROUTE_MODE=vpn\nTG_ROUTE_OUTPUT=iface:eth0\n' > "$T/conf"
if "$H" apply > "$T/eth-result"; then bad "physical Ethernet interface was accepted as VPN" ; fi
grep -Fq 'не распознан как VPN-туннель' "$T/eth-result" ||
	bad "physical Ethernet rejection did not explain the invalid interface"
ok "physical Ethernet interface is rejected"

echo "Telegram route regression tests passed"
