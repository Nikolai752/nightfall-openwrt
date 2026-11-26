#
# Copyright (C) 2008-2014 The LuCI Team <luci@lists.subsignal.org>
#
# This is free software, licensed under the Apache License, Version 2.0 .
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=Nightfall Theme
LUCI_DEPENDS:=+luci-base

# csstidy drops every CSS custom property (--nf-*, var() refs) and modern
# layout props (grid, gap) this theme relies on; jsmin corrupts JS that
# embeds CSS/data-URIs in template literals. Ship assets verbatim.
LUCI_MINIFY_CSS:=0
LUCI_MINIFY_JS:=0

PKG_LICENSE:=Apache-2.0

define Package/luci-theme-nightfall/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	uci -q delete luci.themes.Nightfall
	uci -q delete luci.themes.NightfallDark
	uci -q delete luci.themes.NightfallLight
	uci commit luci
}
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
