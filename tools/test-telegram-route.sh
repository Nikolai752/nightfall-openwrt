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
		if (value === true) process.stdout.write("true");
		else if (value === false) process.stdout.write("false");
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
case "$args" in
	*"-o link show dev wg1"*)
		echo '9: wg1: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420'
		;;
	*"-o link show dev eth0"*)
		echo '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500'
		;;
	*"-d link show dev wg1"*)
		echo '9: wg1: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 wireguard'
		;;
	*"-d link show dev eth0"*)
		echo '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 ether'
		;;
	"-o link show"*)
		echo '9: wg1: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 qdisc noqueue state UNKNOWN mode DEFAULT group default'
		echo '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP mode DEFAULT group default'
		;;
	*"-4 route show table 300 default"*|*"-4 route show table 42000 default"*)
		echo 'default dev wg1 scope link'
		;;
	*"-4 route get 149.154.167.220"*)
		case "$args" in
			*mark*) echo '149.154.167.220 dev wg1 table 300 src 10.9.0.2 mark 0x40400000' ;;
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

cat > "$NF_TG_TEST_STATUS" <<'JSON'
{"schema":1,"outputs":{
  "groupvpn":{"kind":"group","device":"","up":true,"mark":"0x00400000","table":300,"failed":false,"group":{"selected":"wg1"}},
  "wg1":{"kind":"interface","device":"wg1","up":true,"mark":"0x00400000","table":300,"failed":false}
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

# Applying the Steer route must mark Telegram sockets and add an egress guard.
out=$("$H" apply) || bad "Steer route apply failed: $out"
case "$out" in *'"ok":true'*'"source":"steer"'*) ;; *) bad "unexpected Steer apply result: $out" ;; esac
grep -Fq 'route_output meta skuid 104 meta mark set 0x40400000' "$NF_TG_TEST_NFT" ||
	bad "Steer socket mark was not installed"
grep -Fq 'egress_guard meta skuid 104 oifname != "wg1" drop' "$NF_TG_TEST_NFT" ||
	bad "Steer egress guard was not installed"
ok "Steer route applies mark and fail-closed egress guard"

# Reapplying the same route must reuse the guard instead of duplicating rules.
out=$("$H" apply) || bad "idempotent Steer apply failed: $out"
case "$out" in *'"reused":true'*) ;; *) bad "same Steer route was not reused: $out" ;; esac
ok "Steer route apply is idempotent"
out=$("$H" status) || bad "Steer route status failed: $out"
printf '%s' "$out" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!d.active || d.source!=="steer" || d.device!=="wg1") process.exit(1)' ||
	bad "Steer route status did not confirm the active route"
ok "Steer route status confirms current device and table"

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

# A plain WireGuard interface uses its own UID table and an egress guard.
printf 'TG=1\nTG_TOKEN=x\nTG_CHAT=1\nTG_ROUTE_MODE=vpn\nTG_ROUTE_OUTPUT=iface:wg1\n' > "$T/conf"
out=$("$H" apply) || bad "plain interface apply failed: $out"
case "$out" in *'"ok":true'*'"source":"interface"'*) ;; *) bad "unexpected interface apply result: $out" ;; esac
grep -Fq 'egress_guard meta skuid 104 oifname != "wg1" drop' "$NF_TG_TEST_NFT" ||
	bad "plain VPN interface egress guard was not installed"
ok "plain WireGuard interface uses private policy table and egress guard"
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
