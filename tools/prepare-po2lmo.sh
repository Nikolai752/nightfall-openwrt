#!/bin/sh
# Prepare the official LuCI po2lmo host utility for the TAR.GZ release builder.
# The exact OpenWrt 25.12 LuCI commit is pinned to keep the LMO format reproducible.
set -eu

LUCI_COMMIT=0ffd555907816f80174842f2387e42ccb81d7167
WORK=${PO2LMO_BUILD_DIR:-${TMPDIR:-/tmp}/nightfall-po2lmo}
TOOL="$WORK/modules/luci-base/src/po2lmo"

if [ -x "$TOOL" ]; then
  printf '%s\n' "$TOOL"
  exit 0
fi

rm -rf "$WORK"
mkdir -p "$WORK"
git init "$WORK" >&2
git -C "$WORK" remote add origin https://github.com/openwrt/luci.git
git -C "$WORK" fetch --depth 1 origin "$LUCI_COMMIT" >&2
git -C "$WORK" checkout --detach FETCH_HEAD >&2

make -C "$WORK/modules/luci-base/src" clean po2lmo >&2
[ -x "$TOOL" ] || {
  echo "ОШИБКА: po2lmo не был собран из OpenWrt LuCI." >&2
  exit 1
}
printf '%s\n' "$TOOL"
