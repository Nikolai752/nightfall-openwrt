#!/bin/sh
# Regression tests: Nightfall Telegram requests use SO_MARK for Steer, not device binding.
set -eu
cd "$(dirname "$0")/.."
L="$(pwd)/luci-app-nightfall-monitor/root/usr/libexec/nightfall-notify"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
cat > "$T/curl" <<'SH'
#!/bin/sh
if [ "${1:-}" = "--help" ]; then
  [ "${2:-}" = "all" ] || exit 0
  [ ! -e "$T/no-mark" ] && echo " --mark < mark >"
  exit 0
fi
printf '%s\n' "$*" >> "$T/args"
cat > "$T/stdin"
echo '{"ok":true,"result":{"message_id":1}}'
SH
chmod +x "$T/curl"
export T
cat > "$T/conf" <<'CONF'
TG=1
TG_TOKEN=123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
TG_CHAT=123456789
TG_PROXY=
TG_IFACE=
TG_MARK=0x00500000
CONF
NF_CONF="$T/conf" NF_DIR="$T" NF_CURL="$T/curl" sh "$L" test > "$T/result"
grep -q -- '--mark 0x00500000' "$T/args"
! grep -q 'interface' "$T/stdin"
grep -q '"ok":true' "$T/result"
echo "ok: SO_MARK is passed to curl; no TUN device binding"

# Fail closed if this curl build lacks --mark: no Telegram API request may be attempted.
: > "$T/args"
: > "$T/stdin"
touch "$T/no-mark"
if NF_CONF="$T/conf" NF_DIR="$T" NF_CURL="$T/curl" sh "$L" test > "$T/result" 2>&1; then
  echo "FAIL: request unexpectedly succeeded without --mark support" >&2
  exit 1
fi
[ ! -s "$T/args" ]
grep -q 'не поддерживает --mark' "$T/result"
echo "ok: unsupported curl fails closed without an unmarked request"

# Legacy interface mode remains supported.
sed 's/^TG_MARK=.*/TG_MARK=/; s/^TG_IFACE=.*/TG_IFACE=wg0/' "$T/conf" > "$T/legacy"
rm -f "$T/no-mark"
NF_CONF="$T/legacy" NF_DIR="$T" NF_CURL="$T/curl" sh "$L" test > "$T/result"
grep -q 'interface = "wg0"' "$T/stdin"
! grep -q -- '--mark' "$T/args"
echo "ok: legacy TG_IFACE mode is preserved"
