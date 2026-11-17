#
# Nightfall resource monitor for LuCI (OpenWrt 25.12+)
# Licensed under the Apache License, Version 2.0
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=Nightfall resource monitor (CPU, memory, temperature, network, history)
LUCI_DEPENDS:=+luci-base +coreutils-base64
LUCI_PKGARCH:=all

PKG_LICENSE:=Apache-2.0

include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature
