# FAQ: common issues and solutions

[Русский](FAQ.md) | **English** | [简体中文](FAQ.zh-CN.md) | [Back to README](README.en.md)

This page collects questions reported in [Issues](https://github.com/Nikolai752/nightfall-openwrt/issues) and their solutions. If your problem is not listed, see [How to report an issue](#how-to-report-an-issue).

> The project's main hardware test configuration is **Cudy WR3000U-256MB 1.0 (WR3000U v1) running OpenWrt 25.12.6**. Previous test builds were used on this device to check the collector, Telegram bot and notifications, device and application statistics, USB history persistence, and backup creation and restoration. This does not constitute full hardware certification of every v1.30.0 component. Nightfall is not limited to Cudy devices, but hardware compatibility with other models has not yet been confirmed.

## Contents

- [Installation and updates](#installation-and-updates)
- [Telegram](#telegram)
- [Theme appearance and settings](#theme-appearance-and-settings)
- [Devices and Internet access](#devices-and-internet-access)
- [Traffic and charts](#traffic-and-charts)
- [Performance](#performance)
- [How to report an issue](#how-to-report-an-issue)

---

## Installation and updates

### What is the current Nightfall version, and what has been tested?
The current stable release is **Nightfall v1.30.0**. Its CI passed static and regression checks, functional tests for services, storage, backups, traffic accounting, installation/update/removal, and LuCI browser smoke tests. CI does not replace testing on a physical router. The project's main hardware test configuration is **Cudy WR3000U-256MB 1.0 (WR3000U v1) running OpenWrt 25.12.6**; the collector, Telegram bot, notifications, device and application statistics, USB history persistence, and backups were tested on it in previous test builds. This is not a guarantee that every v1.30.0 feature works on this device or on every OpenWrt router. Nightfall is not limited to Cudy devices, but hardware test results for other models have not yet been confirmed.

### How do I install or update the theme?
The easiest way is to use the **Update available** button in the theme (the archive's SHA-256 checksum and signature are verified; the previous files are restored if an error occurs). From the router's command line:

~~~sh
wget -qO- https://raw.githubusercontent.com/Nikolai752/nightfall-openwrt/main/install-update.sh | sh
~~~

The script detects the latest version and finishes with a message such as **Installed version X (was Y)**. To check versions without installing: **... | sh -s -- --check**. To install a specific published version: **... | sh -s -- --version vX.Y.Z** (replace this with an existing release tag). After installation, select the theme under **System → System → Language and Style** (or add **--activate** to the command).

### How do I enable the Simplified Chinese interface?
Nightfall v1.30.0 includes **zh_Hans** translations for the theme and Resource Monitor. After installing or updating, open **System → System → Language and Style** and select **简体中文 (Simplified Chinese)**. The installer registers **zh_cn** as an available language, but does not switch the interface automatically. Translations for standard LuCI pages depend on the LuCI language packages installed on the router.

### The installer installed an old version (for example, 1.0.9)
This was the behavior of **install-update.sh** before v1.16.3: if an old **nightfall-root.tar.gz** from a previous manual installation was left in **/tmp**, the script could use it instead of downloading a fresh archive. The current script ignores old files in **/tmp** when run through **... | sh** and checks the version before and after installation. If you are using an old installer, remove the old archive first and run the command again:

~~~sh
rm -f /tmp/nightfall-root.tar.gz /tmp/nightfall-root_tar.gz
wget -qO- https://raw.githubusercontent.com/Nikolai752/nightfall-openwrt/main/install-update.sh | sh
~~~

If the installed version is still incorrect, attach the installer's output to an Issue.

### "Failed to download the archive" during installation
Check the router's Internet connection (**ping -c1 github.com**) and HTTPS support: run **apk add curl ca-bundle**, then try again. If the router has no Internet access, download **nightfall-root.tar.gz** to your computer and install it manually (see [Installation in the README](README.en.md#installation)).

### The "Resource Monitor" menu item is missing after installation
Log out of LuCI and log back in: permissions and menu entries are read when you sign in. If the item is still missing, run these commands on the router:

~~~sh
rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache
/etc/init.d/rpcd reload
~~~

Then sign in to LuCI again.

### How do I restore the default theme or uninstall Nightfall?
Run this over SSH on the router:

~~~sh
wget -qO- https://raw.githubusercontent.com/Nikolai752/nightfall-openwrt/main/uninstall.sh | sh
~~~

The script restores the default theme and removes everything belonging to Nightfall: the theme, monitor, bot, menu entries (including **Nightfall: all elements**), permissions, and cache. Your settings in **/etc/nightfall-*** are preserved. To restore only the default theme without deleting files: **... | sh -s -- --theme-only**. To remove the settings as well: **... | sh -s -- --wipe**. After uninstalling, refresh the browser (**Ctrl+F5**) and sign in to LuCI again.

### The "What's New" window did not appear after an update
The window appears after you sign in to LuCI again in the same browser profile, provided a different version had previously been installed and acknowledged. It does not appear after a clean installation. Acknowledgement is stored separately in each browser and on each device. When upgrading from a test build such as **1.27.7-alpha…** to the stable **1.27.7**, older theme versions could treat them as the same version and skip the window; correct prerelease/stable comparison was fixed in **v1.27.8**. Update to that version or newer, sign out of LuCI, and sign in again. If the window still does not appear, check that **/www/luci-static/nightfall/CHANGELOG.md** is accessible in the browser and sign in again.

### The page looks broken after an update
The browser may still be using an old CSS file. Hard-refresh the page (**Ctrl+F5**; on a phone, close and reopen the tab or app).

---

## Telegram

### "Not sent: no permission to run … or /usr/libexec/nightfall-notify was not found" ([#17](https://github.com/Nikolai752/nightfall-openwrt/issues/17), [#85](https://github.com/Nikolai752/nightfall-openwrt/issues/85))
This is a permissions error. Try the following:

1. Update the theme to the latest version (see above).
2. **Log out of LuCI and sign in again.** Permissions are read only at login; without signing in again, the change will not take effect.
3. Make sure **curl** is installed: **apk add curl**.
4. If Telegram is blocked or unreachable on your network, set **Telegram proxy** (for example, **socks5h://127.0.0.1:1080**) or **VPN interface** (for example, **wg0**) in the settings.

If the error persists, attach the output of these commands to the Issue:

~~~sh
ls -l /usr/libexec/nightfall-notify
grep -c nightfall-notify /usr/share/rpcd/acl.d/luci-app-nightfall-monitor.json
cat /etc/openwrt_release | head -3
~~~

The file must exist and be executable (**-rwxr-xr-x**), and the second command must return a number greater than zero.

### How do I configure the bot?
Open **Resource Monitor → History → Settings → Telegram notifications**:

1. In Telegram, create a bot with @BotFather (**/newbot**) and paste its token into the settings.
2. Open your bot in Telegram and press **Start**.
3. Click **Detect chat ID**, then **Send test**.
4. Enable **Send notifications** and save the settings.

To display the bot's buttons, send **/menu** to it. The bot responds only to its owner, identified by your chat ID.

### The "Detect chat ID" button does not find anything
First open your bot in Telegram and press **Start** (or send it any message), then click **Detect chat ID** again. If requests to **api.telegram.org** cannot get through, configure a proxy or VPN interface as described above.

### The live "Status" message is replaced with plain text
Send **/widget** to the bot. It reports whether **Live widgets in bot** is enabled, whether the chat is private (widgets are not available in group chats), whether the template is present, and what Telegram returned after the last failed request. Common causes include a Telegram client update or temporary API failure (the widget should return automatically), a reset setting (enable it again under **Monitor → History → Settings**), or an unreachable **api.telegram.org** (configure a proxy or VPN interface). If **/widget** returns **INPUT_MEDIA_WIDGET_NOT_ALLOWED**, Telegram itself rejected the request: widgets are being rolled out gradually and are not available to every account yet. The bot is not broken; the status is sent as text, and the widget will return when Telegram allows it. For any other result, attach the **/widget** response to an Issue.

### The backup does not contain the Telegram token or proxy
This is intentional: **TG_TOKEN** and **TG_PROXY** are not written to the archive. During restoration, the current values are preserved from the router configuration if they are set. When moving a backup to a new router, enter the token and proxy manually. Do not extract the archive manually over **/etc** or **/**: use the validation and safe restoration procedure in Telegram, or run **/usr/libexec/nightfall-backup list** and **/usr/libexec/nightfall-backup restore**. See the [backup and restore guide](docs/backup-restore.md) for details.

### How do I restore a backup from Telegram?
1. Press **Backup** in the bot menu. The archive is sent as a separate message and is also kept in the router's local storage.
2. Under the file, press **Verify and restore**. The bot checks the archive and displays its contents. If validation fails, restoration is not offered.
3. Review the contents and press **Restore settings**. Confirmation is valid for 5 minutes. **Cancel** leaves the current settings unchanged.
4. After a successful restore, the bot reports the result and automatically restarts the collector and Telegram bot.

The archive does not contain OpenWrt network settings. Only Nightfall settings are restored; the current **TG_TOKEN** and **TG_PROXY** values are preserved. If the archive is old or its local file has already been deleted, create a new backup.

---

## Theme appearance and settings

### Theme settings are not synchronized to another browser ([#34](https://github.com/Nikolai752/nightfall-openwrt/issues/34))
Settings are stored on the router and loaded in other browsers after sign-in. Previously, incorrect permissions on the settings file could prevent this (the web server returned **Forbidden**). Fixed in v1.2.12. What to do:

1. Update to the latest version and sign in to LuCI again.
2. Under **Personalization → More**, check whether the settings were saved to the router.
3. If the issue remains, open **http://ROUTER-IP/luci-static/nightfall/prefs.json** and attach the displayed contents to an Issue.

### The "Search" and "Edit" dialogs are too narrow on desktop ([#83](https://github.com/Nikolai752/nightfall-openwrt/issues/83))
LuCI dialogs adapt to their content. In v1.15.2, settings forms were made wider; in v1.15.3, the **Found Wi-Fi access points** dialog was made full width. Update Nightfall and hard-refresh the page.

### "There is nothing here yet" is aligned to the left side of the table
Permanently fixed in v1.16.3 (in v1.15.3, some users still saw the message in the first column). Update and hard-refresh the page.

### The login window became wider and its fields are pushed to the left
Fixed in v1.16.3: the login card width was restored to **380 px**. Update and hard-refresh the page.

### Summary cards are missing from the login page ([#27](https://github.com/Nikolai752/nightfall-openwrt/issues/27))
The router summary is shown **only to clients on the local network**. The cards are hidden when you access the router through an external address or Tailscale. This prevents outsiders from seeing information about your router. Open the panel using the router's local address.

### The icon disappeared from the iPhone Home Screen
When the panel is opened over self-signed HTTPS, iOS may lose the icon. The icon is embedded directly in the page, so update to the latest version. If the old icon remains, remove it from the Home Screen and add it again.

---

## Devices and Internet access

### Connected devices are shown as "offline" ([#73](https://github.com/Nikolai752/nightfall-openwrt/issues/73))
- Update to the latest version (fixes were added in v1.14.1 and v1.15.1), then press **Check now**.
- Wi-Fi clients are detected from their association with the access point; other clients are checked using ARP. DHCP leases are also used.
- Non-standard network layouts (WAN and LAN on one interface, a separate network segment, or the router behind another router) have not been tested in every configuration. If you use such a layout and the status is incorrect, describe it in an Issue and include the network diagram or description and the output of **ip neigh**.

### A phone is shown as "Private MAC" with no manufacturer
Phones using a **Private Wi-Fi Address** use a randomized MAC address, so the manufacturer cannot be identified from it. To make the device recognizable, disable the private address for your network in the phone's Wi-Fi settings or assign the device a name in its device card.

---

## Traffic and charts

### Monthly traffic and the "Daily summary" show different numbers
Fixed in v1.15.1. With packet hardware acceleration (Flow Offloading), the WAN interface sees only a small part of the traffic. Therefore, if WAN traffic is significantly undercounted, the daily total is calculated from device statistics. Such days are marked in the calendar.

### Application traffic is too low or a service is not detected
There are limitations: traffic routed through a VPN or encrypted DNS (DoH/DoT) cannot be identified reliably; counters may be lower when Flow Offloading is enabled; and domain matching is approximate. See [Application traffic in the README](README.en.md#application-traffic).

### Device traffic accounting is missing
Check that conntrack accounting is enabled:

~~~sh
sysctl net.netfilter.nf_conntrack_acct
~~~

The value must be **1**.

### Charts have "loops" and nodes ([#78](https://github.com/Nikolai752/nightfall-openwrt/issues/78))
Fixed in v1.15.0. Update Nightfall.

### History disappeared after reboot
By default, current history is stored in RAM (**/tmp**) and is cleared on reboot. To keep it, set **PERSIST_DIR** to a mounted USB/SD storage path in the monitor settings. If the drive is disconnected, the collector continues in RAM and resumes saving after the drive is mounted; it should not write data to the underlying **/overlay**. See the [README](README.en.md) and the [backup and restore guide](docs/backup-restore.md) for details.

---

## Performance

### My router is underpowered. Can I disable some features? ([#72](https://github.com/Nikolai752/nightfall-openwrt/issues/72))
Enable **LITE=1** in the monitor settings. The collector will poll the router every 60 seconds and disable application traffic accounting and Wi-Fi history, reducing CPU and RAM usage. Set **LITE=0** to return to full mode. You can also:

- Disable animations and live backgrounds under **Personalization**.
- Remove unnecessary tiles and cards on the **Overview** page (the **Overview** tab in **Personalization**).
- If you do not need the monitor, stop the history collector:

~~~sh
/etc/init.d/nightfall-collector stop
/etc/init.d/nightfall-collector disable
~~~

To enable it again: **/etc/init.d/nightfall-collector enable && /etc/init.d/nightfall-collector start**.

---

## How to report an issue

Create an [Issue](https://github.com/Nikolai752/nightfall-openwrt/issues/new) and include:

1. **Theme version:** the **About theme** block in the **Personalization** menu, or **/www/luci-static/nightfall/version.json** on the router.
2. **Router model and OpenWrt version:** output of **cat /etc/openwrt_release | head -3**.
3. **Screenshot** of the problem, preferably with the browser address bar and window size visible.
4. **Browser** and device (computer, iPhone, Android).
5. **What you have already tried:** updating, signing in to LuCI again, and clearing the browser cache.

For bot issues, include the command output requested in the [Telegram](#telegram) section. For network and device issues, describe your network layout. **Do not post your bot token or passwords in an Issue.**
