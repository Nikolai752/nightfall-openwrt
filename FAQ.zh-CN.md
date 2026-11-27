# 常见问题：问题与解决方法

[Русский](FAQ.md) | [English](FAQ.en.md) | **简体中文** | [返回 README](README.zh-CN.md)

本页面汇总了用户在 [Issues](https://github.com/Nikolai752/nightfall-openwrt/issues) 中反馈的问题及其解决方法。如果列表中没有你的问题，请参阅[如何报告问题](#如何报告问题)。

> 项目的主要硬件测试配置为 **Cudy WR3000U-256MB 1.0（WR3000U v1），运行 OpenWrt 25.12.6**。此前的测试版本曾在该设备上检查数据采集器、Telegram 机器人和通知、设备及应用流量统计、USB 历史记录持久化，以及备份创建和恢复。这并不代表 v1.30.0 的所有组件都已通过完整的硬件认证。Nightfall 并不局限于 Cudy 设备，但目前尚未确认其他型号的硬件兼容性。

## 目录

- [安装与更新](#安装与更新)
- [Telegram](#telegram)
- [主题外观与设置](#主题外观与设置)
- [设备与互联网访问](#设备与互联网访问)
- [流量与图表](#流量与图表)
- [性能](#性能)
- [如何报告问题](#如何报告问题)

---

## 安装与更新

### 当前 Nightfall 版本是什么？哪些内容经过了测试？
当前稳定版本为 **Nightfall v1.30.0**。该版本的 CI 已通过静态检查和回归测试、服务与存储功能测试、备份测试、流量统计测试、安装/更新/卸载测试，以及 LuCI 浏览器 smoke 测试。CI 不能替代在实体路由器上的测试。项目主要硬件测试配置为 **Cudy WR3000U-256MB 1.0（WR3000U v1），运行 OpenWrt 25.12.6**；此前的测试版本曾在该设备上检查数据采集器、Telegram 机器人、通知、设备和应用统计、USB 历史记录持久化以及备份功能。这并不保证 v1.30.0 的每项功能都已在该设备上测试，也不代表所有 OpenWrt 路由器都兼容。Nightfall 并不局限于 Cudy 设备，但其他型号的硬件测试结果尚未确认。

### 如何安装或更新主题？
最简单的方法是在主题中点击**“有新版本可用”**按钮（安装前会检查归档文件的 SHA-256 校验和及签名；发生错误时会恢复之前的文件）。也可以通过 SSH 在路由器命令行中执行：

~~~sh
wget -qO- https://raw.githubusercontent.com/Nikolai752/nightfall-openwrt/main/install-update.sh | sh
~~~

脚本会自动检测最新版本，结束时显示类似**“已安装版本 X（原版本 Y）”**的信息。只检查版本、不安装：**... | sh -s -- --check**。安装指定的已发布版本：**... | sh -s -- --version vX.Y.Z**（请替换为实际存在的发布标签）。安装后，在**系统 → 系统 → 语言和样式**中选择 Nightfall（也可以在命令后添加 **--activate**，让安装程序自动启用主题）。

### 如何启用简体中文界面？
Nightfall v1.30.0 为主题和资源监视器提供了 **zh_Hans** 简体中文翻译。安装或更新后，打开**系统 → 系统 → 语言和样式**，选择**简体中文（Simplified Chinese）**。安装程序会将 **zh_cn** 注册为可用语言，但不会自动切换界面语言。LuCI 标准页面的翻译取决于路由器上安装的 LuCI 语言包。

### 安装程序安装了旧版本（例如 1.0.9）
在 v1.16.3 之前，**install-update.sh** 有一个问题：如果 **/tmp** 中留有上次手动安装时的旧 **nightfall-root.tar.gz**，脚本可能会使用旧文件，而不是重新下载归档。当前版本通过 **... | sh** 运行时会忽略 **/tmp** 中的旧文件，并在安装前后检查版本。如果你使用的是旧版安装程序，请先删除旧归档，然后重新执行安装命令：

~~~sh
rm -f /tmp/nightfall-root.tar.gz /tmp/nightfall-root_tar.gz
wget -qO- https://raw.githubusercontent.com/Nikolai752/nightfall-openwrt/main/install-update.sh | sh
~~~

如果安装后的版本仍然不正确，请在 Issue 中附上安装程序的完整输出。

### 安装时提示“无法下载归档文件”
检查路由器是否能访问互联网（**ping -c1 github.com**）以及是否支持 HTTPS：执行 **apk add curl ca-bundle**，然后重试。如果路由器无法联网，请在电脑上下载 **nightfall-root.tar.gz**，再手动安装（参见 [README 中的安装说明](README.zh-CN.md#安装)）。

### 安装后没有“资源监视器”菜单项
退出 LuCI 并重新登录：权限和菜单项只会在登录时读取。如果仍然没有该菜单项，请在路由器上执行：

~~~sh
rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache
/etc/init.d/rpcd reload
~~~

然后重新登录 LuCI。

### 如何恢复默认主题或卸载 Nightfall？
通过 SSH 在路由器上执行：

~~~sh
wget -qO- https://raw.githubusercontent.com/Nikolai752/nightfall-openwrt/main/uninstall.sh | sh
~~~

脚本会恢复默认主题，并删除 Nightfall 的所有组件：主题、监视器、机器人、菜单项（包括**Nightfall：所有元素**）、权限和缓存。**/etc/nightfall-*** 中的设置会保留。只恢复默认主题、不删除文件：**... | sh -s -- --theme-only**。同时删除设置：**... | sh -s -- --wipe**。卸载后请在浏览器中强制刷新页面（**Ctrl+F5**），然后重新登录 LuCI。

### 更新后没有显示“更新内容”窗口
如果此前已安装并确认过另一个版本，“更新内容”窗口会在同一个浏览器配置文件中重新登录 LuCI 后显示。全新安装时不会显示该窗口。确认状态分别保存在每个浏览器和每台设备中。如果从 **1.27.7-alpha…** 之类的测试版本升级到稳定版 **1.27.7**，旧版主题可能会把它们视为相同版本，从而跳过窗口；此问题已在 **v1.27.8** 中通过正确比较预发布版和稳定版得到修复。请更新到该版本或更高版本，退出 LuCI 后重新登录。如果仍未显示，请检查浏览器能否访问 **/www/luci-static/nightfall/CHANGELOG.md**，然后再次登录。

### 更新后页面显示异常或样式错乱
浏览器可能仍在使用旧版 CSS。请强制刷新页面（**Ctrl+F5**；手机上请关闭并重新打开浏览器标签页或应用）。

---

## Telegram

### 提示“未发送：没有权限运行……或找不到 /usr/libexec/nightfall-notify” ([#17](https://github.com/Nikolai752/nightfall-openwrt/issues/17), [#85](https://github.com/Nikolai752/nightfall-openwrt/issues/85))
这是权限错误。请按以下步骤操作：

1. 将主题更新到最新版本（参见上文）。
2. **务必退出 LuCI 并重新登录。** 权限只在登录时读取；不重新登录，修改不会生效。
3. 确认已安装 **curl**：执行 **apk add curl**。
4. 如果当前网络无法访问 Telegram，请在设置中指定**Telegram 代理**（例如 **socks5h://127.0.0.1:1080**）或 **VPN 接口**（例如 **wg0**）。

如果问题仍然存在，请在 Issue 中附上以下命令的输出：

~~~sh
ls -l /usr/libexec/nightfall-notify
grep -c nightfall-notify /usr/share/rpcd/acl.d/luci-app-nightfall-monitor.json
cat /etc/openwrt_release | head -3
~~~

相关文件必须存在并具有可执行权限（权限字符串应为 **-rwxr-xr-x**），第二条命令的结果必须是大于零的数字。

### 如何配置机器人？
打开**资源监视器 → 历史记录 → 设置 → Telegram 通知**：

1. 在 Telegram 中通过 @BotFather 创建机器人（发送 **/newbot**），然后将机器人 Token 粘贴到设置中。
2. 在 Telegram 中打开自己的机器人并点击 **Start**。
3. 点击**检测 chat id**，然后点击**发送测试**。
4. 开启**发送通知**并保存设置。

要显示机器人按钮，请向机器人发送 **/menu**。机器人只响应所有者，即配置的 chat id。

### 点击“检测 chat id”后没有找到任何内容
先在 Telegram 中打开自己的机器人并点击 **Start**（或向它发送任意消息），然后再次点击**检测 chat id**。如果无法访问 **api.telegram.org**，请按上文说明配置代理或 VPN 接口。

### 机器人不再发送动态“状态”，而是发送普通文本
向机器人发送 **/widget**。它会显示**机器人动态小组件**是否启用、当前是否为私人聊天（群组聊天不支持小组件）、模板文件是否存在，以及 Telegram 在上一次请求失败时返回的内容。常见原因包括：Telegram 客户端更新或 API 临时故障（小组件通常会自动恢复）；设置被重置（请在**监视器 → 历史记录 → 设置**中重新启用）；无法访问 **api.telegram.org**（请配置代理或 VPN 接口）。如果 **/widget** 返回 **INPUT_MEDIA_WIDGET_NOT_ALLOWED**，表示 Telegram 自身拒绝了请求：动态小组件正在逐步开放，目前并非所有账号都能使用。机器人本身没有故障，状态信息会以文本形式发送；等 Telegram 允许后，小组件会恢复。其他情况下，请将 **/widget** 的回复附在 Issue 中。

### 备份文件中没有 Telegram Token 或代理设置
这是有意设计的：**TG_TOKEN** 和 **TG_PROXY** 不会写入备份归档。恢复时，如果路由器当前配置中已设置这两个值，就会保留当前值。将备份迁移到新路由器时，需要手动填写 Token 和代理。不要将归档直接解压覆盖到 **/etc** 或根目录 **/**。请通过 Telegram 中的检查与安全恢复流程，或使用 **/usr/libexec/nightfall-backup list** 和 **/usr/libexec/nightfall-backup restore** 命令。详细信息请参阅[备份与恢复指南](docs/backup-restore.md)。

### 如何通过 Telegram 恢复备份？
1. 在机器人菜单中点击**备份**。归档会作为单独文件消息发送，同时保留在路由器本地存储中。
2. 在文件下方点击**检查并恢复**。机器人会检查归档并显示其中的内容；如果检查失败，则不会提供恢复操作。
3. 确认归档内容后，点击**恢复设置**。确认操作有效期为 5 分钟。点击**取消**不会更改当前设置。
4. 恢复成功后，机器人会报告结果，并自动重启数据采集器和 Telegram 机器人。

归档不包含 OpenWrt 网络设置。只会恢复 Nightfall 设置；当前的 **TG_TOKEN** 和 **TG_PROXY** 会保留。如果归档过旧，或者本地文件已被删除，请重新创建备份。

---

## 主题外观与设置

### 主题设置无法同步到另一个浏览器 ([#34](https://github.com/Nikolai752/nightfall-openwrt/issues/34))
设置保存在路由器上，其他浏览器登录后会从路由器读取设置。此前，设置文件权限错误可能导致同步失败（Web 服务器返回 **Forbidden**）。该问题已在 v1.2.12 修复。请按以下步骤操作：

1. 更新到最新版本，然后重新登录 LuCI。
2. 在**个性化 → 更多**中检查设置是否已写入路由器。
3. 如果仍未解决，请打开 **http://路由器IP/luci-static/nightfall/prefs.json**，并将页面显示的内容附在 Issue 中。

### 电脑上的“搜索”和“编辑”窗口太窄，需要移动页面 ([#83](https://github.com/Nikolai752/nightfall-openwrt/issues/83))
LuCI 对话框会根据内容调整尺寸。v1.15.2 扩大了设置表单的宽度；v1.15.3 将**找到的 Wi-Fi 接入点**窗口调整为全宽。请更新 Nightfall，并强制刷新页面。

### “这里暂时为空”没有显示在表格中央
该问题已在 v1.16.3 中彻底修复（v1.15.3 中部分用户仍会看到提示出现在第一列）。请更新并强制刷新页面。

### 登录窗口变宽，输入框靠左对齐
该问题已在 v1.16.3 中修复：登录卡片宽度恢复为 **380 px**。请更新并强制刷新页面。

### 登录页面没有显示路由器摘要卡片 ([#27](https://github.com/Nikolai752/nightfall-openwrt/issues/27))
路由器摘要**只会显示给局域网中的客户端**。如果通过外部地址或 Tailscale 访问路由器，摘要卡片不会显示。这是为了防止外部人员查看路由器信息。请使用路由器的局域网地址打开管理页面。

### iPhone 主屏幕上的图标消失
如果通过自签名 HTTPS 打开管理页面，iOS 可能会丢失图标。图标直接嵌入页面中，因此请更新到最新版本。如果仍显示旧图标，请从主屏幕删除它，然后重新添加。

---

## 设备与互联网访问

### 已连接的设备显示为“离线” ([#73](https://github.com/Nikolai752/nightfall-openwrt/issues/73))
- 更新到最新版本（v1.14.1 和 v1.15.1 中加入了相关修复），然后点击**立即检查**。
- Wi-Fi 客户端根据其与无线接入点的关联状态识别；其他客户端通过 ARP 请求检查。同时也会读取 DHCP 租约。
- 非标准网络结构（WAN 和 LAN 共用一个接口、独立网段，或当前路由器位于另一台路由器之后）并未在所有组合下验证。如果你使用此类结构并且状态显示错误，请在 Issue 中描述网络连接方式，并附上 **ip neigh** 命令输出。

### 手机显示为“Private MAC”，无法识别厂商
启用了**私有 Wi-Fi 地址**的手机会使用随机 MAC 地址，因此无法通过该地址识别设备厂商。若要让设备更容易识别，请在手机的 Wi-Fi 设置中关闭当前网络的私有地址，或者在设备详情卡片中为其设置名称。

---

## 流量与图表

### 月度流量和“每日摘要”显示的数值不同
该问题已在 v1.15.1 修复。启用数据包硬件加速（Flow Offloading）后，WAN 接口只能看到少量流量。因此，如果 WAN 统计明显偏低，每日总流量会改用设备统计数据计算。日历会标记这些日期。

### 应用流量统计偏低，或者无法识别某项服务
该功能存在限制：无法可靠识别通过 VPN 或加密 DNS（DoH/DoT）传输的流量；启用 Flow Offloading 时计数器可能偏低；域名匹配结果属于近似值。详细信息请参阅 [README](README.zh-CN.md)。

### 没有设备流量统计
检查 conntrack 流量统计是否已启用：

~~~sh
sysctl net.netfilter.nf_conntrack_acct
~~~

返回值必须为 **1**。

### 图表出现“环形”线条和节点 ([#78](https://github.com/Nikolai752/nightfall-openwrt/issues/78))
该问题已在 v1.15.0 修复。请更新 Nightfall。

### 路由器重启后历史记录消失
默认情况下，当前历史数据保存在 RAM（**/tmp**）中，路由器重启后会清空。要保留历史记录，请在监视器设置中将 **PERSIST_DIR** 指向已挂载的 USB/SD 存储路径。如果存储设备断开，采集器会继续在 RAM 中运行，并在设备重新挂载后恢复保存；它不应将数据写入底层 **/overlay**。详细信息请参阅 [README](README.zh-CN.md) 和[备份与恢复指南](docs/backup-restore.md)。

---

## 性能

### 路由器性能较弱，可以关闭一些功能吗？ ([#72](https://github.com/Nikolai752/nightfall-openwrt/issues/72))
在监视器设置中启用 **LITE=1**。采集器将改为每 60 秒轮询一次路由器，并关闭应用流量统计和 Wi-Fi 历史记录，从而降低 CPU 和 RAM 占用。设置 **LITE=0** 可恢复完整模式。此外还可以：

- 在**个性化**中关闭动画和动态背景。
- 在**概览**页面隐藏不需要的磁贴和卡片（在**个性化**的**概览**选项卡中设置）。
- 如果不需要监视器，可以停止历史记录采集器：

~~~sh
/etc/init.d/nightfall-collector stop
/etc/init.d/nightfall-collector disable
~~~

重新启用：**/etc/init.d/nightfall-collector enable && /etc/init.d/nightfall-collector start**。

---

## 如何报告问题

创建一个 [Issue](https://github.com/Nikolai752/nightfall-openwrt/issues/new)，并提供以下信息：

1. **主题版本：** 在**个性化**菜单的**关于主题**区域查看，或提供路由器上的 **/www/luci-static/nightfall/version.json** 文件内容。
2. **路由器型号和 OpenWrt 版本：** 提供 **cat /etc/openwrt_release | head -3** 命令输出。
3. **问题截图：** 最好能同时看到浏览器地址栏和窗口尺寸。
4. **浏览器**及设备类型（电脑、iPhone、Android）。
5. **已经尝试过的操作：** 更新、重新登录 LuCI、清理浏览器缓存等。

如果是机器人问题，请附上 [Telegram](#telegram) 部分要求的命令输出。如果是网络或设备问题，请描述你的网络连接结构。**请勿在 Issue 中公开机器人 Token 或密码。**
