#
# Nightfall resource monitor for LuCI (OpenWrt 25.12+)
# Licensed under the Apache License, Version 2.0
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=Nightfall resource monitor (CPU, memory, temperature, network, history)
LUCI_DEPENDS:=+luci-base +coreutils-base64 +ip-full
LUCI_PKGARCH:=all

# monitor.js embeds ~480 lines of CSS in template literals; jsmin does not
# understand backtick strings and mangles them. Ship assets verbatim.
LUCI_MINIFY_JS:=0
LUCI_MINIFY_CSS:=0

PKG_LICENSE:=Apache-2.0

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
