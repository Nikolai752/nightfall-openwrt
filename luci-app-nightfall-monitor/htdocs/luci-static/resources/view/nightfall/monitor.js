'use strict';
'require view';
'require rpc';
'require fs';
'require poll';
'require ui';
'require network';
'require nightfall-devid as DevId';
'require nightfall-monitor-charts as Charts';

/*
 * Nightfall resource monitor: CPU, memory, temperature, flash and network
 * activity in a Windows 11 / Fluent style dashboard.
 * Data comes from /usr/libexec/nightfall-stats (one JSON object per call).
 */

const STATS = '/usr/libexec/nightfall-stats';
const HIST = '/usr/libexec/nightfall-history';
const CFG = '/usr/libexec/nightfall-config';
const WINDOW = 300;          /* seconds shown in charts */
const ring = Charts.ring, chart = Charts.chart, sparkline = Charts.sparkline;
const INTERVAL = 2;          /* poll interval, seconds */
const FULL_EVERY = 5;        /* full (process) sample every N ticks */
const ALERTS_EVERY = 8;      /* collector alerts / last ping every N ticks */
const DEVICES_EVERY = 4;     /* per-device traffic every N ticks (network tab) */
const HIST_EVERY = 8;        /* history charts every N ticks (history tab) */
const RANGES = { h: [ 'fine', 3600, _('1 час') ], d: [ 'coarse', 86400, _('24 часа') ], w: [ 'coarse', 604800, _('7 дней') ], m: [ 'long', 2592000, _('30 дней') ], q: [ 'long', 7776000, _('90 дней') ] };
const STORE_KEY = 'nightfall-monitor-v1';

const callBoard = rpc.declare({ object: 'system', method: 'board' });
const callIfaces = rpc.declare({ object: 'network.interface', method: 'dump' });
const callHints = rpc.declare({ object: 'luci-rpc', method: 'getHostHints' });
const callWifi = rpc.declare({ object: 'network.wireless', method: 'status' });
const callAssoc = rpc.declare({ object: 'iwinfo', method: 'assoclist', params: [ 'device', 'mac' ], expect: { results: [] } });
const callReboot = rpc.declare({ object: 'system', method: 'reboot' });
const SPEEDBIN = '/usr/libexec/nightfall-speed';
const NOTIFYBIN = '/usr/libexec/nightfall-notify';
const callInitList = rpc.declare({ object: 'luci', method: 'getInitList', params: [ 'name' ], expect: { '': {} } });
const callInitAction = rpc.declare({ object: 'luci', method: 'setInitAction', params: [ 'name', 'action' ], expect: { result: false } });
const callServiceList = rpc.declare({ object: 'service', method: 'list', params: [ 'name' ], expect: { '': {} } });

const HOT_WARN = 80, HOT_CRIT = 90, HOT_SECONDS = 60;
const BANDS = { '2g': _('2,4 ГГц'), '5g': _('5 ГГц'), '6g': _('6 ГГц'), '60g': _('60 ГГц') };

const NF_LOC = (document.documentElement.lang || 'en').replace(/_/g, '-');
const nf1 = new Intl.NumberFormat(NF_LOC, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat(NF_LOC, { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat(NF_LOC, { maximumFractionDigits: 2, minimumFractionDigits: 2 });

const PORTS = { 443: 'HTTPS', 80: 'HTTP', 53: 'DNS', 853: 'DNS-over-TLS', 22: 'SSH', 123: _('Время (NTP)'), 5228: 'Google Play / push', 5223: 'Apple push',
	3478: _('Звонки (STUN)'), 3479: _('Звонки (STUN)'), 1194: 'OpenVPN', 51820: 'WireGuard', 25: _('Почта (SMTP)'), 465: _('Почта (SMTP)'), 587: _('Почта (SMTP)'), 993: _('Почта (IMAP)'),
	143: _('Почта (IMAP)'), 110: _('Почта (POP3)'), 995: _('Почта (POP3)'), 8080: _('HTTP (альт.)'), 8443: _('HTTPS (альт.)'), 1935: _('Стриминг (RTMP)'), 554: _('Видео (RTSP)'),
	5353: 'mDNS', 1900: 'UPnP', 6881: _('Торренты'), 3389: 'RDP', 445: 'SMB', 21: 'FTP', 5222: 'XMPP', 8000: _('HTTP (альт.)'), 8883: 'MQTT', 1883: 'MQTT' };
function portLabel(proto, port) {
	if (port === '-' || port === '') return proto.toUpperCase();
	if (proto === 'udp' && port === '443') return 'QUIC / HTTP3 · UDP 443';
	return (PORTS[port] ? PORTS[port] + ' · ' : '') + proto.toUpperCase() + ' ' + port;
}
const SVC_INFO = { dnsmasq: _('DNS и DHCP'), dropbear: _('SSH-доступ'), uhttpd: _('Веб-сервер LuCI'), rpcd: _('API панели'), firewall: _('Файрвол'), network: _('Сетевые интерфейсы'),
	odhcpd: _('DHCPv6 и RA'), sysntpd: _('Синхронизация времени'), ttyd: _('Веб-терминал'), 'https-dns-proxy': _('DNS поверх HTTPS'), 'nightfall-collector': _('Сборщик истории монитора'),
	log: _('Системный журнал'), cron: _('Планировщик задач'), ubus: _('Шина ubus'), irqbalance: _('Распределение прерываний'), wpad: 'Wi-Fi (hostapd/wpa_supplicant)', hostapd: _('Wi-Fi точка доступа') };
const SVC_PROTECTED = [ 'network', 'uhttpd', 'rpcd', 'dropbear', 'firewall', 'dnsmasq', 'odhcpd', 'log', 'ubus', 'boot', 'system', 'done', 'sysfixtime', 'wpad' ];

const GROUPS = [
	[ /^dnsmasq$/, 'DNS (dnsmasq)', 'g1' ],
	[ /^(uhttpd|rpcd|ucode|luci|nightfall)/, _('Панель и LuCI'), 'g2' ],
	[ /^(hostapd|wpa_|wpad|iw|mt76|ath)/, 'Wi-Fi', 'g3' ],
	[ /^(ttyd|dropbear|sshd|login|getty)/, _('Терминал'), 'g4' ],
	[ /^(sing-box|xray|v2ray|clash|mihomo|openvpn|wg|tailscale|zerotier|nikki|podkop)/, _('VPN и прокси'), 'g5' ],
	[ /^(nginx|lighttpd|adguard|AdGuard|unbound|stubby|https-dns|smartdns|mosdns)/, _('Сетевые службы'), 'g6' ],
	[ /^(procd|ubusd|netifd|logd|odhcp|crond|ntpd|busybox|sh$|ash$|init|syslog|dnsmasq-|fw4|nft|rngd|urngd|ubox|swconfig|hotplug|sleep|awk|cat)/, 'OpenWrt', 'g7' ]
];

function normalizeMonitorIp(ip) {
	const value = String(ip || '').toLowerCase().split('%')[0];
	if (value.indexOf(':') < 0) return value;
	const halves = value.split('::');
	if (halves.length > 2) return value;
	const a = halves[0] ? halves[0].split(':') : [];
	const b = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
	if (halves.length === 1 && a.length !== 8) return value;
	const mid = halves.length > 1 ? new Array(Math.max(0, 8 - a.length - b.length)).fill('0') : [];
	return a.concat(mid, b).map(g => g.padStart(4, '0')).join(':');
}

function trafficBytes(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

function fmtMB(kb) {
	kb = Number(kb);
	if (!Number.isFinite(kb) || kb < 0) return '—';
	const mb = kb / 1024;
	if (mb >= 1024) return nf2.format(mb / 1024) + _(' ГБ');
	return (mb >= 100 ? nf0 : nf1).format(mb) + _(' МБ');
}

function fmtBytes(b) {
	b = Number(b);
	if (!Number.isFinite(b) || b < 0) return '—';
	const u = [ _('Б'), _('КБ'), _('МБ'), _('ГБ'), _('ТБ') ];
	let i = 0;
	while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
	return (i < 2 ? nf0 : nf2).format(b) + ' ' + u[i];
}

function fmtRate(bps) {
	bps = Number(bps);
	if (!Number.isFinite(bps) || bps < 0) return [ '—', '' ];
	const bits = bps * 8;
	if (bits >= 1e9) return [ nf2.format(bits / 1e9), _('Гбит/с') ];
	if (bits >= 1e6) return [ (bits >= 1e8 ? nf0 : nf1).format(bits / 1e6), _('Мбит/с') ];
	if (bits >= 1e3) return [ nf0.format(bits / 1e3), _('Кбит/с') ];
	return [ nf0.format(bits), _('бит/с') ];
}

function rateText(bps) {
	const r = fmtRate(bps);
	return r[1] ? r[0] + ' ' + r[1] : r[0];
}

function fmtUptime(s) {
	s = Number(s);
	if (!Number.isFinite(s) || s < 0) return '—';
	const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
	return (d ? d + _(' д ') : '') + h + _(' ч ') + m + _(' мин');
}

function fmtTemp(v) {
	v = Number(v);
	return Number.isFinite(v) ? nf1.format(v) + ' °C' : '—';
}

function fmtSyslogDay(s) {
	return String(s).replace(/^([A-Z][a-z]{2}) (\d+) /, (m, a, d) => {
		const i = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }[a];
		if (i == null) return m;
		const t = new Date(); t.setDate(1); t.setMonth(i); t.setDate(+d);
		return t.toLocaleDateString(NF_LOC, { day: 'numeric', month: 'short' }) + ', ';
	});
}

function niceCeil(v) {
	if (v <= 0) return 1;
	const p = Math.pow(10, Math.floor(Math.log10(v)));
	for (const m of [ 1, 2, 2.5, 5, 10 ])
		if (v <= m * p) return m * p;
	return 10 * p;
}

const XCSS = `
.nfm .nfm-click { cursor: pointer; }
.nfm .nfm-click:hover td { background: var(--nfm-card2); }
.nfm-lst { display: grid; gap: 7px; }
.nfm-li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 4px 14px; align-items: baseline; font-size: 13px; }
.nfm-li .nm { min-width: 0; overflow-wrap: anywhere; }
.nfm-li .nm small { color: var(--nfm-dim); margin-left: 6px; }
.nfm-li .v { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.nfm-li .bar { grid-column: 1 / -1; }
.nfm-two { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; }
.nfm-two h4 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--nfm-dim); text-transform: none; border: 0; padding: 0; }
.nfm-jr { display: grid; grid-template-columns: 22px 130px minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 7px 0; font-size: 13px; border-bottom: 1px solid color-mix(in srgb, var(--nfm-border) 60%, transparent); }
.nfm-jr:last-child { border-bottom: 0; }
.nfm-jr time { color: var(--nfm-dim); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.nfm-jr b { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nfm-jr.outage .ic { color: #e5484d; } .nfm-jr.boot .ic { color: #3b82f6; }
.nfm-svc { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 6px 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid color-mix(in srgb, var(--nfm-border) 60%, transparent); }
.nfm-svc:last-child { border-bottom: 0; }
.nfm-svc .st { width: 10px; height: 10px; border-radius: 50%; background: #9aa0a6; }
.nfm-svc.run .st { background: #13a10e; } .nfm-svc.bad .st { background: #e5484d; box-shadow: 0 0 0 3px color-mix(in srgb, #e5484d 25%, transparent); }
.nfm-svc .nm { font-weight: 600; font-size: 13.5px; } .nfm-svc .ds { color: var(--nfm-dim); font-size: 12px; }
.nfm-svc .ac { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.nfm-mini { font: inherit; font-size: 12px; padding: 5px 11px; border-radius: 6px; cursor: pointer; color: var(--nfm-text); background: var(--nfm-card); border: 1px solid var(--nfm-border); }
.nfm-mini:hover:not([disabled]) { background: var(--nfm-card2); } .nfm-mini[disabled] { opacity: .4; cursor: not-allowed; }
.nfm-wd { min-width: min(520px, 86vw); }
.nfm-wd svg { width: 100%; height: 150px; display: block; }
.nfm-wd .ax { fill: var(--nfm-dim); font-size: 8px; }
.nfm-flash { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
.nfm-warn { color: #e5484d; font-weight: 600; }
.nfm-app-toolbar { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; margin-bottom:12px; }
.nfm-app-summary { margin:0 0 12px; }
.nfm-app-summary .nfm-tile { min-width:0; }
.nfm-app-summary .nfm-tile small { display:block; margin-top:3px; }
.nfm-app-categories { display:grid; gap:7px; }
.nfm-app-distribution { display:grid; grid-template-columns:minmax(190px,260px) minmax(0,1fr); align-items:start; gap:clamp(18px,3vw,42px); min-height:250px; }
.nfm-app-donut-layout { display:contents; }
.nfm-app-donut { width:clamp(180px,19vw,236px); height:clamp(180px,19vw,236px); justify-self:center; display:grid; place-items:center; border-radius:50%; }
.nfm-app-donut-center { width:66%; height:66%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; border:1px solid var(--nfm-border); border-radius:50%; background:var(--nfm-card); }
.nfm-app-donut-center b { font-size:clamp(17px,1.5vw,22px); font-variant-numeric:tabular-nums; }
.nfm-app-donut-center small { color:var(--nfm-dim); font-size:11px; }
.nfm-app-legend { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px 22px; min-width:0; }
.nfm-app-legend-row { display:grid; grid-template-columns:9px minmax(0,1fr) auto auto; gap:8px; align-items:center; min-width:0; font-size:12.5px; }
.nfm-app-legend-row span { min-width:0; overflow-wrap:anywhere; }
.nfm-app-legend-row b, .nfm-app-legend-size { white-space:nowrap; font-variant-numeric:tabular-nums; }
.nfm-app-legend-row b { font-weight:700; }
.nfm-app-legend-size { color:var(--nfm-dim); text-align:right; }
.nfm-app-legend-dot { width:9px; height:9px; border-radius:3px; background:var(--nfm-app-color); }
.nfm-app-legend-more { grid-column:1 / -1; border-top:1px solid var(--nfm-border); padding-top:7px; }
.nfm-app-legend-more > summary { cursor:pointer; display:flex; align-items:center; justify-content:space-between; gap:12px; color:var(--nfm-text); font-size:12px; font-weight:600; list-style:none; }
.nfm-app-legend-more > summary::-webkit-details-marker { display:none; }
.nfm-app-legend-more > summary::after { content:"⌄"; color:var(--nfm-dim); }
.nfm-app-legend-more[open] > summary::after { content:'⌃'; }
.nfm-app-legend-more .nfm-app-legend { margin-top:10px; }
.nfm-app-category { border:1px solid var(--nfm-border); border-radius:var(--nf-radius-in, 9px); background:var(--nfm-card2); overflow:hidden; }
.nfm-app-category > summary { display:grid; grid-template-columns:12px 9px minmax(145px, .8fr) minmax(100px,1.5fr) auto auto; gap:8px 12px; align-items:center; padding:9px 12px; cursor:pointer; list-style:none; font-size:13px; }
.nfm-app-category > summary::-webkit-details-marker { display:none; }
.nfm-app-category > summary::before { content:'›'; color:var(--nfm-dim); font-size:18px; transform:rotate(0); transition:transform .15s; }
.nfm-app-category[open] > summary::before { transform:rotate(90deg); }
.nfm-app-category-icon { width:9px; height:9px; border-radius:3px; background:var(--nfm-app-color); }
.nfm-app-category-name { min-width:0; overflow-wrap:anywhere; }
.nfm-app-category-bar { height:8px; min-width:0; border-radius:999px; overflow:hidden; background:color-mix(in srgb,var(--nfm-dim) 20%,transparent); }
.nfm-app-category-bar > i { display:block; height:100%; max-width:100%; border-radius:inherit; background:var(--nfm-app-color); }
.nfm-app-category > summary b { font-variant-numeric:tabular-nums; white-space:nowrap; }
.nfm-app-category > summary small { color:var(--nfm-dim); font-variant-numeric:tabular-nums; white-space:nowrap; }
.nfm-app-category-items { padding:0 12px 8px 30px; }
.nfm-app-item { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 10px; align-items:center; padding:7px 0; border-top:1px solid color-mix(in srgb,var(--nfm-border) 65%,transparent); font-size:12.5px; }
.nfm-app-item-name { min-width:0; overflow-wrap:anywhere; }
.nfm-app-item-route { grid-column:1; display:flex; flex-wrap:wrap; gap:3px; }
.nfm-app-item-route .nfm-chip { margin:0; }
.nfm-app-item > b { grid-column:2; grid-row:1 / span 2; white-space:nowrap; font-variant-numeric:tabular-nums; }
.nfm-app-top-list .nfm-host { padding:5px 0; }
.nfm-app-top-list .nfm-host small { display:block; margin:3px 0 0; }
.nfm-app-unknown-list .nfm-host { padding:6px 0; }
.nfm-app-unknown-list .nfm-host small { grid-column:1 / -1; margin:0; }
@media (max-width: 760px) {
.nfm-app-distribution { grid-template-columns:minmax(0,1fr); gap:16px; padding:4px 0; }
.nfm-app-donut { width:176px; height:176px; }
.nfm-app-legend { grid-template-columns:minmax(0,1fr); gap:9px; }
.nfm-app-legend-row { grid-template-columns:9px minmax(0,1fr) auto auto; font-size:12px; }
.nfm-app-legend-more { grid-column:1; }
.nfm-app-category > summary { grid-template-columns:12px 9px minmax(0,1fr) auto auto auto; gap:7px 9px; padding:10px; }
.nfm-app-category-bar { grid-column:3 / 6; grid-row:2; }
.nfm-app-category > summary small { grid-column:6; grid-row:2; }
}
@media (max-width: 640px) { .nfm-mini, .nfm-btn, .nfm-act, .nfm-tab { min-height: 40px; } .nfm-app-toolbar { justify-content:stretch; } .nfm-app-toolbar .nfm-sel { flex:1 1 140px; min-width:0; max-width:100%; } .nfm-mini, .nfm-btn, .nfm-act, .nfm-tab { min-height: 40px; } .nfm-jr { grid-template-columns: 22px minmax(0, 1fr) auto; align-items: start; row-gap: 2px; } .nfm-jr .ic { grid-column: 1; grid-row: 1; } .nfm-jr time { grid-column: 2 / -1; grid-row: 1; } .nfm-jr > span:not(.ic) { grid-column: 2; grid-row: 2; min-width: 0; overflow-wrap: anywhere; } .nfm-jr b { grid-column: 3; grid-row: 2; } .nfm-svc { grid-template-columns: 12px minmax(0, 1fr); } .nfm-svc .ac { grid-column: 1 / -1; justify-content: flex-start; } }
/* History layout: keep the monitor's shared Fluent surfaces and theme tokens. */
.nfm-history { display:grid; gap:12px; min-width:0; }
.nfm-history > .nfm-grid { min-width:0; margin:0; gap:12px; }
.nfm-history .nfm-card { min-width:0; }
.nfm-history .nfm-card-title { min-width:0; }
.nfm-history .nfm-chart { min-width:0; }
.nfm-history .nfm-exp { align-items:stretch; }
.nfm-history .nfm-exp .nfm-btn { flex:0 1 auto; min-width:0; }
.nfm-history .nfm-cmp-t { min-width:0; }
.nfm-history .nfm-note-s { overflow-wrap:anywhere; }
@media (max-width:860px) {
 .nfm-history .nfm-g21 { grid-template-columns:minmax(0,1fr); }
}
@media (max-width:640px) {
 .nfm-history { gap:10px; }
 .nfm-history > .nfm-grid { gap:10px; }
 .nfm-history .nfm-card { padding:13px 12px; }
 .nfm-history .nfm-exp { display:grid; grid-template-columns:minmax(0,1fr); }
 .nfm-history .nfm-exp .nfm-btn { width:100%; justify-content:center; }
 .nfm-history .nfm-cmp-t { grid-template-columns:minmax(0,1.15fr) minmax(0,1fr) minmax(0,1fr) 58px; font-size:11.5px; }
 .nfm-history .nfm-cmp-t > div { padding:7px 4px; }

}
`;

function SVG(tag, attrs, children) {
	const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const k in attrs || {})
		el.setAttribute(k, attrs[k]);
	for (const c of [].concat(children || []))
		if (c != null) el.appendChild(c);
	return el;
}

function groupOf(name) {
	for (const g of GROUPS)
		if (g[0].test(name)) return { label: g[1], cls: g[2] };
	return { label: name, cls: 'gx' };
}


// Категории трафика: только классификация уже распознанных имён, без догадок по IP.
const APP_TRAFFIC_CATEGORIES = {
	'YouTube': 'Видео и развлечения', 'Netflix': 'Видео и развлечения', 'Twitch': 'Видео и развлечения',
	'Spotify': 'Видео и развлечения', 'RuTube': 'Видео и развлечения', 'VK Видео': 'Видео и развлечения',
	'Zoom': 'Мессенджеры и звонки', 'Telegram': 'Мессенджеры и звонки', 'WhatsApp': 'Мессенджеры и звонки',
	'Discord': 'Мессенджеры и звонки', 'MAX': 'Мессенджеры и звонки', 'Skype': 'Мессенджеры и звонки',
	'ВКонтакте': 'Социальные сети', 'Одноклассники': 'Социальные сети', 'Дзен': 'Социальные сети',
	'Instagram': 'Социальные сети', 'Facebook': 'Социальные сети', 'TikTok': 'Социальные сети', 'X (Twitter)': 'Социальные сети',
	'Wildberries': 'Магазины и маркетплейсы', 'Wibes': 'Магазины и маркетплейсы', 'Ozon': 'Магазины и маркетплейсы', 'RuStore': 'Магазины приложений',
	'Avito': 'Магазины и маркетплейсы', 'AliExpress': 'Магазины и маркетплейсы',
	'Т-Банк': 'Банки и платежи', 'Сбербанк': 'Банки и платежи', 'Госуслуги': 'Государственные сервисы',
	'Steam': 'Игры', 'Xbox': 'Игры', 'PlayStation': 'Игры', 'Riot Games': 'Игры', 'EA': 'Игры',
	'Roblox': 'Игры', 'Battle.net': 'Игры', 'Lesta': 'Игры', 'Playrix': 'Игры',
	'OneDrive': 'Облака и хранилища', 'Google Drive': 'Облака и хранилища', 'Google Photos': 'Облака и хранилища',
	'Dropbox': 'Облака и хранилища', 'Apple iCloud': 'Облака и хранилища',
	'Google Meet': 'Мессенджеры и звонки', 'Mail.ru': 'Почта и коммуникации',
	'Яндекс': 'Поиск и сервисы', 'Google': 'Поиск и сервисы', 'Microsoft': 'Системные службы',
	'Apple': 'Системные службы', 'Amazon': 'Облака и хранилища', 'GitHub': 'Разработка',
	'Kaspersky': 'Безопасность', 'Cloudflare': 'Сеть и инфраструктура'
};
const APP_TRAFFIC_INFRA = /^(?:okcdn\.ru|cdn77\.org|akamai\.net|akamaiedge\.net|edgesuite\.net|akadns\.net|fastly\.net|fastly-edge\.com|gcdn\.co|b-cdn\.net|ecdnx\.com|cdn-vk\.ru)$/i;
const APP_TRAFFIC_ADS = /(?:doubleclick\.net|googlesyndication\.com|googletagservices\.com|2mdn\.net|app-measurement\.com|crashlytics\.com|app-analytics-services\.com|mediation\.goog|vk-analytics\.ru|uxfeedback\.ru)/i;
const APP_TRAFFIC_DNS = /^(?:dns\.google|resolver\.arpa|quad9\.net)$/i;
const APP_TRAFFIC_CERT = /^(?:lencr\.org|pki\.goog|digicert\.com)$/i;

function appTrafficCategory(name) {
	const m = /^Прочее(?: · (.+))?$/.exec(name || '');
	if (m) {
		const domain = m[1] || '';
		if (!domain || domain === 'Нет DNS-имени' || domain === 'Общий IP (CDN)' || domain === 'Несколько доменов') return 'Не определено';
		if (APP_TRAFFIC_ADS.test(domain)) return 'Реклама и аналитика';
		if (APP_TRAFFIC_DNS.test(domain)) return 'DNS и инфраструктура';
		if (APP_TRAFFIC_CERT.test(domain)) return 'Безопасность и сертификаты';
		if (/^(?:steamcommunity\.com|steamserver\.net|steamconnecttest\.com|gamepass\.com|xboxservices\.com|nvidiagrid\.net|giants-software\.com|farming-simulator\.com|geforce\.com)$/i.test(domain)) return 'Игры';
		if (/^(?:hicloud\.com|dbankcloud\.(?:ru|cn)|dbankcdn\.ru|icloud-content\.com)$/i.test(domain)) return 'Облака и хранилища';
		if (/^(?:windows\.com|windows\.net|live\.net|msn\.com|android\.com|miui\.com|xiaomi\.(?:com|net)|transsion-os\.com|transsion-message\.com|mediatek\.com|blackberry\.com)$/i.test(domain)) return 'Системные службы';
		if (/^(?:palmplaystore\.com|palm\.tech)$/i.test(domain)) return 'Магазины приложений';
		if (/^(?:sberbank\.ru|t-bank-app\.ru|tbank-app\.ru)$/i.test(domain)) return 'Банки и платежи';
		if (/^gosuslugi\.ru$/i.test(domain)) return 'Государственные сервисы';
		if (/^(?:magnit\.ru|5ka\.ru|x5\.ru|x5media\.ru)$/i.test(domain)) return 'Продукты и магазины';
		if (/^(?:snapchat\.com|sc-cdn\.net)$/i.test(domain)) return 'Социальные сети';
		if (/^tamtam\.chat$/i.test(domain)) return 'Мессенджеры и звонки';
		if (/^findmykids\.org$/i.test(domain)) return 'Семья и геолокация';
		if (/^revenuecat\.com$/i.test(domain)) return 'Платежи в приложениях';
		if (/^(?:apptracer\.ru|trace-flow\.ru|uxfeedback\.ru)$/i.test(domain)) return 'Реклама и аналитика';
		if (/^rtcdn\.ru$/i.test(domain)) return 'Видео и развлечения';
		if (APP_TRAFFIC_INFRA.test(domain)) return 'CDN и инфраструктура';
		if (domain === 'aaplimg.com' || /(?:^|\.)apple\.com$/i.test(domain)) return 'Системные службы';
		if (/^(?:windows\.com|windows\.net|live\.net|msn\.com)$/i.test(domain)) return 'Системные службы';
		return 'Не определено';
	}
	return APP_TRAFFIC_CATEGORIES[name] || 'Другие приложения';
}

function appTrafficDisplayName(name) {
	const m = /^Прочее(?: · (.+))?$/.exec(name || '');
	if (!m) return name || _('Неизвестное приложение');
	const domain = m[1] || '';
	return ({ 'Нет DNS-имени': _('IP без DNS-имени'), 'Общий IP (CDN)': _('Общий IP / CDN'), 'Несколько доменов': _('Несколько доменов') })[domain] || domain || _('IP без DNS-имени');
}

function sumMonitorAppTraffic(data, days, ip) {
	const apps = {}, categories = {}, routes = { VPN: 0, Direct: 0, Unknown: 0 }, devices = {};
	const selectedIps = new Set();
	if (ip && typeof ip.forEach === 'function') ip.forEach(x => selectedIps.add(normalizeMonitorIp(x)));
	else if (ip) selectedIps.add(normalizeMonitorIp(ip));
	const bytes = value => {
		const n = Number(value);
		return Number.isFinite(n) && n > 0 ? n : 0;
	};
	const add = (addr, name, route, down, up) => {
		route = [ 'VPN', 'Direct', 'Unknown' ].includes(route) ? route : 'Unknown';
		const d = bytes(down), u = bytes(up), total = d + u;
		if (selectedIps.size && !selectedIps.has(normalizeMonitorIp(addr))) return;
		const a = apps[name] || (apps[name] = { name, category: appTrafficCategory(name), down: 0, up: 0, total: 0, routes: {} });
		a.down += d; a.up += u; a.total += total; a.routes[route] = (a.routes[route] || 0) + total;
		const c = categories[a.category] || (categories[a.category] = { name: a.category, total: 0, apps: {} });
		c.total += total; c.apps[name] = a;
		routes[route] += total;
		devices[addr] = (devices[addr] || 0) + total;
	};
	for (const r of data.day || []) add(r[0], r[1], r.length >= 5 ? r[2] : 'Unknown', r.length >= 5 ? r[3] : r[2], r.length >= 5 ? r[4] : r[3]);
	if (days > 1) {
		const today = String(data.today || '');
		const base = /^\d{8}$/.test(today) ? new Date(+today.slice(0, 4), +today.slice(4, 6) - 1, +today.slice(6, 8)) : new Date();
		base.setDate(base.getDate() - (days - 1));
		const from = base.getFullYear() * 10000 + (base.getMonth() + 1) * 100 + base.getDate();
		for (const r of data.hist || []) if (+r[0] >= from) add(r[1], r[2], r.length >= 6 ? r[3] : 'Unknown', r.length >= 6 ? r[4] : r[3], r.length >= 6 ? r[5] : r[4]);
	}
	return { apps: Object.values(apps).sort((a, b) => b.total - a.total), categories: Object.values(categories).sort((a, b) => b.total - a.total), routes, devices,
		total: routes.VPN + routes.Direct + routes.Unknown };
}

function sumMonitorDeviceApps(data, deviceIps) {
	const ips = new Set();
	if (deviceIps && typeof deviceIps.forEach === 'function')
		deviceIps.forEach(ip => ips.add(normalizeMonitorIp(ip)));
	else if (Array.isArray(deviceIps))
		deviceIps.forEach(ip => ips.add(normalizeMonitorIp(ip)));
	const apps = {};
	const bytes = value => {
		const n = Number(value);
		return Number.isFinite(n) && n > 0 ? n : 0;
	};
	const add = (name, down, up) => {
		const total = bytes(down) + bytes(up);
		if (name && total > 0) apps[name] = (apps[name] || 0) + total;
	};
	/* apps.day: [ip, app, route, down, up] */
	for (const row of data && data.day || []) {
		if (!ips.has(normalizeMonitorIp(row[0]))) continue;
		if (row.length >= 5) add(row[1], row[3], row[4]);
		else add(row[1], row[2], row[3]);
	}
	/* apps.hist: [date, ip, app, route, down, up] */
	for (const row of data && data.hist || []) {
		if (!ips.has(normalizeMonitorIp(row[1]))) continue;
		if (row.length >= 6) add(row[2], row[4], row[5]);
		else add(row[2], row[3], row[4]);
	}
	return Object.entries(apps).sort((a, b) => b[1] - a[1]);
}

function monitorBuildDhcpIdentity(leases) {
	const candidates = {}, names = {};
	for (const row of leases || []) {
		if (!Array.isArray(row) || row.length < 2) continue;
		const ip = normalizeMonitorIp(row[0]);
		const mac = String(row[1] || '').toUpperCase();
		if (!ip || !/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) continue;
		(candidates[ip] || (candidates[ip] = new Set())).add(mac);
		const name = String(row[2] || '').trim();
		if (name && name !== '*') (names[ip] || (names[ip] = new Set())).add(name);
	}
	const ipMac = {}, ipName = {}, ambiguous = {};
	for (const ip in candidates) {
		if (candidates[ip].size !== 1) { ambiguous[ip] = true; continue; }
		ipMac[ip] = Array.from(candidates[ip])[0];
		if (names[ip] && names[ip].size === 1) ipName[ip] = Array.from(names[ip])[0];
	}
	return { ipMac, ipName, ambiguous };
}

function monitorSharedNeighbourMacs(neighbours) {
	const ips = {};
	for (const row of neighbours || []) {
		const ip = normalizeMonitorIp(row && row[0]);
		const mac = String(row && row[1] || '').toUpperCase();
		if (!ip || !/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) || ip.indexOf(':') >= 0) continue;
		(ips[mac] || (ips[mac] = new Set())).add(ip);
	}
	return new Set(Object.keys(ips).filter(mac => ips[mac].size > 1));
}

function monitorBuildIpMacMap(hints, neighbours, wifi, leases) {
	const dhcp = monitorBuildDhcpIdentity(leases), proxyMacs = monitorSharedNeighbourMacs(neighbours);
	const hintCandidates = {}, ipMac = {};
	/* Runtime DHCP leases are the authoritative IP -> endpoint MAC source.
	 * LuCI host hints can inherit a bridge/proxy neighbour MAC for many hosts. */
	for (const ip in dhcp.ipMac) ipMac[ip] = dhcp.ipMac[ip];

	for (const mac0 of Object.keys(hints || {})) {
		const mac = String(mac0).toUpperCase(), hint = hints[mac0] || {};
		if (!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) || proxyMacs.has(mac)) continue;
		for (const addr of (hint.ipaddrs || []).concat(hint.ip6addrs || [])) {
			const ip = normalizeMonitorIp(addr);
			if (!ip || dhcp.ipMac[ip] || dhcp.ambiguous[ip]) continue;
			(hintCandidates[ip] || (hintCandidates[ip] = new Set())).add(mac);
		}
	}
	/* Host hints are a fallback only when DHCP has no entry and the IP is not ambiguous. */
	for (const ip in hintCandidates)
		if (hintCandidates[ip].size === 1 && !dhcp.ambiguous[ip]) ipMac[ip] = Array.from(hintCandidates[ip])[0];

	for (const row of neighbours || []) {
		const ip = normalizeMonitorIp(row && row[0]), mac = String(row && row[1] || '').toUpperCase();
		if (!ip || !/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) || ipMac[ip] || dhcp.ambiguous[ip]) continue;
		if (hintCandidates[ip] && hintCandidates[ip].size > 1) continue;
		/* A MAC repeated by multiple IPv4 neighbours is a shared next hop,
		 * not proof that those IP addresses belong to one endpoint. */
		if (proxyMacs.has(mac)) continue;
		ipMac[ip] = mac;
	}
	return ipMac;
}

function monitorIsInfrastructureName(name) {
	const value = String(name || '').trim().replace(/\.lan$/i, '');
	return /(?:^|[^a-z0-9])(?:router|gateway|repeater|extender|range[- _]?extender|mesh|bridge|access[- _]?point|wireless[- _]?ap|wifi[- _]?ap|ap)(?:$|[^a-z0-9])/i.test(value)
		|| /^re\d{3,5}$/i.test(value);
}

function monitorBuildWifiDisplayRows(wifi, hints, neighbours, leases) {
	const direct = (wifi || []).map(row => Object.assign({}, row));
	const directMacs = new Set(direct.map(row => String(row.mac || '').toUpperCase()).filter(Boolean));
	const identities = monitorBuildIpMacMap(hints, neighbours, direct, leases);
	const dhcp = monitorBuildDhcpIdentity(leases);
	const neighbourByIp = new Map();
	for (const row of neighbours || []) {
		const ip = normalizeMonitorIp(row && row[0]), mac = String(row && row[1] || '').toUpperCase();
		if (ip && mac) neighbourByIp.set(ip, { mac, state: String(row[2] || '').toUpperCase() });
	}
	const byUpstream = {}, infrastructureNames = {}, bridgeMacs = new Set();
	const hintName = mac => {
		const h = hints[mac] || hints[String(mac || '').toLowerCase()] || {};
		return String(h.name || '').trim();
	};
	for (const ip of Object.keys(identities)) {
		const upstream = neighbourByIp.get(ip), endpoint = identities[ip];
		if (!upstream || !directMacs.has(upstream.mac) || upstream.mac === endpoint) continue;
		bridgeMacs.add(upstream.mac);
		const name = dhcp.ipName[ip] || hintName(endpoint);
		if (monitorIsInfrastructureName(name)) {
			infrastructureNames[upstream.mac] = name.replace(/\.lan$/i, '');
			continue;
		}
		const rows = byUpstream[upstream.mac] || (byUpstream[upstream.mac] = {});
		rows[endpoint] = { mac: endpoint, ip, upstream: upstream.mac, state: upstream.state };
	}
	const enriched = direct.map(row => {
		const mac = String(row.mac || '').toUpperCase(), bridge = bridgeMacs.has(mac);
		return Object.assign({}, row, {
			proxyStation: bridge,
			displayName: infrastructureNames[mac] || (bridge ? '' : hintName(mac))
		});
	});
	const inferred = [];
	for (const upstream of Object.keys(byUpstream)) {
		for (const row of Object.values(byUpstream[upstream])) inferred.push({
			mac: row.mac, ip: row.ip, ssid: _('За ретранслятором'), band: 'proxy', proxy: true,
			upstream: row.upstream, proxyState: row.state, signal: null, rx: null, tx: null,
			connected_time: null
		});
	}
	return enriched.concat(inferred);
}

function sumMonitorAppDeviceTraffic(data, fromDate, hints, neighbours, wifi, routerIps, leases) {
	/* Backward compatibility: older callers passed routerIps as argument four. */
	if (neighbours && typeof neighbours.has === 'function' && !Array.isArray(neighbours)) {
		routerIps = neighbours; neighbours = []; wifi = []; leases = [];
	}
	const ipMac = monitorBuildIpMacMap(hints, neighbours, wifi, leases), totals = {};
	const add = (ip, down, up) => {
		const norm = normalizeMonitorIp(ip);
		const mac = ipMac[norm] || '';
		const key = routerIps && routerIps.has && routerIps.has(ip) ? 'router' : mac || 'ip:' + norm;
		const row = totals[key] || (totals[key] = { key, mac, ip, total: 0 });
		row.total += trafficBytes(down) + trafficBytes(up);
	};
	for (const row of data && data.day || []) add(row[0], row.length >= 5 ? row[3] : row[2], row.length >= 5 ? row[4] : row[3]);
	for (const row of data && data.hist || []) {
		if (Number(row[0]) < Number(fromDate)) continue;
		add(row[1], row.length >= 6 ? row[4] : row[3], row.length >= 6 ? row[5] : row[4]);
	}
	return Object.values(totals).filter(row => row.total > 0).sort((a, b) => b.total - a.total);
}

function sumMonitorDeviceDailyTraffic(rows, hints, neighbours, wifi, routerIps, leases) {
	const ipMac = monitorBuildIpMacMap(hints, neighbours, wifi, leases), totals = {};
	for (const [ip, down, up] of rows || []) {
		if (routerIps && routerIps.has && routerIps.has(ip)) continue;
		const norm = normalizeMonitorIp(ip), mac = ipMac[norm] || '', key = mac || 'ip:' + norm;
		const row = totals[key] || (totals[key] = { mac, ip, total: 0 });
		row.total += trafficBytes(down) + trafficBytes(up);
		if (row.ip.indexOf(':') >= 0 && String(ip).indexOf(':') < 0) row.ip = ip;
	}
	return Object.values(totals).filter(row => row.total > 0).sort((a, b) => b.total - a.total);
}

function monitorDeviceOwnsHistoricalRow(deviceMac, deviceIps, rowIp, rowMac) {
	const mac = String(deviceMac || '').toUpperCase();
	const historicalMac = String(rowMac || '').toUpperCase();
	/* Наличие MAC в архиве запрещает fallback по IP: адрес мог перейти другому клиенту. */
	if (historicalMac && historicalMac !== '-') return !!mac && historicalMac === mac;
	return !!rowIp && !!deviceIps && deviceIps.has(normalizeMonitorIp(rowIp));
}

/* ---------- widgets ---------- */

const CARD_ICONS = [
	[ /^Wi.Fi:|сигнал Wi.Fi|Wi-Fi 信号/i, 'wifi' ], [ /журнал|日志|更新/i, 'events' ], [ /хранен|износ|存储|闪存|损耗/i, 'disk' ], [ /канал|信道|带宽|频段/i, 'net' ], [ /служб|服务/i, 'quick' ],
	[ /сводка|汇总|概览/i, 'events' ], [ /процессор|программ|ядр|处理ить|CPU|核心|进程/i, 'system' ], [ /памят|内存/i, 'mem' ], [ /температур|温度/i, 'temp' ], [ /хранилищ|флеш|flash|存储/i, 'disk' ],
	[ /wi-?fi/i, 'wifi' ], [ /устройств|клиент|кто держит|设备|客户端/i, 'top' ], [ /интерфейс|скорост|трафик|интернет|сеть|связ|接口|速率|流量|互联网|网络|链路|连接|断开|地址|查询/i, 'net' ],
	[ /событ|предупрежд|истори|事件|警报|历史|异常|活动/i, 'events' ], [ /настройк|设置|建议|配置|检查/i, 'quick' ]
];

const HEAT = {
	cpu: [ _('Процессор'), r => r[1], v => Math.round(v) + '%' ],
	mem: [ _('Память'), r => r[2], v => Math.round(v) + '%' ],
	ping: [ _('Пинг'), r => r[7], v => Math.round(v) + _(' мс') ],
	net: [ _('Трафик'), r => (r[4] >= 0 && r[5] >= 0) ? r[4] + r[5] : null, v => (v * 8 / 1e6).toFixed(1) + _(' Мбит/с') ]
};

function card(title, body, extra) {
	const first = Array.isArray(title) ? title.find(x => typeof x === 'string') : title;
	const ic = typeof first === 'string' ? (CARD_ICONS.find(x => x[0].test(first)) || [ 0, 'generic' ])[1] : null;
	return E('section', { class: 'nfm-card' + (extra ? ' ' + extra : '') }, [
		title ? E('h3', { class: 'nfm-card-title' }, ic ? [ E('i', { class: 'nf-ci', 'data-i': ic }) ].concat(title) : title) : null, body ]);
}

/* «как обычно в это время»: среднее значение колонки по 15-минутным отрезкам суток за все дни, что есть в сводке (до 7 дней) */
function usualCurve(rows, times, i) {
	if (!rows || rows.length < 288) return times.map(() => null);   /* меньше суток данных — сравнивать не с чем */
	const sum = new Array(96).fill(0), cnt = new Array(96).fill(0), bin = t => { const d = new Date(t * 1000); return d.getHours() * 4 + Math.floor(d.getMinutes() / 15); };
	for (const r of rows) { const v = r[i]; if (v == null || v < 0) continue; const b = bin(r[0]); sum[b] += v; cnt[b]++; }
	return times.map(t => { const b = bin(t); return cnt[b] ? sum[b] / cnt[b] : null; });
}

function legendDot(cls, text) {
	return E('span', { class: 'nfm-leg' }, [ E('i', { class: 'nfm-dot ' + cls }), text ]);
}

/* Dark/light detection for non-nightfall themes: --nf-* and --background-color-*
   are absent there, so the fallbacks must match the host theme. Walk the
   ancestors of the monitor root — the first opaque background is what sits
   behind the cards; if everything is transparent (background-image themes
   like kucat), fall back to body text luminance, then prefers-color-scheme. */
function nfmParseRgb(s) {
	const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(s || '');
	if (!m) return null;
	let a = 1;
	if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
	return { r: +m[1], g: +m[2], b: +m[3], a: a };
}

function nfmLum(c) { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }

function nfmDetectDark(root) {
	const de = document.documentElement;
	if (de.dataset.darkmode === 'true') return true;
	if (de.dataset.darkmode === 'false') return false;
	for (let el = root; el; el = el.parentElement) {
		const c = nfmParseRgb(getComputedStyle(el).backgroundColor);
		if (c && c.a > 0.5) return nfmLum(c) < 0.45;
		if (el === de) break;
	}
	const fg = nfmParseRgb(getComputedStyle(document.body).color);
	if (fg && fg.a > 0.5) return nfmLum(fg) > 0.6;
	return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function nfmApplyTheme(root) {
	root.classList.toggle('nfm-dark', nfmDetectDark(root));
}

const CSS = `
.nfm { --nfm-card: var(--nf-card, var(--background-color-medium, var(--nfm-fb-card, #fff))); --nfm-card2: var(--nf-card-alt, var(--background-color-low, var(--nfm-fb-card2, #f4f4f4)));
  --nfm-border: var(--nf-stroke, var(--nfm-fb-border, rgba(128,128,128,.22))); --nfm-text: var(--text-color-highest, var(--nfm-fb-text, inherit)); --nfm-dim: var(--text-color-medium, var(--nfm-fb-dim, #666));
  --nfm-accent: var(--nf-accent, var(--primary-color-high, #0067c0)); --nfm-r: var(--nf-radius, 8px);
  --c-cpu: var(--nf-accent, #0078d4); --c-mem: #7a5cc7; --c-temp: #e8710a; --c-flash: #00a0b0; --c-down: var(--nf-accent, #0078d4); --c-up: #13a10e;
  --g1:#00a3b5; --g2:#7a5cc7; --g3:#d6479b; --g4:#e8a30a; --g5:#0f8ee9; --g6:#2fa64a; --g7:#7d8aa0; --gx:#9aa5b4;
  color: var(--nfm-text); }
:root[data-darkmode="true"] .nfm, .nfm.nfm-dark { --c-cpu:var(--nf-accent, #4cc2ff); --c-mem:#b39bff; --c-temp:#ffa94d; --c-flash:#4fd8e6; --c-down:var(--nf-accent, #4cc2ff); --c-up:#6ccb5f;
  --g1:#3dd0e0; --g2:#b39bff; --g3:#ff7fbf; --g4:#ffc552; --g5:#5cb7ff; --g6:#6ccb5f; --g7:#9aa7bf; --gx:#7d8798; }
.nfm.nfm-dark { --nfm-fb-card:#24262d; --nfm-fb-card2:#1b1d23; --nfm-fb-text:#e4e6ea; --nfm-fb-dim:#969da8; --nfm-fb-border:rgba(255,255,255,.14); }
.nfm *, .nfm *::before, .nfm *::after { box-sizing: border-box; }
.nfm .c-cpu { --c: var(--c-cpu); } .nfm .c-mem { --c: var(--c-mem); } .nfm .c-temp { --c: var(--c-temp); }
.nfm .c-base { --c: var(--nfm-dim); }
.nfm .nfm-line.c-base { stroke-dasharray: 5 4; stroke-width: 1.4; opacity: .75; }
.nfm .c-flash { --c: var(--c-flash); } .nfm .c-down { --c: var(--c-down); } .nfm .c-up { --c: var(--c-up); }
.nfm .g1 { --c: var(--g1); } .nfm .g2 { --c: var(--g2); } .nfm .g3 { --c: var(--g3); } .nfm .g4 { --c: var(--g4); }
.nfm .g5 { --c: var(--g5); } .nfm .g6 { --c: var(--g6); } .nfm .g7 { --c: var(--g7); } .nfm .gx { --c: var(--gx); }
.nfm .nfm-line { stroke: var(--c); } .nfm .nfm-stop { stop-color: var(--c); } .nfm .nfm-spark-a { fill: var(--c); opacity: .18; }
.nfm .nfm-ring-fg { stroke: var(--c); transition: stroke-dasharray .6s ease; } .nfm .nfm-ring-fg.warn { stroke: #f7a21b; } .nfm .nfm-ring-fg.hot { stroke: #e5484d; }
.nfm-bar-fill, .nfm-dot, .nfm-seg { background: var(--c); }

.nfm-top { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 2px 0 14px; }
.nfm-top h2 { margin: 0; padding: 0; border: 0; font-size: 20px; font-weight: 600; line-height: 1.2; }
.nfm-top .nfm-sub { color: var(--nfm-dim); font-size: 12px; margin-top: 2px; }
.nfm-top .nfm-spacer { flex: 1 1 auto; }
.nfm-pill { display: inline-flex; align-items: center; gap: 7px; padding: 4px 11px; border-radius: 999px; font-size: 12px;
  background: color-mix(in srgb, #13a10e 14%, transparent); color: var(--nfm-text); border: 1px solid color-mix(in srgb, #13a10e 30%, transparent); }
.nfm-pill::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #13a10e; animation: nfm-pulse 2s infinite; }
.nfm-rowlink { cursor: pointer; }
.nfm-rowlink:hover td, .nfm-rowlink:focus-visible td { background: color-mix(in srgb, var(--nfm-accent, #4aa3ff) 8%, transparent); }
.nfm-dc { min-width: min(420px, 80vw); }
.nfm-dc-bars { display: flex; align-items: flex-end; gap: 3px; height: 64px; }
.nfm-dc-bars i { flex: 1; min-width: 6px; border-radius: 3px 3px 0 0; background: color-mix(in srgb, var(--nfm-accent, #4aa3ff) 70%, transparent); }
.nfm-mode { display: inline-flex; align-items: center; padding: 4px 11px; border-radius: 999px; font-size: 12px; border: 1px solid color-mix(in srgb, #4aa3ff 40%, transparent); background: color-mix(in srgb, #4aa3ff 14%, transparent); color: var(--nfm-text); cursor: help; }
.nfm-mode.lite { border-color: color-mix(in srgb, #f7a21b 45%, transparent); background: color-mix(in srgb, #f7a21b 16%, transparent); }
.nfm-mode[hidden] { display: none; }
.nfm-pill.paused { background: color-mix(in srgb, #f7a21b 16%, transparent); border-color: color-mix(in srgb, #f7a21b 40%, transparent); }
.nfm-pill.paused::before { background: #f7a21b; animation: none; }
@keyframes nfm-pulse { 50% { opacity: .35; } }
.nfm-btn { font: inherit; font-size: 13px; padding: 6px 14px; border-radius: 6px; cursor: pointer; color: var(--nfm-text);
  background: var(--nfm-card); border: 1px solid var(--nfm-border); border-bottom-color: var(--nf-stroke-strong, var(--nfm-border)); }
.nfm-btn:hover { background: var(--nfm-card2); }
.nfm-ti::before { content:''; display:inline-block; width:14px; height:14px; margin-right:6px; vertical-align:-2px; background:currentColor; -webkit-mask:var(--ic) center/contain no-repeat; mask:var(--ic) center/contain no-repeat; opacity:.85; }
.nfm-ti[data-ic='overview'] { --ic: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='7' height='9' rx='1'/%3E%3Crect x='14' y='3' width='7' height='5' rx='1'/%3E%3Crect x='14' y='12' width='7' height='9' rx='1'/%3E%3Crect x='3' y='16' width='7' height='5' rx='1'/%3E%3C/svg%3E"); }
.nfm-ti[data-ic='net'] { --ic: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2 8.8a15 15 0 0 1 20 0M5 12.6a10 10 0 0 1 14 0M8.5 16.3a5 5 0 0 1 7 0'/%3E%3Ccircle cx='12' cy='19' r='1'/%3E%3C/svg%3E"); }
.nfm-ti[data-ic='procs'] { --ic: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='6' y='6' width='12' height='12' rx='2'/%3E%3Cpath d='M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4'/%3E%3C/svg%3E"); }
.nfm-ti[data-ic='svcs'] { --ic: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 2v10'/%3E%3Cpath d='M18.4 6.6a9 9 0 1 1-12.8 0'/%3E%3C/svg%3E"); }
.nfm-ti[data-ic='hist'] { --ic: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 12a9 9 0 1 0 3-6.7L3 8'/%3E%3Cpath d='M3 3v5h5M12 7v5l3 2'/%3E%3C/svg%3E"); }
.nfm-ti[data-ic='wifi'] { --ic: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a14 14 0 0 1 20 0'/%3E%3Cpath d='M12 19.5h.01'/%3E%3C/svg%3E"); }
.nfm-ti[data-ic='devs'] { --ic: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='5' width='18' height='11' rx='2'/%3E%3Cpath d='M8 20h8M12 16v4'/%3E%3C/svg%3E"); }
.nfm-ti[data-ic='apps'] { --ic: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 3v18h18'/%3E%3Cpath d='M8 16V9M13 16V5M18 16v-4'/%3E%3C/svg%3E"); }
.nfm-ti[data-ic='diag'] { --ic: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 12h4l2-6 4 12 2-6h6'/%3E%3C/svg%3E"); }
.nfm-ti[data-ic='sec'] { --ic: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 3l8 3v6c0 4.5-3.2 7.7-8 9-4.8-1.3-8-4.5-8-9V6z'/%3E%3Cpath d='M9 12l2 2 4-4'/%3E%3C/svg%3E"); }
.nfm-ti[data-ic='log'] { --ic: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01'/%3E%3C/svg%3E"); }
.nfm-ti[data-ic='tg'] { --ic: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M21.55 3.15 18.3 20.3c-.25 1.2-.95 1.5-1.95.95l-5.4-3.98-2.6 2.5c-.28.28-.52.52-1.06.52l.38-5.5 10-9.03c.44-.38-.1-.6-.68-.22L4.63 12.9l-5.2-1.63c-1.13-.35-1.15-1.13.24-1.68L20 2.1c.92-.34 1.73.22 1.55 1.05z' transform='translate(2 0) scale(.9 1)'/%3E%3C/svg%3E"); }
.nfm-hint.sec-ok { border-color: color-mix(in srgb, #2fb36a 45%, transparent); }
.nfm-hint.sec-warn { border-color: color-mix(in srgb, #f7a21b 55%, transparent); }
.nfm-hint.sec-bad { border-color: color-mix(in srgb, #ef4444 60%, transparent); background: color-mix(in srgb, #ef4444 10%, transparent); }
@media (max-width: 420px) { .nfm-ti::before { margin-right:4px; width:13px; height:13px; } }
.nfm-wq-b { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; background: color-mix(in srgb, var(--c) 18%, transparent); color: var(--c); }
.nfm-wq-b.ok { --c: #3fb950; } .nfm-wq-b.mid { --c: #e0a800; } .nfm-wq-b.bad { --c: #e5534b; }
.nfm-diag-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.nfm-diag-in { flex: 1 1 180px; min-width: 0; height: 34px; padding: 0 10px; border-radius: 10px; border: 1px solid var(--nfm-border); background: transparent; color: inherit; font: inherit; }
.nfm-diag-chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
.nfm-diag-chips .nfm-tab { font-size: 11.5px; padding: 3px 9px; }
.nfm-diag-out { margin: 0; padding: 10px 12px; border-radius: 10px; background: color-mix(in srgb, var(--nfm-border) 38%, transparent); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; }
.nfm-diag.busy .nfm-diag-out { opacity: .6; }
.nfm-mon-h { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.nfm-mon-t { text-transform: capitalize; min-width: 8em; text-align: center; }
.nfm-mon-lim { width: 72px; height: 28px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--nfm-border); background: transparent; color: inherit; text-align: center; }
.nfm-mon-sum { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin-bottom: 10px; }
.nfm-mon-sum > div { padding: 8px 10px; border-radius: 10px; background: color-mix(in srgb, var(--nfm-border) 40%, transparent); display: flex; flex-direction: column; gap: 2px; }
.nfm-mon-sum span { font-size: 11.5px; opacity: .65; } .nfm-mon-sum b { font-size: 15px; font-variant-numeric: tabular-nums; }
.nfm-mon-bar { height: 8px; border-radius: 8px; background: color-mix(in srgb, var(--nfm-border) 60%, transparent); overflow: hidden; margin: 4px 0; }
.nfm-mon-bar i { display: block; height: 100%; border-radius: 8px; background: var(--nfm-accent); transition: width .6s ease; }
.nfm-mon-bar[data-lvl="mid"] i { background: #e0a800; } .nfm-mon-bar[data-lvl="bad"] i { background: #d13438; }
.nfm-mon-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; margin-top: 8px; }
.nfm-mon-w { font-size: 11px; opacity: .6; text-align: center; }
.nfm-mon-d { min-height: 44px; border-radius: 8px; padding: 4px 5px; display: flex; flex-direction: column; justify-content: space-between; background: color-mix(in srgb, var(--nfm-border) 45%, transparent); font-size: 10.5px; overflow: hidden; }
.nfm-mon-d b { font-size: 11px; font-weight: 600; opacity: .75; } .nfm-mon-d i { font-style: normal; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nfm-mon-d.has { background: color-mix(in srgb, var(--nfm-accent) var(--hv), color-mix(in srgb, var(--nfm-border) 45%, transparent)); }
.nfm-mon-d.today { outline: 2px solid var(--nfm-accent); outline-offset: -2px; }
@media (max-width: 600px) { .nfm-mon-d { min-height: 38px; padding: 3px; font-size: 9.5px; } }
.nfm-wk { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.nfm-wk-t { display: flex; flex-direction: column; gap: 3px; padding: 12px 14px; border-radius: 10px; background: var(--nfm-card2); min-width: 0; }
.nfm-wk-t b { font-size: 20px; line-height: 1.2; overflow-wrap: anywhere; }
.nfm-wk-l { font-size: 11.5px; opacity: .7; text-transform: uppercase; letter-spacing: .04em; }
@media (max-width: 640px) { .nfm-wk { grid-template-columns: 1fr; } }
.nfm-dsk { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 10px 0; border-bottom: 1px solid var(--nfm-border); }
.nfm-dsk:last-child { border-bottom: 0; } .nfm-dsk-i { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.nfm-cmp-t { display: grid; grid-template-columns: minmax(120px, 1.2fr) 1fr 1fr 90px; gap: 0; font-size: 13px; }
.nfm-cmp-t > div { padding: 9px 10px; border-bottom: 1px solid var(--nfm-border); min-width: 0; overflow-wrap: anywhere; }
.nfm-cmp-t .h { color: var(--nfm-dim); font-size: 12px; padding-top: 2px; }
.nfm-cmp-t .h small { display: block; opacity: .8; }
.nfm-cmp-t .n { text-align: right; font-variant-numeric: tabular-nums; }
.nfm-cmp-t .sec { grid-column: 1 / -1; font-weight: 600; font-size: 12px; color: var(--nfm-dim); padding: 14px 10px 4px; border-bottom: 1px solid var(--nfm-border); text-transform: none; }
.nfm-cmp-t .sec:nth-child(4n+2), .nfm-cmp-t .sec:nth-child(4n+3), .nfm-cmp-t .sec:nth-child(4n+4) { display: none; }
.nfm-cmp-t .up { color: #d7a13b; } .nfm-cmp-t .dn { color: #4ec9a0; } .nfm-cmp-t .eq { color: var(--nfm-dim); }
.nfm-exp { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
@media (max-width: 640px) { .nfm-cmp-t { grid-template-columns: 1.2fr 1fr 1fr 64px; font-size: 12px; } .nfm-cmp-t > div { padding: 7px 4px; } }
.nfm-mon-d.has { cursor: pointer; } .nfm-mon-d.has:hover, .nfm-mon-d.has:focus-visible { outline: 2px solid var(--nfm-accent, #0a84ff); outline-offset: -2px; }
.nfm-dr .nfm-table td:first-child { max-width: 320px; }
.nfm-dv-i { display: inline-flex; vertical-align: -3px; margin-right: 6px; color: var(--nfm-dim); }
.nfm-dv-i svg { width: 16px; height: 16px; }
.nfm-dv-i.priv { color: color-mix(in srgb, var(--nfm-dim) 65%, #e0a800); }
.nfm-chip.priv { background: color-mix(in srgb, #e0a800 18%, transparent); color: #b88400; }
.nfm-wh-g { display: grid; grid-template-columns: minmax(150px, 1.8fr) repeat(var(--n, 24), minmax(0, 1fr)); gap: 3px; align-items: center; }
.nfm-wh-n { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; padding-right: 6px; }
.nfm-wh-n:hover { text-decoration: underline; }
.nfm-wh-h { font-size: 10.5px; opacity: .65; text-align: center; white-space: nowrap; overflow: visible; }
.nfm-wh-c { height: 18px; border-radius: 3px; background: color-mix(in srgb, var(--nfm-border) 70%, transparent); }
.nfm-wh-c.q0 { background: #3fb950; } .nfm-wh-c.q1 { background: #8fbf3f; } .nfm-wh-c.q2 { background: #e0a800; } .nfm-wh-c.q3 { background: #e5534b; }
.nfm-wh-leg { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 10px; font-size: 12px; color: var(--nfm-dim); }
.nfm-wh-leg i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
@media (max-width: 600px) { .nfm-wh-g { grid-template-columns: minmax(84px, 1.4fr) repeat(var(--n, 24), minmax(0, 1fr)); gap: 2px; } .nfm-wh-c { height: 16px; border-radius: 2px; } }
.nfm-air-r { margin-bottom: 16px; }
.nfm-air-r h4 { margin: 0 0 8px; font-size: 13px; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
.nfm-air-r h4 small { color: var(--nfm-dim); font-weight: 400; }
.nfm-air-bars { display: flex; align-items: flex-end; gap: 4px; height: 96px; overflow-x: auto; padding-bottom: 2px; }
.nfm-air-b { flex: 1 0 22px; max-width: 54px; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: stretch; font-size: 11px; text-align: center; position: relative; }
.nfm-air-b i { display: block; border-radius: 4px 4px 0 0; min-height: 3px; height: var(--h, 3%); background: var(--c, #3fb950); }
.nfm-air-b.l0 { --c: #3fb950; } .nfm-air-b.l1 { --c: #8fbf3f; } .nfm-air-b.l2 { --c: #e0a800; } .nfm-air-b.l3 { --c: #e5534b; }
.nfm-air-b.own i { outline: 2px solid var(--nfm-accent, #0a84ff); outline-offset: 1px; }
.nfm-air-x { display: flex; gap: 4px; margin-top: 4px; }
.nfm-air-x span { flex: 1 0 22px; max-width: 54px; text-align: center; font-size: 11px; color: var(--nfm-dim); }
.nfm-air-x span.own { color: var(--nfm-accent, #0a84ff); font-weight: 700; }
.nfm-air-x span.best { color: #3fb950; font-weight: 700; }
.nfm-air-v { margin: 10px 0 6px; font-size: 13px; line-height: 1.45; }
.nfm-air-v b { font-weight: 600; }
.nfm-heat-grid { display: grid; grid-template-columns: 26px repeat(24, 1fr); gap: 3px; align-items: center; }
.nfm-heat-h, .nfm-heat-d { font-size: 10.5px; opacity: .65; text-align: center; }
.nfm-heat-d.today { opacity: 1; font-weight: 700; }
.nfm-heat-c { aspect-ratio: 1; min-height: 10px; border-radius: 3px; background: color-mix(in srgb, var(--nfm-border) 70%, transparent); }
.nfm-heat-c[style] { background: color-mix(in srgb, var(--nfm-accent, #6aa7ff) var(--hv), color-mix(in srgb, var(--nfm-border) 70%, transparent)); }
@media (max-width: 600px) { .nfm-heat-grid { gap: 2px; grid-template-columns: 22px repeat(24, 1fr); } .nfm-heat-c { border-radius: 2px; } }
.nfm-tabs { display: inline-flex; padding: 3px; gap: 2px; border-radius: 8px; background: var(--nfm-card2); border: 1px solid var(--nfm-border); }
.nfm-tab { font: inherit; font-size: 13px; border: 0; background: transparent; color: var(--nfm-text); padding: 5px 16px; border-radius: 6px; cursor: pointer; }
.nfm-tab:hover { background: color-mix(in srgb, var(--nfm-card) 70%, transparent); }
.nfm-tab.on { background: var(--nfm-card); box-shadow: 0 1px 2px rgba(0,0,0,.14); font-weight: 600; position: relative; }
.nfm-tab.on::after { content: ''; position: absolute; left: 50%; bottom: 1px; width: 16px; height: 3px; margin-left: -8px; border-radius: 3px; background: var(--nfm-accent); }

.nfm-grid { display: grid; gap: 12px; margin-bottom: 12px; }
.nfm-g4 { grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
.nfm-g21 { grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr); }
.nfm-g3 { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
@media (max-width: 860px) { .nfm-g21 { grid-template-columns: 1fr; } }
.nfm-card { background: var(--nfm-card); border: 1px solid var(--nfm-border); border-radius: var(--nfm-r); padding: 16px 18px; min-width: 0;
  box-shadow: 0 1px 2px rgba(0,0,0,.04); }
.nfm-card { position: relative; overflow: hidden; transition: transform .25s ease, box-shadow .25s ease, border-color .25s ease; }
.nfm-card::after { content: ''; position: absolute; inset: 0 0 auto 0; height: 90px; pointer-events: none; background: linear-gradient(180deg, color-mix(in srgb, var(--nfm-accent) 9%, transparent), transparent); }
.nfm-card > * { position: relative; z-index: 1; }
.nfm-card:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--nfm-accent) 38%, var(--nfm-border)); box-shadow: 0 10px 28px -12px color-mix(in srgb, var(--nfm-accent) 45%, transparent); }
@media (hover: none), (prefers-reduced-motion: reduce) { .nfm-card:hover { transform: none; } }
.nfm-card-title { margin: 0 0 12px; padding: 0 0 0 10px; border: 0; font-size: 14px; font-weight: 600; line-height: 1.3; display: flex; align-items: center; gap: 8px; position: relative; }
.nfm-card-title::before { content: ''; position: absolute; left: 0; top: 2px; bottom: 2px; width: 3px; border-radius: 3px; background: var(--nfm-accent); }
.nfm-card-title .nfm-spacer { flex: 1; }
.nfm-card-title { flex-wrap: wrap; row-gap: 8px; }
.nfm-card-title > button, .nfm-card-title > select, .nfm-card-title > .cbi-button { flex: none; white-space: nowrap; max-width: 100%; }
.nfm-legend { display: inline-flex; flex-wrap: wrap; gap: 4px 14px; font-weight: 400; font-size: 12px; color: var(--nfm-dim); }
.nfm-leg { display: inline-flex; align-items: center; gap: 6px; }
.nfm-dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: none; }

.nfm-metric { display: flex; align-items: center; gap: 14px; padding: 14px 16px; }
.nfm-metric-info { min-width: 0; line-height: 1.35; }
.nfm-k { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--nfm-dim); }
.nfm-v { font-size: 15px; font-weight: 600; margin: 2px 0; }
.nfm-s { font-size: 12px; color: var(--nfm-dim); }
.nfm-ring { position: relative; width: 74px; height: 74px; flex: none; }
.nfm-ring svg { width: 100%; height: 100%; display: block; }
.nfm-ring-bg { stroke: var(--nfm-card2); }
.nfm-ring-label { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 600; }

.nfm-chart { --h: 220px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; grid-template-rows: var(--h) auto; column-gap: 8px; }
.nfm-chart:not(.has-right) { grid-template-columns: auto minmax(0, 1fr) 0; }
.nfm-plotw { position: relative; min-width: 0; touch-action: pan-y; cursor: crosshair; }
.nfm-plot { width: 100%; height: 100%; display: block; overflow: visible; border-left: 1px solid var(--nfm-border); border-bottom: 1px solid var(--nfm-border); }
.nfm-xh { stroke: var(--nfm-dim); stroke-width: 1; stroke-dasharray: 3 3; }
.nfm-pt { position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; background: var(--c); border: 2px solid var(--nfm-card); box-sizing: border-box; pointer-events: none; }
.nfm-tip { position: absolute; top: 6px; z-index: 5; pointer-events: none; padding: 7px 10px; border-radius: 8px; font-size: 12px; line-height: 1.5; white-space: nowrap;
  background: var(--nfm-card); color: var(--nfm-text); border: 1px solid var(--nfm-border); box-shadow: 0 6px 20px rgba(0,0,0,.22); transform: translateX(12px); }
.nfm-tip.left { transform: translateX(calc(-100% - 12px)); }
.nfm-tip-t { color: var(--nfm-dim); font-size: 11.5px; margin-bottom: 2px; }
.nfm-tip-r { display: flex; align-items: center; gap: 6px; }
.nfm-tip-r b { font-weight: 600; margin-left: auto; padding-left: 10px; font-variant-numeric: tabular-nums; }
.nfm-grid line { stroke: var(--nfm-border); stroke-dasharray: 3 4; opacity: .7; }
.nfm-yl, .nfm-yr { display: flex; flex-direction: column; justify-content: space-between; font-size: 11px; color: var(--nfm-dim); line-height: 1; padding: 0; margin-top: -5px; margin-bottom: -5px; }
.nfm-yl { text-align: right; } .nfm-yr { text-align: left; }
.nfm-xl { display: flex; justify-content: space-between; font-size: 11px; color: var(--nfm-dim); padding-top: 6px; }
.nfm-spark { width: 100%; height: 34px; display: block; margin-top: 8px; }

.nfm-core { margin-bottom: 14px; }
.nfm-core-h { display: flex; justify-content: space-between; font-size: 12.5px; margin-bottom: 6px; }
.nfm-core-h b { font-weight: 600; }
.nfm-bar { height: 7px; border-radius: 99px; background: var(--nfm-card2); overflow: hidden; }
.nfm-bar-fill { height: 100%; border-radius: 99px; width: 0; transition: width .5s ease; }
.nfm-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px; }
.nfm-tile { background: var(--nfm-card2); border-radius: 6px; padding: 8px 10px; font-size: 11.5px; color: var(--nfm-dim); }
.nfm-tile b { display: block; margin-top: 4px; font-size: 14px; color: var(--nfm-text); font-weight: 600; }

.nfm-stack { display: flex; height: 34px; border-radius: 6px; overflow: hidden; background: var(--nfm-card2); gap: 2px; }
.nfm-seg { height: 100%; min-width: 0; transition: flex-basis .5s ease; }
.nfm-seg.hatch { background: repeating-linear-gradient(135deg, var(--nfm-border) 0 4px, transparent 4px 8px); }
.nfm-seg.free { background: transparent; }
.nfm-legend-lg { margin-top: 12px; gap: 6px 18px; font-size: 12.5px; }
.nfm-note { font-size: 11.5px; color: var(--nfm-dim); margin-left: auto; font-weight: 400; }

.nfm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.nfm-table th { text-align: left; font-weight: 600; font-size: 12px; color: var(--nfm-dim); padding: 6px 10px; border-bottom: 1px solid var(--nfm-border); white-space: nowrap; }
.nfm-table th.sort { cursor: pointer; user-select: none; } .nfm-table th.sort:hover { color: var(--nfm-text); }
.nfm-table td { padding: 8px 10px; border-bottom: 1px solid color-mix(in srgb, var(--nfm-border) 60%, transparent); vertical-align: middle; }
.nfm-table tr:last-child td { border-bottom: 0; }
.nfm-table tbody tr:hover td { background: transparent; }
.nfm-tabs { max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.nfm-tabs::-webkit-scrollbar { display: none; }
.nfm-tab { white-space: nowrap; flex: none; }
@media (max-width: 640px) {
  .nfm-top .nfm-tabs { display: flex; width: 100%; order: 5; } .nfm-top .nfm-tabs .nfm-tab { flex: 1 0 auto; padding: 6px 8px; font-size: 12.5px; }
  .nfm-card-title { flex-wrap: wrap; row-gap: 8px; }
  .nfm-card-title > .nfm-spacer { flex: 0 0 100%; height: 0; margin: 0; }
  .nfm-card-title > .nfm-note-s, .nfm-card-title > .nfm-legend { flex: 1 0 100%; }
}
.nfm-cfg-layout { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; align-items:start; }
.nfm .nfm-cfg-g { border:1px solid var(--nfm-border); border-radius:var(--nfm-r); background:var(--nfm-card2); padding:0; min-width:0; overflow:hidden; align-self:start; }
.nfm .nfm-cfg-head { display:flex; align-items:center; gap:10px; min-height:52px; margin:0; padding:9px 14px; list-style:none; cursor:pointer; color:var(--nfm-text); font-size:13px; font-weight:700; background:transparent; border-bottom:1px solid transparent; }
.nfm .nfm-cfg-head::-webkit-details-marker { display:none; }
.nfm .nfm-cfg-g[open] > .nfm-cfg-head { border-bottom-color:var(--nfm-border); }
html #view .nfm-card.nfm-cfg-settings-card:focus-within { border-color:var(--nfm-border); }
.nfm-cfg-icon { display:grid; place-items:center; flex:0 0 32px; width:32px; height:32px; border-radius:10px; color:var(--blue,#1688f8); background:color-mix(in srgb,var(--blue,#1688f8) 14%,var(--nfm-card)); }
.nfm-cfg-icon svg { display:block; width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.nfm-cfg-heading { min-width:0; flex:1; }
.nfm-cfg-chevron { color:var(--nfm-dim); font-size:17px; transition:transform .18s ease; flex:none; }
.nfm-cfg-g:not([open]) .nfm-cfg-chevron { transform:rotate(-90deg); }
.nfm-cfg-body { padding:13px 14px 15px; min-width:0; }
.nfm-cfg-g .nfm-cfg { grid-template-columns:minmax(0,1fr); gap:10px; align-content:start; }
.nfm .nfm-cfg-telegram { margin-top:14px; padding:14px; }
.nfm-tg-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; align-items:start; }
.nfm .nfm-tg-grid .nfm-cfg-g { background:var(--nfm-card); }
.nfm .nfm-tg-grid .nfm-cfg-body { box-sizing:border-box; }
.nfm-cfg-i.nfm-cfg-toggle { display:flex; flex-direction:row; align-items:center; justify-content:space-between; gap:12px; min-height:38px; width:100%; min-width:0; box-sizing:border-box; color:var(--nfm-text); line-height:1.35; }
.nfm-cfg-toggle .nfm-cfg-f { display:flex; flex:0 0 44px; width:44px; min-width:44px; justify-content:flex-end; align-items:center; margin-left:auto; }
.nfm-cfg-i.nfm-cfg-toggle > .nfm-cfg-f > input.nfm-toggle[type="checkbox"] { appearance:none !important; -webkit-appearance:none !important; display:block !important; position:relative; flex:0 0 40px; width:40px !important; min-width:40px !important; max-width:40px; height:23px !important; min-height:23px; padding:0 !important; margin:0 !important; border:1px solid var(--nfm-border) !important; border-radius:99px !important; background:var(--nfm-card2) !important; box-shadow:none !important; cursor:pointer; }
.nfm-cfg-i.nfm-cfg-toggle > .nfm-cfg-f > input.nfm-toggle[type="checkbox"]::before { content:''; position:absolute; top:2px; left:2px; width:17px; height:17px; border:0; border-radius:50%; background:var(--nfm-dim); transform:none; transition:transform .18s ease,background .18s ease; }
.nfm-cfg-i.nfm-cfg-toggle > .nfm-cfg-f > input.nfm-toggle[type="checkbox"]:checked { background:var(--blue,#1688f8) !important; border-color:var(--blue,#1688f8) !important; }
.nfm-cfg-i.nfm-cfg-toggle > .nfm-cfg-f > input.nfm-toggle[type="checkbox"]:checked::before { transform:translateX(17px); background:#fff; }
.nfm-cfg-i.nfm-cfg-toggle > .nfm-cfg-f > input.nfm-toggle[type="checkbox"]:focus-visible { outline:2px solid var(--blue,#1688f8); outline-offset:2px; }
.nfm-cfg-actions { position:sticky; bottom:8px; z-index:4; display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:14px -2px 0; padding:10px; border:1px solid var(--nfm-border); border-radius:var(--nfm-r); background:var(--nfm-card); box-shadow:0 8px 24px rgba(30,70,120,.12); backdrop-filter:blur(16px); }
.nfm-cfg-actions .nfm-act { min-height:36px; white-space:normal; }
.nfm-cfg-actions .nfm-act:first-child { background:var(--blue,#1688f8); color:#fff; border-color:transparent; }
.nfm-cfg-help { margin-top:10px; color:var(--nfm-dim); font-size:12px; }
.nfm-cfg-help summary { cursor:pointer; color:var(--nfm-text); font-weight:600; padding:6px 0; }
.nfm-cfg-help > div { padding:8px 0 2px; line-height:1.55; }
@media (max-width:900px) { .nfm-cfg-layout { grid-template-columns:repeat(2,minmax(0,1fr)); } .nfm-tg-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width:680px) { .nfm-cfg-layout,.nfm-tg-grid { grid-template-columns:minmax(0,1fr); } .nfm .nfm-cfg-head { min-height:48px; padding:8px 11px; } .nfm .nfm-cfg-body { padding:11px; } .nfm-cfg-actions { position:static; } .nfm-cfg-actions .nfm-act { flex:1 1 100%; } }
.nfm-table .r { text-align: right; font-variant-numeric: tabular-nums; }
.nfm-chip { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 99px; background: var(--nfm-card2); border: 1px solid var(--nfm-border); color: var(--nfm-dim); margin-left: 6px; }
.nfm-rate { display: flex; align-items: baseline; gap: 6px; }
.nfm-rate b { font-size: 26px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; }
.nfm-rate span { color: var(--nfm-dim); font-size: 13px; }
.nfm-sel { font: inherit; font-size: 13px; padding: 4px 10px; border-radius: 6px; background: var(--nfm-card); color: var(--nfm-text); border: 1px solid var(--nfm-border); height: auto; }
.nfm-host { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; align-items: center; margin-bottom: 11px; font-size: 13px; }
.nfm-host small { color: var(--nfm-dim); font-size: 11.5px; margin-left: 6px; }
.nfm-host .nfm-bar { grid-column: 1 / -1; height: 5px; }
.nfm-empty { color: var(--nfm-dim); font-size: 13px; padding: 8px 0; }
.nfm-search { font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 6px; background: var(--nfm-card); color: var(--nfm-text); border: 1px solid var(--nfm-border); width: 200px; height: auto; }
.nfm-verdict { display: flex; align-items: center; gap: 12px; margin: 0 0 12px; padding: 12px 16px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--nfm-vd, #3ddc84) 45%, transparent); background: color-mix(in srgb, var(--nfm-vd, #3ddc84) 12%, transparent); }
.nfm-verdict.ok { --nfm-vd: #3ddc84; } .nfm-verdict.warn { --nfm-vd: #f5a623; } .nfm-verdict.bad { --nfm-vd: #ff5d5d; }
.nfm-vd { width: 12px; height: 12px; border-radius: 50%; background: var(--nfm-vd); box-shadow: 0 0 10px var(--nfm-vd); flex: none; }
.nfm-vd-t { display: flex; flex-direction: column; min-width: 0; } .nfm-vd-t b { font-size: 16px; } .nfm-vd-t small { color: var(--nfm-dim, #8d97a6); font-size: 12px; }
.nfm-linkish { margin-left: auto; background: none; border: 0; color: var(--nfm-dim, #8d97a6); cursor: pointer; font: inherit; font-size: 12px; }
.nfm-more { position: relative; } .nfm-more > summary { list-style: none; } .nfm-more > summary::-webkit-details-marker { display: none; }
.nfm-more-list { position: absolute; z-index: 20; left: 0; top: calc(100% + 6px); min-width: 240px; padding: 6px; display: flex; flex-direction: column; gap: 4px; border-radius: 10px; background: var(--nfm-card, #1b1f27); border: 1px solid var(--nfm-border, #ffffff22); box-shadow: 0 10px 30px #0006; }
.nfm-more-list .nfm-act { width: 100%; justify-content: flex-start; }
.nfm-netline { display: flex; flex-wrap: wrap; gap: 10px 28px; align-items: center; }
.nfm-netline > div { display: flex; flex-direction: column; } .nfm-netline small { color: var(--nfm-dim, #8d97a6); font-size: 12px; } .nfm-netline b { font-size: 20px; font-weight: 600; } .nfm-u { font-size: 13px; font-weight: 400; color: var(--nfm-dim, #8d97a6); }
.nfm-netgo { margin-left: auto; }
.nfm-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
.nfm-act { display: inline-flex; align-items: center; gap: 8px; font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 6px; cursor: pointer; color: var(--nfm-text);
  background: var(--nfm-card); border: 1px solid var(--nfm-border); border-bottom-color: var(--nf-stroke-strong, var(--nfm-border)); }
.nfm-act:hover { background: var(--nfm-card2); }
.nfm-act svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.nfm-act.danger { color: var(--error-color-high, #c42b1c); }
.nfm-sig { display: inline-flex; align-items: flex-end; gap: 2px; height: 14px; vertical-align: middle; margin-right: 8px; }
.nfm-sig i { width: 3px; border-radius: 1px; background: var(--nfm-border); }
.nfm-sig i:nth-child(1) { height: 4px; } .nfm-sig i:nth-child(2) { height: 7px; } .nfm-sig i:nth-child(3) { height: 10px; } .nfm-sig i:nth-child(4) { height: 14px; }
.nfm-sig i.on { background: var(--c-up); }
.nfm-sig.weak i.on { background: #e8a30a; }
.nfm-note-s { color: var(--nfm-dim); font-size: 12px; }
.nfm [hidden] { display: none !important; }
.nfm-alerts { display: grid; gap: 8px; margin: 0 0 12px; }
.nfm-alert { padding: 10px 14px; border-radius: var(--nfm-r); font-size: 13px; line-height: 1.4;
  border: 1px solid color-mix(in srgb, #f7a21b 45%, transparent); background: color-mix(in srgb, #f7a21b 13%, var(--nfm-card)); }
.nfm-alert.crit { border-color: color-mix(in srgb, #e5484d 50%, transparent); background: color-mix(in srgb, #e5484d 13%, var(--nfm-card)); }
.nfm-alert b { font-weight: 600; } .nfm-alert small { display: block; color: var(--nfm-dim); font-size: 12px; }
.nfm-hint { padding: 9px 14px; border-radius: 6px; background: var(--nfm-card2); border: 1px solid var(--nfm-border); color: var(--nfm-dim); font-size: 12.5px; margin: 0 0 12px; line-height: 1.45; }
.nfm-hint code { font-size: 12px; }
.nfm-bar-sm { height: 4px; margin-top: 6px; }
.nfm-evlist { max-height: 360px; overflow: auto; }
.nfm-ev-i { display: grid; grid-template-columns: 8px 118px minmax(0, 1fr); gap: 10px; align-items: baseline; padding: 7px 0; font-size: 13px;
  border-bottom: 1px solid color-mix(in srgb, var(--nfm-border) 60%, transparent); }
.nfm-pin { border: 0; background: none; cursor: pointer; color: var(--nfm-dim); font-size: 14px; padding: 0 6px; }
.nfm-pin.on { color: #f7a21b; }
.nfm-ev-i.nt { grid-template-columns: 8px minmax(0, 1fr); }
.nfm-ev-i:last-child { border-bottom: 0; }
.nfm-ev-i i { width: 8px; height: 8px; border-radius: 50%; background: var(--nfm-dim); }
.nfm-ev-i.warn i { background: #f7a21b; } .nfm-ev-i.crit i { background: #e5484d; } .nfm-ev-i.ok i { background: #13a10e; }
.nfm-ev-i time { color: var(--nfm-dim); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nfm-rlog { max-height: min(620px, 68vh); padding: 2px 4px 4px 2px; }
.nfm-rlog-item { border-bottom: 1px solid color-mix(in srgb, var(--nfm-border) 58%, transparent); }
.nfm-rlog-item:last-child { border-bottom: 0; }
.nfm-rlog-item > summary { list-style: none; cursor: pointer; border: 0; border-radius: 6px; padding: 8px 8px; }
.nfm-rlog-item > summary::-webkit-details-marker { display: none; }
.nfm-rlog-item > summary::marker { content: ''; }
.nfm-rlog-item > summary:hover { background: color-mix(in srgb, var(--nfm-card2) 74%, transparent); }
.nfm-rlog .nfm-ev-i { grid-template-columns: 8px 118px minmax(0, 1fr); align-items: center; gap: 10px; }
.nfm-rlog .nfm-ev-i.crit { background: color-mix(in srgb, #e5484d 13%, var(--nfm-card)); box-shadow: inset 2px 0 #e5484d; }
.nfm-rlog .nfm-ev-i.warn { background: color-mix(in srgb, #e8a30a 9%, var(--nfm-card)); box-shadow: inset 2px 0 color-mix(in srgb, #e8a30a 72%, transparent); }
.nfm-rlog .nfm-ev-i.notice { background: color-mix(in srgb, #4b9bea 5%, transparent); }
.nfm-log-line { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.nfm-log-service { flex: 0 0 auto; font-weight: 650; color: var(--nfm-text); }
.nfm-log-level { flex: 0 0 auto; display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 7px; font-size: 10px; line-height: 1.35; font-weight: 750; letter-spacing: .035em; color: var(--nfm-dim); background: color-mix(in srgb, var(--nfm-dim) 12%, transparent); }
.nfm-log-level.crit { color: #ff777b; background: color-mix(in srgb, #e5484d 18%, transparent); }
.nfm-log-level.warn { color: #ffc44d; background: color-mix(in srgb, #e8a30a 18%, transparent); }
.nfm-log-level.notice, .nfm-log-level.info { color: #72baff; background: color-mix(in srgb, #398be5 16%, transparent); }
.nfm-log-level.debug { color: var(--nfm-dim); background: color-mix(in srgb, var(--nfm-dim) 10%, transparent); }
.nfm-log-text { min-width: 0; overflow-wrap: anywhere; }
.nfm-log-summary, .nfm-log-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin: 8px 0; }
.nfm-log-summary { color: var(--nfm-dim); font-size: 11px; }
.nfm-log-diagnostics { margin:10px 0 12px; padding:10px; border:1px solid var(--nfm-border); border-radius:9px; background:color-mix(in srgb,var(--nfm-card2) 55%,transparent); }
.nfm-log-diagnostics-head { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px 12px; margin-bottom:8px; font-size:12px; }
.nfm-log-diagnostics-head span, .nfm-log-diagnostic small { color:var(--nfm-dim); font-size:11px; font-weight:400; }
.nfm-log-diagnostic-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:7px; }
.nfm-log-diagnostic { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:3px 8px; align-items:center; padding:8px 10px; border:1px solid var(--nfm-border); border-radius:7px; text-align:left; color:var(--nfm-text); background:var(--nfm-card); cursor:pointer; }
.nfm-log-diagnostic:hover, .nfm-log-diagnostic.on { border-color:var(--nfm-accent); background:var(--nfm-card2); }
.nfm-log-diagnostic b { font-size:13px; font-variant-numeric:tabular-nums; }
.nfm-log-diagnostic small { grid-column:1/-1; }
.nfm-log-diagnostic.crit b { color:#ff777b; } .nfm-log-diagnostic.warn b { color:#ffc44d; }
.nfm-log-diagnostics-empty { color:var(--nfm-dim); font-size:11px; }
.nfm-log-repeat { flex:0 0 auto; padding:2px 7px; border:1px solid var(--nfm-border); border-radius:999px; color:var(--nfm-text); background:var(--nfm-card2); font-size:10px; font-weight:700; }
.nfm-log-occurrences { display:grid; gap:5px; margin:0 0 8px; }
.nfm-log-occurrences > div { display:grid; grid-template-columns:150px 110px minmax(0,1fr); gap:8px; padding:5px 7px; border-radius:5px; background:color-mix(in srgb,var(--nfm-card) 75%,transparent); font-size:11px; }
.nfm-log-occurrences time, .nfm-log-occurrences > div > span:nth-child(2) { color:var(--nfm-dim); }
@media (max-width:720px) { .nfm-log-occurrences > div { grid-template-columns:1fr; gap:2px; } .nfm-log-diagnostic-list { grid-template-columns:1fr 1fr; } }
@media (max-width:420px) { .nfm-log-diagnostic-list { grid-template-columns:1fr; } }

.nfm-log-count { display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; border: 1px solid var(--nfm-border); border-radius: 999px; background: var(--nfm-card2); }
.nfm-log-count b { color: var(--nfm-text); font-variant-numeric: tabular-nums; }
.nfm-log-count.crit b { color: #ff777b; } .nfm-log-count.warn b { color: #ffc44d; } .nfm-log-count.info b { color: #72baff; }
.nfm-log-tab-count { display: inline-block; min-width: 18px; margin-left: 5px; padding: 1px 5px; border-radius: 999px; background: color-mix(in srgb, var(--nfm-dim) 14%, transparent); font-size: 10px; font-variant-numeric: tabular-nums; }
.nfm-log-tools { margin: 8px 0 10px; }
.nfm-log-tools .nfm-btn { min-height: 30px; }
.nfm-log-status { margin-left: auto; color: var(--nfm-dim); font-size: 11px; }
.nfm-log-detail { margin: 0 8px 9px 136px; padding: 10px 12px; border: 1px solid var(--nfm-border); border-radius: 7px; background: var(--nfm-card2); }
.nfm-log-detail-head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.nfm-log-detail-meta { display: flex; flex-wrap: wrap; gap: 8px 16px; color: var(--nfm-dim); font-size: 11px; }
.nfm-log-detail-meta b { color: var(--nfm-text); font-weight: 600; }
.nfm-log-full { margin: 0; padding: 8px 10px; border-radius: 5px; background: color-mix(in srgb, var(--nfm-card) 85%, transparent); color: var(--nfm-text); font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.nfm-log-more { display: flex; justify-content: center; padding: 8px 0 2px; }
@media (max-width: 720px) {
  .nfm-rlog .nfm-ev-i { grid-template-columns: 7px 88px minmax(0, 1fr); gap: 6px; padding: 8px 5px; }
  .nfm-rlog .nfm-ev-i time { font-size: 10px; }
  .nfm-log-detail { margin-left: 8px; }
  .nfm-log-status { width: 100%; margin-left: 0; }
}
.nfm-tiles.t4 { grid-template-columns: 1fr 1fr; }
.nfm-cfg { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px 18px; }
.nfm-cfg-i { display: flex; flex-direction: column; gap: 4px; min-width:0; font-size: 12.5px; color: var(--nfm-dim); }
.nfm-cfg-f { display: flex; align-items: center; gap: 8px; width:100%; min-width:0; }
.nfm-cfg-f > .nfm-in { flex:1 1 0; min-width:0; box-sizing:border-box; }
.nfm-cfg-f em { font-style: normal; min-width: 22px; }
.nfm-in { font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 6px; background: var(--nfm-card); color: var(--nfm-text); border: 1px solid var(--nfm-border); width: 100%; height: auto; }
.nfm-diag { width: 100%; height: 320px; font: 12px/1.45 ui-monospace, Consolas, monospace; padding: 10px; border-radius: 6px; background: var(--nfm-card2); color: var(--nfm-text); border: 1px solid var(--nfm-border); resize: vertical; }
`;

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load() {
		return Promise.all([
			L.resolveDefault(callBoard(), {}),
			L.resolveDefault(callIfaces(), { interface: [] }),
			L.resolveDefault(callHints(), {})
		]);
	},

	render(data) {
		const board = data[0] || {}, ifdump = (data[1] || {}).interface || [], hints = data[2] || {};

		/* Names are filled only after the DHCP-backed identity resolver is available. */
		const names = {}, routerNameIps = new Set();
		/* собственные адреса роутера (LAN и WAN) подписываем «Роутер» */
		/* адреса самого роутера: текущие, прежние внешние (провайдер их меняет) и вся внешняя подсеть. Их трафик повторяет трафик устройств (VPN, прокси)
		   или служебный, поэтому в «устройства» не входит */
		const routerIps = (() => {
			const ips = new Set(), nets = [];
			const n = ip => { const a = String(ip).split('.'); return a.length === 4 && a.every(x => /^\d+$/.test(x)) ? ((+a[0] * 256 + +a[1]) * 256 + +a[2]) * 256 + +a[3] : -1; };
			return {
				add: ip => ips.add(ip),
				has: ip => { if (ips.has(ip)) return true; const x = n(ip); return x >= 0 && nets.some(([ b, sz ]) => x >= b && x < b + sz); },
				learn: info => {
					if (!info) return;
					String(info.router_ips || '').split(/\s+/).filter(Boolean).forEach(ip => ips.add(ip));
					String(info.router_nets || '').split(/\s+/).filter(Boolean).forEach(c => { const [ ip, bits ] = c.split('/'), b = n(ip), sz = Math.pow(2, 32 - (+bits || 32)); if (b >= 0 && !nets.some(x => x[0] === b - b % sz)) nets.push([ b - b % sz, sz ]); });
				}
			};
		})();
		for (const i of ifdump) for (const a of (i['ipv4-address'] || [])) if (a.address) { routerIps.add(a.address); routerNameIps.add(a.address); names[a.address] = _('Роутер'); }

		/* device -> logical interface, default-route device */
		const devRole = {};
		let wanDev = null, lanDev = 'br-lan';
		for (const i of ifdump) {
			const dev = i.l3_device || i.device;
			if (!dev || i.interface === 'loopback') continue;
			devRole[dev] = i.interface;
			if (i.interface === 'lan') lanDev = dev;
			if (!wanDev && i.up && (i.route || []).some(r => r.target === '0.0.0.0' || r.target === '::'))
				wanDev = dev;
		}

		const S = {
			times: [], cpu: [], mem: [], temp: [], cores: [], net: {},
			prev: null, last: null, full: null, wifi: undefined, prevProcs: null, procRate: {},
			paused: false, rlAuto: true, rlLimit: 300, rlExpanded: {}, tick: 0, iface: null, tab: 'overview', sort: 'mem', filter: '',
				at: {}, alerts: undefined, devs: undefined, devDay: 'day', hist: undefined, range: 'h', appTraffic: undefined, appPeriod: 'day', appDevice: ''
		};

		function refreshIdentityNames() {
			for (const ip of Object.keys(names)) if (!routerNameIps.has(ip)) delete names[ip];
			const dv = S.devs || {};
			/* Older monitor backends do not expose DHCP leases. Do not rebuild
			 * IP labels from host hints alone: they may carry proxy-neighbour aliases. */
			if (!Array.isArray(dv.leases)) return;
			const dhcp = monitorBuildDhcpIdentity(dv.leases);
			const ipMac = monitorBuildIpMacMap(hints, dv.neigh || [], S.wifi, dv.leases);
			for (const ip of Object.keys(ipMac)) {
				const mac = ipMac[ip], h = hints[mac] || hints[String(mac).toLowerCase()] || {};
				const name = dhcp.ipName[ip] || h.name || '';
				if (name) names[ip] = String(name).trim();
			}
		}

		try {
			const saved = JSON.parse(window.sessionStorage.getItem(STORE_KEY) || 'null');
			if (saved && Array.isArray(saved.times)) {
				const cut = Date.now() / 1000 - WINDOW;
				const keep = saved.times.map((t, i) => t >= cut ? i : -1).filter(i => i >= 0);
				S.times = keep.map(i => saved.times[i]);
				for (const k of [ 'cpu', 'mem', 'temp' ]) S[k] = keep.map(i => saved[k][i]);
				for (const n in saved.net)
					S.net[n] = { rx: keep.map(i => saved.net[n].rx[i]), tx: keep.map(i => saved.net[n].tx[i]) };
			}
		} catch (e) {}

		/* ---------- build DOM ---------- */
		const rCpu = ring('c-cpu'), rTemp = ring('c-temp'), rMem = ring('c-mem'), rNet = ring('c-down');
		const flashFill = E('i'), flashPct = E('b', {}, '–');
		const rFlash = {
			el: E('div', { class: 'nfm-flash-meter' }, E('div', { class: 'nfm-flash-track' }, flashFill)),
			set(pct, text) {
				const p = Math.max(0, Math.min(100, Number(pct) || 0));
				flashFill.style.width = p + '%';
				flashFill.className = p >= 90 ? 'hot' : p >= 75 ? 'warn' : '';
				flashPct.textContent = text || '–';
			}
		};
		const T = {};  /* text refs */
		const t = (key, cls) => (T[key] = E('span', { class: cls || '' }, '–'));

		const metric = (r, k, ...lines) => E('section', { class: 'nfm-card nfm-metric' }, [
			r.el, E('div', { class: 'nfm-metric-info' }, [ E('div', { class: 'nfm-k' }, k) ].concat(lines)) ]);

		const hotBox = E('div', { class: 'alert-message warning', hidden: '', style: 'margin-bottom:12px' }, [ E('h4', {}, _('Процессор перегрет')), E('p') ]);
		const alertsBox = E('div', { class: 'nfm-alerts', hidden: '' });

		const act = (cls, path, label, fn) => {
			const icon = SVG('svg', { viewBox: '0 0 24 24' });
			icon.innerHTML = path;
			return E('button', { class: 'nfm-act ' + cls, click: fn }, [ icon, label ]);
		};

		const actBtns = [
			act('', '<path d="M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0"/><circle cx="12" cy="20" r=".8"/>', _('Перезапустить Wi-Fi'), () => confirmRun(
				_('Перезапустить Wi-Fi?'), _('Беспроводные клиенты ненадолго отключатся.'), () => fs.exec('/sbin/wifi', [ 'reload' ]), _('Wi-Fi перезапускается…'))),
			act('', '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>', _('Перезапустить сеть'), () => confirmRun(
				_('Перезапустить сеть?'), _('Все соединения, включая эту страницу, на время прервутся.'), () => fs.exec('/etc/init.d/network', [ 'restart' ]), _('Сеть перезапускается…'))),
			act('', '<path d="M12 3v8"/><path d="M6.5 6.5a8 8 0 1 0 11 0"/>', _('Разбудить устройство'), () => wakeDialog()),
			act('', '<path d="M9 4h6v3H9z"/><path d="M7 5.5H5.5v14h13v-14H17"/><path d="M9 12h6M9 15.5h4"/>', _('Скопировать диагностику'), () => copyDiag()),
			act('danger', '<path d="M12 3v9"/><path d="M7 7a7.5 7.5 0 1 0 10 0"/>', _('Перезагрузить роутер'), () => confirmRun(
				_('Перезагрузить роутер?'), _('Роутер будет недоступен около минуты.'), () => callReboot(), _('Роутер перезагружается… страница обновится сама.'), true))
		];
		const actions = E('div', { class: 'nfm-actions', style: 'margin-top:12px' }, [ actBtns[0], actBtns[1],
			E('details', { class: 'nfm-more' }, [ E('summary', { class: 'nfm-act', title: _('Ещё: разбудить устройство, скопировать диагностику, перезагрузить роутер') }, '⋯'),
				E('div', { class: 'nfm-more-list' }, actBtns.slice(2)) ]) ]);
		document.addEventListener('click', ev => { const d = actions.querySelector('details'); if (d && d.open && !d.contains(ev.target)) d.open = false; });

		/* ---- строка-вывод «Обзора»: одно слово вместо россыпи предупреждений ---- */
		const vdTitle = E('b', {}, _('Загружаю…')), vdSub = E('small', {}), vdMore = E('button', { type: 'button', class: 'nfm-linkish', hidden: '' }, _('Подробности ▾'));
		const verdictBox = E('div', { class: 'nfm-verdict' }, [ E('i', { class: 'nfm-vd' }), E('div', { class: 'nfm-vd-t' }, [ vdTitle, vdSub ]), vdMore ]);
		const detailsWrap = E('div', { hidden: '' }, [ alertsBox, hotBox ]);
		vdMore.addEventListener('click', () => { const on = detailsWrap.hasAttribute('hidden'); detailsWrap.toggleAttribute('hidden', !on); vdMore.textContent = on ? _('Скрыть ▴') : _('Подробности ▾'); });
		function updVerdict() {
			const hot = !hotBox.hasAttribute('hidden'), al = alertsBox.hasAttribute('hidden') ? [] : Array.from(alertsBox.children);
			const crit = hot || al.some(x => x.classList.contains('crit'));
			const n = al.length + (hot ? 1 : 0);
			verdictBox.className = 'nfm-verdict ' + (crit ? 'bad' : n ? 'warn' : 'ok');
			vdTitle.textContent = crit ? _('Требует внимания') : n ? _('Есть замечания') : _('Всё в порядке');
			const tm = S.temps && S.temps.main != null ? _('температура ') + nf0.format(S.temps.main) + ' °C' : '', net = (T.wanMini && T.wanMini.textContent) || '';
			vdSub.textContent = n ? (hot ? _('Процессор перегрет') : (al[0].querySelector('b') || {}).textContent || '') + (n > 1 ? _(' · и ещё ') + (n - 1) : '') : [ tm, net && net !== '–' ? _('интернет: ') + net : '' ].filter(Boolean).join(' · ');
			vdMore.toggleAttribute('hidden', !n);
			if (!n) { detailsWrap.setAttribute('hidden', ''); vdMore.textContent = _('Подробности ▾'); }
		}


		const cardsRow = E('div', { class: 'nfm-grid nfm-g4' }, [
			metric(rCpu, _('Процессор'), E('div', { class: 'nfm-v' }, [ t('cpuCores') ]), E('div', { class: 'nfm-s' }, [ t('cpuLoad') ])),
			metric(rTemp, _('Температура'), E('div', { class: 'nfm-v' }, [ t('tempMain') ]), E('div', { class: 'nfm-s' }, [ t('tempSub') ])),
			metric(rMem, _('Память'), E('div', { class: 'nfm-v' }, [ t('memMain') ]), E('div', { class: 'nfm-s' }, [ t('memSub') ])),
			metric(rNet, _('Интернет'), E('div', { class: 'nfm-v' }, [ t('netMain') ]), E('div', { class: 'nfm-s' }, [ t('netSub') ]))
		]);
		const flashCard = E('section', { class: 'nfm-card nfm-flash-card' }, [
			E('div', { class: 'nfm-flash-head' }, [
				E('div', { class: 'nfm-flash-heading' }, [
					E('span', { class: 'nfm-flash-icon' }, SVG('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
						SVG('ellipse', { cx: 12, cy: 5, rx: 8, ry: 3, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 }),
						SVG('path', { d: 'M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 })
					])),
					E('div', {}, [
						E('div', { class: 'nfm-flash-title' }, _('Флеш-память')),
						E('span', { class: 'nfm-flash-caption' }, _('Накопитель роутера'))
					])
				]),
				E('span', { class: 'nfm-flash-percent' }, flashPct)
			]),
			E('div', { class: 'nfm-flash-values' }, [
				E('div', { class: 'nfm-flash-primary' }, [ t('flashMain') ]),
				E('div', { class: 'nfm-flash-secondary' }, [ t('flashSub') ])
			]),
			rFlash.el,
			E('div', { class: 'nfm-flash-stats' }, [
				E('div', { class: 'nfm-flash-stat' }, [
					E('span', {}, _('Всего')),
					E('b', {}, [ t('flashTotal') ])
				]),
				E('div', { class: 'nfm-flash-stat' }, [
					E('span', {}, _('Свободно')),
					E('b', {}, [ t('flashFree') ])
				])
			])
		]);

		const mainChart = chart({
			right: true,
			series: [ { key: 'cpu', cls: 'c-cpu', label: _('Процессор'), fmt: v => nf0.format(v) + '%' }, { key: 'mem', cls: 'c-mem', label: _('Память'), fmt: v => nf0.format(v) + '%' },
				{ key: 'temp', cls: 'c-temp', axis: 'right', fill: .12, label: _('Температура'), fmt: v => nf1.format(v) + ' °C' } ],
			fmtLeft: v => nf0.format(v) + '%', fmtRight: v => nf0.format(v) + '°'
		});

		const coresBox = E('div');
		const coreRefs = [];
		const tileRefs = {};
		const tiles = E('div', { class: 'nfm-tiles' }, [ [ 'apps', _('программы') ], [ 'sys', _('система') ], [ 'irq', _('прерывания') ], [ 'io', _('ожидание диска') ] ]
			.map(([ k, l ]) => E('div', { class: 'nfm-tile' }, [ l, tileRefs[k] = E('b', {}, '–') ])));

		const sparkDown = sparkline('c-down'), sparkUp = sparkline('c-up');
		const netMini = chart({
			height: 196,
			series: [ { key: 'rx', cls: 'c-down', label: _('Загрузка'), fmt: rateText }, { key: 'tx', cls: 'c-up', fill: .18, label: _('Отдача'), fmt: rateText } ],
			fmtLeft: v => rateText(v), fmtRight: () => ''
		});

		const memStack = E('div', { class: 'nfm-stack' });
		const memLegend = E('div', { class: 'nfm-legend nfm-legend-lg' });

		const top3Box = E('div');
		const netLine = E('div', { class: 'nfm-netline' }, [
			E('div', {}, [ E('small', {}, _('Загрузка')), E('b', {}, [ T.dlN = E('span', {}, '–'), ' ', T.dlU = E('span', { class: 'nfm-u' }, '') ]) ]),
			E('div', {}, [ E('small', {}, _('Отдача')), E('b', {}, [ T.ulN = E('span', {}, '–'), ' ', T.ulU = E('span', { class: 'nfm-u' }, '') ]) ]),
			E('div', {}, [ E('small', {}, _('Соединений')), E('b', {}, [ t('ctMini') ]) ]),
			E('div', {}, [ E('small', {}, _('Wi-Fi клиентов')), E('b', {}, [ t('wifiMini') ]) ]),
			E('div', {}, [ E('small', {}, _('Интернет')), E('b', {}, [ t('wanMini') ]) ]),
			E('button', { type: 'button', class: 'nfm-btn nfm-netgo', click: () => { S.tab = 'net'; refresh(); } }, _('Подробнее во вкладке «Сеть» →')) ]);
		T.netIface = E('span');

		const overview = E('div', {}, [
			verdictBox, detailsWrap, cardsRow,
			E('div', { class: 'nfm-grid nfm-g21' }, [
				card([ _('Последние 5 минут'), E('span', { class: 'nfm-spacer' }),
					E('span', { class: 'nfm-legend' }, [ legendDot('c-cpu', _('Процессор')), legendDot('c-mem', _('Память')), legendDot('c-temp', _('Температура, °C')) ]) ], mainChart.el),
				card(_('Сейчас больше всех'), top3Box)
			]),
			card(_('Сеть сейчас'), netLine),
			actions
		]);

		/* network tab */
		const netSel = E('select', { class: 'nfm-sel', change: ev => { S.iface = ev.target.value; refresh(); } });
		const netBig = chart({ height: 260, series: [ { key: 'rx', cls: 'c-down', label: _('Загрузка'), fmt: rateText }, { key: 'tx', cls: 'c-up', fill: .18, label: _('Отдача'), fmt: rateText } ],
			fmtLeft: v => rateText(v), fmtRight: () => '' });
		const ifBody = E('tbody');
		const wifiBody = E('tbody');
		const hostsBox = E('div');
		const devBody = E('tbody');
		const devNote = E('div', { class: 'nfm-hint', hidden: '' });
		const devSel = E('select', { class: 'nfm-sel', change: ev => { S.devDay = ev.target.value; refresh(); } },
			[ E('option', { value: 'day' }, _('Сегодня')), E('option', { value: 'yday' }, _('Вчера')) ]);
		const dnsBox = E('div', { class: 'nfm-two' }), ipBox = E('div');
		function renderExtIp() {
			const R = S.extip;
			if (!R || !R.rows) { ipBox.replaceChildren(E('div', { class: 'nfm-empty' }, R === null ? _('Нет данных: обновите тему на роутере.') : _('Загружаю…'))); return; }
			const rows = R.rows.slice().reverse();
			if (!rows.length) { ipBox.replaceChildren(E('div', { class: 'nfm-empty' }, _('Адрес WAN появится после ближайшего шага сборщика (раз в 5 минут).'))); return; }
			const cur = rows[0], nat = !!cur[2];
			ipBox.replaceChildren(
				E('div', { class: 'nfm-hint sec-' + (nat ? 'warn' : 'ok') }, nat ? _('Адрес на WAN ') + cur[1] + _(' из диапазона провайдерского NAT (CGNAT или двойной NAT): входящие соединения из интернета и проброс портов, скорее всего, не заработают. Выход: запросить у провайдера «белый» IP.') : _('Адрес на WAN ') + cur[1] + _(' не похож на NAT провайдера: проброс портов и входящие соединения возможны.')),
				E('div', { class: 'nfm-k', style: 'margin:10px 0 6px' }, _('Смены адреса (') + rows.length + ')'),
				E('div', { class: 'nfm-evlist' }, rows.slice(0, 10).map(x => E('div', { class: 'nfm-ev-i' }, [ E('i'), E('time', {}, fmtTs(x[0])), E('span', {}, x[1] + (x[2] ? _(' · за NAT') : '')) ]))));
		}
		const chanSel = E('select', { class: 'nfm-sel', change: ev => { S.chanDev = ev.target.value; renderChannel(); } });
		const chanBox = E('div', { class: 'nfm-two' });
		const chanNote = E('div', { class: 'nfm-note-s', style: 'margin:-4px 0 10px' }, _('Скорость за последние секунды по данным conntrack: по службам (портам) и по адресам в интернете.'));
		/* ---- диагностика: ping / маршрут / DNS прямо из браузера ---- */
		const DIAG = '/usr/libexec/nightfall-diag';
		const diagOut = E('pre', { class: 'nfm-diag-out' }, _('Выберите узел и нажмите кнопку.'));
		const diagHost = E('input', { type: 'text', class: 'nfm-diag-in', value: '1.1.1.1', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': _('Адрес узла') });
		let diagBusy = false;
		const DNAME = { ping: _('Пинг'), trace: _('Маршрут'), route: _('Потери по маршруту'), dns: 'DNS', check: _('Проверка всего'), bloat: _('Задержка под нагрузкой') };
		const diagHistBox = E('div', { class: 'nfm-evlist' });
		const diagLoad = () => { try { return JSON.parse(window.localStorage.getItem('nfm_diag') || '[]'); } catch (e) { return []; } };
		function diagSave(cmd, host, out) {
			if (/Выйдите из LuCI|Некорректный/.test(out)) return;
			try { const l = diagLoad(); l.unshift({ t: Math.floor(Date.now() / 1000), cmd, host, out: String(out).slice(0, 2000) }); window.localStorage.setItem('nfm_diag', JSON.stringify(l.slice(0, 15))); } catch (e) { /* без истории */ }
			renderDiagHist();
		}
		function renderDiagHist() {
			const l = diagLoad();
			diagHistBox.replaceChildren(...(l.length ? l.map(x => E('div', { class: 'nfm-ev-i ' + (/❌|сильный/.test(x.out) ? 'crit' : /заметно/.test(x.out) ? 'warn' : 'info'), style: 'cursor:pointer', title: _('Показать результат'), click: () => { diagOut.textContent = x.out; } }, [ E('i'), E('time', {}, fmtTs(x.t)), E('span', {}, DNAME[x.cmd] + (x.host ? ' · ' + x.host : '') + ' — ' + (x.out.split('\n').find(z => /[✅❌]|Вывод/.test(z)) || x.out.split('\n')[0]).slice(0, 90)) ])) : [ E('div', { class: 'nfm-empty' }, _('Здесь появятся результаты ваших проверок (хранятся в этом браузере).')) ]));
		}
		function runDiag(cmd) {
			const h = (cmd === 'check' || cmd === 'bloat') ? cmd : diagHost.value.trim();
			if (!/^[A-Za-z0-9._:-]{1,253}$/.test(h) || h[0] === '-') { diagOut.textContent = _('Введите адрес или имя узла: буквы, цифры, точка, дефис.'); return; }
			if (diagBusy) return;
			diagBusy = true; diagBox.classList.add('busy');
			diagOut.textContent = ({ ping: _('Пинг ') + h + '…', trace: _('Маршрут до ') + h + _(' (до 30 секунд)…'), route: _('Измеряю потери по маршруту до ') + h + _(' (до 25 секунд)…'), bloat: _('Измеряю задержку без нагрузки и под нагрузкой (около 20 секунд)…'), dns: _('Запрос DNS ') + h + '…', check: _('Проверяю шлюз, интернет и DNS (до 20 секунд)…') })[cmd];
			fs.exec(DIAG, (cmd === 'check' || cmd === 'bloat') ? [ cmd ] : [ cmd, h ]).then(r => { diagOut.textContent = ((r.stdout || '') + (r.stderr || '')).trim() || _('Нет ответа.'); diagSave(cmd, (cmd === 'check' || cmd === 'bloat') ? '' : h, diagOut.textContent); })
				.catch(e => { const m = String((e && e.message) || e || ''); diagOut.textContent = _('Не удалось выполнить') + (m ? ' (' + m.slice(0, 120) + ')' : '') + '. ' + (/denied|permission|access/i.test(m) ? _('Выйдите из LuCI и войдите снова (нужны новые права).') : _('Скорее всего, команда не уложилась в лимит времени ответа роутера; попробуйте узел поближе.')); })
				.then(() => { diagBusy = false; diagBox.classList.remove('busy'); });
		}
		const diagBox = E('div', { class: 'nfm-diag' }, [
			E('div', { class: 'nfm-diag-row' }, [ diagHost,
				E('button', { type: 'button', class: 'nfm-tab on', click: () => runDiag('ping') }, _('Пинг')),
				E('button', { type: 'button', class: 'nfm-tab', click: () => runDiag('trace') }, _('Маршрут')),
				E('button', { type: 'button', class: 'nfm-tab', title: _('Потери и задержка на каждом узле маршрута'), click: () => runDiag('route') }, _('Потери по маршруту')),
				E('button', { type: 'button', class: 'nfm-tab', click: () => runDiag('dns') }, 'DNS') ]),
			E('div', { class: 'nfm-diag-row' }, [ E('button', { type: 'button', class: 'nfm-btn', click: () => runDiag('check') }, _('Проверить всё: шлюз, интернет, DNS')), E('span', { class: 'nfm-note-s' }, _('пинг до шлюза и 1.1.1.1, разрешение имён через DNS роутера')) ]),
			E('div', { class: 'nfm-diag-row' }, [ E('button', { type: 'button', class: 'nfm-btn', click: () => runDiag('bloat') }, _('Тест задержки под нагрузкой')), E('span', { class: 'nfm-note-s' }, _('bufferbloat: на время теста канал загружается скачиванием (нужен curl)')) ]),
			E('div', { class: 'nfm-diag-chips' }, [ '1.1.1.1', '8.8.8.8', '77.88.8.8', 'ya.ru', 'google.com' ].map(h =>
				E('button', { type: 'button', class: 'nfm-tab', click: () => { diagHost.value = h; } }, h))),
			diagOut ]);
		const diagBody = diagBox;
		renderDiagHist();
		diagHost.addEventListener('keydown', ev => { if (ev.key === 'Enter') runDiag('ping'); });

		const net = E('div', { hidden: true }, [
			E('div', { class: 'nfm-grid nfm-g3' }, [
				card(_('Загрузка'), E('div', {}, [ E('div', { class: 'nfm-rate' }, [ T.nDlN = E('b', {}, '–'), T.nDlU = E('span') ]),
					E('div', { class: 'nfm-s' }, [ _('всего принято '), t('nDlTot') ]) ])),
				card(_('Отдача'), E('div', {}, [ E('div', { class: 'nfm-rate' }, [ T.nUlN = E('b', {}, '–'), T.nUlU = E('span') ]),
					E('div', { class: 'nfm-s' }, [ _('всего отправлено '), t('nUlTot') ]) ])),
				card(_('Соединения'), E('div', {}, [ E('div', { class: 'nfm-rate' }, [ T.ctN = E('b', {}, '–'), T.ctMax = E('span') ]),
					E('div', { class: 'nfm-bar', style: 'margin:8px 0 6px' }, [ T.ctBar = E('div', { class: 'nfm-bar-fill c-cpu' }) ]),
					E('div', { class: 'nfm-s' }, [ t('ctProto') ]) ]))
			]),
			E('div', { class: 'nfm-grid' }, [
				card([ _('Что грузит канал сейчас'), E('span', { class: 'nfm-spacer' }), chanSel ], E('div', {}, [ chanNote, chanBox ]))
			]),
			E('div', { class: 'nfm-grid' }, [ card(_('DNS-запросы'), dnsBox) ]),
			E('div', { class: 'nfm-grid' }, [ card(_('Адрес WAN и CGNAT'), ipBox) ]),
			E('div', { class: 'nfm-grid' }, [
				card([ _('Скорость по интерфейсу'), E('span', { class: 'nfm-spacer' }), netSel,
					E('span', { class: 'nfm-legend' }, [ legendDot('c-down', _('Загрузка')), legendDot('c-up', _('Отдача')) ]) ], netBig.el)
			]),
			E('div', { class: 'nfm-grid nfm-g21' }, [
				card(_('Интерфейсы'), E('table', { class: 'nfm-table' }, [
					E('thead', {}, E('tr', {}, [ E('th', {}, _('Интерфейс')), E('th', { class: 'r' }, _('↓ сейчас')), E('th', { class: 'r' }, _('↑ сейчас')),
						E('th', { class: 'r' }, _('↓ всего')), E('th', { class: 'r' }, _('↑ всего')), E('th', { class: 'r' }, _('Ошибки')) ])), ifBody ])),
				card(_('Кто держит соединения'), hostsBox)
			]),
		]);

		/* processes tab */
		const procBody = E('tbody');
		const sortTh = (key, label, cls) => E('th', { class: 'sort ' + (cls || ''), click: () => { S.sort = key; refresh(); } }, label);
		const pmBox = E('div'), pmPer = E('select', { class: 'nfm-sel', 'aria-label': _('Период памяти'), change: ev => { S.pmH = +ev.target.value; S.at.pm = 0; tick(); } },
			[ [ 6, _('За 6 часов') ], [ 24, _('За 24 часа') ], [ 168, _('За 7 дней') ] ].map(([ v, l ]) => E('option', { value: String(v), selected: v === 24 }, l)));
		function renderProcMem() {
			const R = S.pm;
			if (!R || !R.rows) { pmBox.replaceChildren(E('div', { class: 'nfm-empty' }, R === null ? _('Нет данных: обновите тему на роутере.') : _('Загружаю…'))); return; }
			if (R.rows.length < 3) { pmBox.replaceChildren(E('div', { class: 'nfm-empty' }, _('Данных пока мало: память по программам записывается раз в 15 минут (в режиме Lite не ведётся).'))); return; }
			const ser = {};
			R.rows.forEach((row, i) => { for (const [ n, kb ] of row[1]) (ser[n] = ser[n] || new Array(R.rows.length).fill(null))[i] = kb; });
			const list = Object.keys(ser).map(n => {
				const v = ser[n].filter(x => x != null), first = v[0], last = v[v.length - 1], max = Math.max(...v);
				let up = 0; for (let i = 1; i < v.length; i++) if (v[i] >= v[i - 1]) up++;
				const grow = v.length >= 6 && last > first * 1.3 && last - first > 5120 && up >= 0.75 * (v.length - 1);
				return { n, first, last, max, grow, v: ser[n] };
			}).sort((a, b) => (b.grow - a.grow) || b.max - a.max).slice(0, 10);
			const spark = v => { const pts = v.map((x, i) => x == null ? null : [ i, x ]).filter(Boolean); const mx = Math.max(...pts.map(q => q[1])), mn = Math.min(...pts.map(q => q[1])), w = 90, h = 22, N = Math.max(1, v.length - 1);
				return SVG('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h }, [ SVG('polyline', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, points: pts.map(q => (q[0] / N * w).toFixed(1) + ',' + (h - 2 - (mx === mn ? 0.5 : (q[1] - mn) / (mx - mn)) * (h - 4)).toFixed(1)).join(' ') }) ]); };
			pmBox.replaceChildren(
				E('table', { class: 'nfm-table' }, [ E('thead', {}, E('tr', {}, [ E('th', {}, _('Программа')), E('th', {}, _('Динамика')), E('th', { class: 'r' }, _('В начале')), E('th', { class: 'r' }, _('Сейчас')), E('th', { class: 'r' }, _('Пик')) ])),
					E('tbody', {}, list.map(x => E('tr', {}, [ E('td', {}, [ x.n, x.grow ? E('span', { class: 'nfm-chip priv', title: _('Память растёт почти непрерывно: возможна утечка. Перезапустите службу и понаблюдайте.') }, _('растёт · возможна утечка')) : '' ]),
						E('td', {}, spark(x.v)), E('td', { class: 'r' }, fmtMB(x.first)), E('td', { class: 'r' }, fmtMB(x.last)), E('td', { class: 'r' }, fmtMB(x.max)) ]))) ]),
				E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, _('Показаны десять самых «толстых» программ. «Возможна утечка» ставится, если память почти все замеры только росла и выросла больше чем на 30% и 5 МБ.')));
		}
		const procs = E('div', { hidden: true }, [
			E('div', { class: 'nfm-grid nfm-g21 nfm-proc-overview' }, [ card(_('Ядра процессора'), E('div', {}, [ coresBox, tiles ])), flashCard ]),
			card([ _('Кто сколько занимает'), E('span', { class: 'nfm-note' }, _('память программ — примерно: общие библиотеки входят в каждую')) ], E('div', {}, [ memStack, memLegend ])),
			card([ _('Память по программам за период'), E('span', { class: 'nfm-spacer' }), pmPer ], pmBox),
			card([ _('Программы'), E('span', { class: 'nfm-spacer' }),
				E('input', { class: 'nfm-search', type: 'search', placeholder: _('Поиск…'), input: ev => { S.filter = ev.target.value.toLowerCase(); refresh(); } }) ],
				E('table', { class: 'nfm-table' }, [
					E('thead', {}, E('tr', {}, [ E('th', {}, _('Имя')), E('th', { class: 'r' }, _('Процессов')),
						sortTh('cpu', _('Процессор ↓'), 'r'), sortTh('mem', _('Память ↓'), 'r') ])), procBody ]))
		]);

		/* history tab */
		const rangeBtns = {};
		const rangeTabs = E('div', { class: 'nfm-tabs' }, Object.keys(RANGES).map(k =>
			rangeBtns[k] = E('button', { class: 'nfm-tab', click: () => { S.range = k; S.hist = undefined; S.at.hist = 0; refresh(); tick(); } }, RANGES[k][2])));
		const histNote = E('div', { class: 'nfm-hint', hidden: '' });
		const histMain = chart({ right: true, height: 240,
			series: [ { key: 'cpuB', cls: 'c-base', fill: 0, label: _('Процессор обычно'), fmt: v => nf0.format(v) + '%' }, { key: 'cpu', cls: 'c-cpu', label: _('Процессор'), fmt: v => nf0.format(v) + '%' }, { key: 'mem', cls: 'c-mem', label: _('Память'), fmt: v => nf0.format(v) + '%' },
				{ key: 'temp', cls: 'c-temp', axis: 'right', fill: .12, label: _('Температура'), fmt: v => nf1.format(v) + ' °C' } ],
			fmtLeft: v => nf0.format(v) + '%', fmtRight: v => nf0.format(v) + '°' });
		const histPing = chart({ height: 200,
			series: [ { key: 'netB', cls: 'c-base', fill: 0, label: _('Интернет обычно'), fmt: v => nf1.format(v) + _(' мс') }, { key: 'gw', cls: 'c-up', fill: 0, gaps: true, label: _('Шлюз'), fmt: v => nf1.format(v) + _(' мс') }, { key: 'net', cls: 'c-down', fill: 0, gaps: true, label: _('Интернет'), fmt: v => nf1.format(v) + _(' мс') } ],
			fmtLeft: v => nf0.format(v) + _(' мс'), fmtRight: () => '' });
		const histNet = chart({ height: 200, series: [ { key: 'rxB', cls: 'c-base', fill: 0, label: _('Загрузка обычно'), fmt: rateText }, { key: 'rx', cls: 'c-down', label: _('Загрузка'), fmt: rateText }, { key: 'tx', cls: 'c-up', fill: .18, label: _('Отдача'), fmt: rateText } ],
			fmtLeft: v => rateText(v), fmtRight: () => '' });
		const evBox = E('div', { class: 'nfm-evlist' });
		const histInfo = E('div', { class: 'nfm-s', style: 'margin-top:10px' });
		const pingTiles = E('div', { class: 'nfm-tiles t4' }, [ [ 'pAvg', _('средняя задержка') ], [ 'pMax', _('максимум') ], [ 'pLoss', _('потери ответов') ], [ 'pCut', _('обрывов связи') ] ]
			.map(([ k, l ]) => E('div', { class: 'nfm-tile' }, [ l, T[k] = E('b', {}, '–') ])));
		const CFG_FIELDS = [
			[ 'TEMP_WARN', _('Предупреждение о перегреве'), '°C' ], [ 'TEMP_CRIT', _('Критический перегрев'), '°C' ],
			[ 'MEM_MIN_PCT', _('Свободной памяти меньше'), '%' ], [ 'FLASH_MAX_PCT', _('Флеш занят больше'), '%' ],
			[ 'CT_MAX_PCT', _('Таблица соединений заполнена'), '%' ], [ 'CPU_MAX_PCT', _('Загрузка процессора'), '%' ],
			[ 'CPU_MINUTES', _('…и держится дольше'), _('мин') ],
			[ 'PING_TARGET', _('Проверка интернета: адрес 1'), '', 'text' ], [ 'PING_TARGET2', _('Проверка интернета: адрес 2'), '', 'text' ],
			[ 'PERSIST_DIR', _('Папка для сохранения истории'), '', 'text', _('например /mnt/sda1/nightfall; /overlay — только с разрешением') ],
			[ 'PERSIST_HOURS', _('Сохранять историю на накопитель'), _('ч') ], [ 'HIST_DAYS', _('Длинная история (шаг 30 мин), суток 7–90'), _('сут') ], [ 'BACKUP_KEEP', _('Хранить резервных копий на USB/SD (1–20)'), _('шт') ], [ 'PERSIST_ANY', _('Разрешить запись во внутреннюю флеш-память (износ и свободное место)'), '' ], [ 'JOURNAL', _('Журнал обрывов и перезагрузок (0/1)'), '' ], [ 'WIFI_HIST', _('История сигнала Wi-Fi (0/1)'), '' ],
			[ 'SPEED_URL', _('Файл для замера скорости'), '', 'text' ], [ 'SPEED_STREAMS', _('Потоков при замере скорости (1–8)'), '' ],
			[ 'NEWDEV', _('Сообщать о новых устройствах (0/1)'), '' ],
			[ 'LITE', _('Режим Lite для слабого роутера: опрос раз в 60 с, без учёта по приложениям и истории Wi‑Fi (0/1)'), '' ],
			[ 'APPS', _('Учёт трафика по приложениям (0/1)'), '' ],
			[ 'TG', _('Отправлять уведомления в Telegram (0/1)'), '' ], [ 'TG_ALERTS', _('Слать предупреждения и перезагрузки (0/1)'), '' ], [ 'TG_BOT', _('Бот с кнопками: меню, блокировка, перезагрузка (0/1)'), '' ], [ 'TG_CLEAN', _('Бот убирает за собой: ответ всегда внизу, команды удаляются (0/1)'), '' ], [ 'TG_UPDATES', _('Сообщать в Telegram о новых версиях темы (0/1)'), '' ], [ 'TG_SEC', _('Сообщать в Telegram о всплеске неудачных входов (0/1)'), '' ], [ 'TG_WIDGETS', _('Живые виджеты в боте: «Статус» с кольцами, только личный чат (0/1)'), '' ], [ 'TG_REPORT', _('Ежедневный отчёт в Telegram, время'), '', 'text', _('например 21:00, пусто = выкл') ],
			[ 'TG_TOKEN', _('Токен бота (от @BotFather)'), '', 'password', _('не задан') ], [ 'TG_CHAT', 'Chat id', '', 'text', _('число, определяется кнопкой') ],
			[ 'TG_USERS', _('Кому управлять ботом в группе (id через запятую)'), '', 'text', _('нужно, только если chat id группы') ],
			[ 'TG_PROXY', _('Прокси для Telegram (если он закрыт)'), '', 'text', _('например socks5h://127.0.0.1:1080') ],
			[ 'TG_IFACE', _('Или интерфейс VPN для Telegram'), '', 'text', _('например wg0') ]
		];
		const cfgInputs = {};
		const cfgMsg = E('span', { class: 'nfm-note-s' });
		const backupMsg = E('span', { class: 'nfm-note-s' });
		/* Telegram: сначала сохраняем введённое, потом просим роутер определить chat id или отправить проверочное сообщение */
		const tgMsg = E('div', { class: 'nfm-note-s', style: 'margin-top:6px' });
		const TG_CFG_KEYS = [ 'TG', 'TG_ALERTS', 'TG_BOT', 'TG_CLEAN', 'TG_UPDATES', 'TG_SEC', 'TG_WIDGETS', 'TG_REPORT', 'TG_TOKEN', 'TG_CHAT', 'TG_USERS', 'TG_PROXY', 'TG_IFACE', 'TG_ROUTE_MODE', 'TG_ROUTE_OUTPUT' ];
		const saveTelegramConfig = () => {
			const args = [ 'set' ].concat(TG_CFG_KEYS.map(k => k + '=' + (cfgBoolKeys.has(k) ? (cfgInputs[k].checked ? '1' : '0') : cfgInputs[k].value.trim())));
			return callCfg(args).then(r => {
				if (!(r && r.ok)) {
					tgMsg.textContent = _('Не сохранено: ') + ((r && r.error) || _('нет ответа'));
					return null;
				}
				return r;
			});
		};
		const notifyExec = args => fs.exec(NOTIFYBIN, args).then(res => {
			try { return JSON.parse(res.stdout || '{}'); }
			catch (e) { return { ok: false, error: _('Некорректный ответ nightfall-notify') }; }
		}).catch(err => ({ ok: false, error: _('Ошибка RPC запуска nightfall-notify: ') + ((err && err.message) || String(err)) }));
		const runTelegramTest = () => notifyExec([ 'test-start' ]).then(started => {
			if (!started || !started.ok) return started;
			const wait = ms => new Promise(resolve => window.setTimeout(resolve, ms));
			const pollResult = attempt => notifyExec([ 'test-status' ]).then(result => {
				if (!result || result.state !== 'running') return result;
				if (attempt >= 40)
					return { ok: false, error: _('Проверка всё ещё выполняется. Повторите проверку позже; фоновый запрос продолжает работу.') };
				return wait(1000).then(() => pollResult(attempt + 1));
			});
			return wait(500).then(() => pollResult(0));
		});
		const tgRun = cmd => {
			tgMsg.textContent = _('Сохраняю настройки и проверяю подключение…');
			return saveTelegramConfig().then(r => {
				if (!r) return null;
				const request = cmd === 'test' ? runTelegramTest() : notifyExec([ cmd ]);
				return request.then(result => {
					if (tgApiState) {
						tgApiState.textContent = (result && result.ok ? _('Telegram API ответил успешно.') : _('Запрос к Telegram не выполнен: ') + ((result && result.error) || _('нет ответа'))) + ' · ' + new Date().toLocaleTimeString();
						tgApiState.classList.toggle('is-good', !!(result && result.ok));
						tgApiState.classList.toggle('is-bad', !(result && result.ok));
					}
					return result;
				});
			});
		};
		const tgTools = E('div', { style: 'margin-top:10px' }, [
			E('div', { class: 'nfm-note-s' }, _('Как настроить: 1) в Telegram найдите @BotFather, создайте бота командой /newbot и вставьте токен выше; 2) откройте своего бота и нажмите Start; 3) нажмите «Определить chat id», затем «Отправить проверку»; 4) включите переключатель «Отправлять уведомления» и сохраните. После этого боту можно писать команды: /status, /clients, /traffic, /apps, /speed, /help (отвечает только вам).')),
			E('div', { class: 'nfm-actions', style: 'margin:8px 0 0' }, [
				E('button', { class: 'nfm-act', click: () => tgRun('chatid').then(r => { if (!r) return; if (r.ok) { cfgInputs.TG_CHAT.value = r.chat; callCfg([ 'set', 'TG_CHAT=' + r.chat ]); tgMsg.textContent = _('Chat id найден: ') + r.chat; } else tgMsg.textContent = r.error; }) }, _('Определить chat id')),
				E('button', { class: 'nfm-act', click: () => tgRun('test').then(r => { if (r) tgMsg.textContent = r.ok ? _('Сообщение отправлено, проверьте Telegram.') : _('Не отправлено: ') + r.error; }) }, _('Отправить проверку')),
				E('button', { class: 'nfm-act', click: () => tgRun('backup').then(r => { if (r) tgMsg.textContent = r.ok ? _('Резервная копия отправлена в Telegram файлом (без токена бота).') : _('Не отправлено: ') + r.error; }) }, _('Резервная копия в Telegram')) ]),
			tgMsg ]);
		/* ---- Накопители: найти флешку / SD-карту и одним нажатием хранить на ней историю ---- */
		const dskBody = E('div', {}, E('div', { class: 'nfm-empty' }, _('Ищу накопители…')));
		const dskMsg = E('div', { class: 'nfm-note-s', style: 'margin-top:8px' });
		function loadDisks() { return callCfg([ 'disks' ]).then(r => { S.dsk = r || null; renderDisks(); }).catch(() => { S.dsk = null; renderDisks(); }); }
		function setPersist(dir, hours, msg) {
			dskMsg.textContent = _('Применяю…');
			callCfg(dir ? [ 'set', 'PERSIST_DIR=' + dir, 'PERSIST_HOURS=' + hours ] : [ 'set', 'PERSIST_DIR=' ]).then(r => {
				if (!(r && r.ok)) { dskMsg.textContent = _('Не сохранено: ') + ((r && r.error) || _('нет ответа')); return; }
				dskMsg.textContent = msg; S.at.alerts = 0; S.at.hist = 0;
				callCfg([ 'get' ]).then(c => { S.cfg = c; if (c) fillCfg(c.values); renderDisks(); });
			});
		}
		function renderDisks() {
			const d = S.dsk, cur = ((S.cfg && S.cfg.values) || {}).PERSIST_DIR || '';
			if (d === undefined) return;
			if (!d || !Array.isArray(d.disks)) { dskBody.replaceChildren(E('div', { class: 'nfm-hint' }, _('Не удалось получить список накопителей: обновите тему на роутере до последней версии.'))); return; }
			if (!d.disks.length) {
				const parts = (d.parts || []).filter(x => /^\/dev\/(sd|nvme|vd|mmcblk)/.test(x.dev)), fsl = d.fs || [], msg = [];
				const need = { vfat: 'kmod-fs-vfat', exfat: 'kmod-fs-exfat', ntfs: 'kmod-fs-ntfs3', ext4: 'kmod-fs-ext4', f2fs: 'kmod-fs-f2fs', btrfs: 'kmod-fs-btrfs' };
				if (parts.length) {
					msg.push(_('Роутер видит раздел: ') + parts.map(x => x.dev + ' (' + fmtBytes(x.size_kb * 1024) + (x.type ? ', ' + x.type : '') + ')').join(', ') + _(', но он не смонтирован.'));
					const bad = parts.filter(x => x.type && need[x.type] && !fsl.includes(x.type) && !(x.type === 'ntfs' && fsl.includes('ntfs3')));
					if (bad.length) msg.push(_('Не хватает драйвера файловой системы: установите ') + [ ...new Set(bad.map(x => need[x.type])) ].join(', ') + _(' и перезагрузите роутер.'));
					msg.push(_('Затем откройте «Система → Точки монтирования», нажмите «Добавить», выберите этот раздел, точка монтирования /mnt/sda1, включите и нажмите «Сохранить и применить». Если там уже есть запись с пометкой «не существует», удалите её и добавьте заново.'));
				} else if (d.usb_storage === 0) {
					msg.push(_('Драйвер USB-накопителей не загружен. Установите kmod-usb-storage (для USB 3.0 ещё kmod-usb-storage-uas) и перезагрузите роутер.'));
				} else {
					msg.push(_('Роутер не видит флешку как диск. Проверьте, что она вставлена до конца, попробуйте другой порт или другую флешку (некоторым не хватает питания). Запись в «Точках монтирования» с пометкой «не существует» значит то же самое: раздел с таким UUID сейчас не найден. Подробности на роутере: dmesg | grep -i usb.'));
				}
				msg.push(_('Когда накопитель смонтируется, нажмите «Обновить»: он появится здесь.'));
				dskBody.replaceChildren(...msg.map(t => E('div', { class: 'nfm-hint', style: 'margin-bottom:6px' }, t)));
				return;
			}
			dskBody.replaceChildren(...d.disks.map(k => {
				const dir = k.mount.replace(/\/$/, '') + '/nightfall', used = cur === dir || cur.indexOf(k.mount.replace(/\/$/, '') + '/') === 0;
				return E('div', { class: 'nfm-dsk' }, [
					E('div', { class: 'nfm-dsk-i' }, [ E('b', {}, k.mount), E('span', { class: 'nfm-note-s' }, k.dev + ' · ' + k.fs + ' · ' + fmtBytes(k.size_kb * 1024) + _(', свободно ') + fmtBytes(k.free_kb * 1024)) ]),
					used ? E('button', { type: 'button', class: 'nfm-btn', click: () => setPersist('', 0, _('Сохранение истории на накопитель выключено, история снова только в памяти.')) }, _('✓ История здесь · отключить'))
						: E('button', { type: 'button', class: 'nfm-btn', click: () => setPersist(dir, 1, _('Готово: история сохраняется в ') + dir + _(' раз в час и переживёт перезагрузку роутера.')) }, _('Хранить историю здесь')) ]);
			}));
		}

		const cfgBoolKeys = new Set([ 'PERSIST_ANY', 'JOURNAL', 'WIFI_HIST', 'NEWDEV', 'LITE', 'APPS', 'TG', 'TG_ALERTS', 'TG_BOT', 'TG_CLEAN', 'TG_UPDATES', 'TG_SEC', 'TG_WIDGETS' ]);
		function cfgField(k) {
			const field = CFG_FIELDS.find(f => f[0] === k);
			if (!field) return null;
			const [ key, label, unit, type, placeholder ] = field;
			if (cfgBoolKeys.has(key)) {
				cfgInputs[key] = E('input', { class: 'nfm-toggle', type: 'checkbox', role: 'switch', 'aria-label': label });
				return E('label', { class: 'nfm-cfg-i nfm-cfg-toggle' }, [ label.replace(/\s*\(0\/1\)$/, ''), E('span', { class: 'nfm-cfg-f' }, cfgInputs[key]) ]);
			}
			cfgInputs[key] = E('input', { class: 'nfm-in', type: type || 'number', placeholder: placeholder || '' });
			return E('label', { class: 'nfm-cfg-i' }, [ label,
				E('span', { class: 'nfm-cfg-f' }, [ cfgInputs[key], unit ? E('em', {}, unit) : '' ]) ]);
		}
		function cfgGroup(title, keys, extra, cls) {
			const icons = {
				[_('Температура и память')]: [ 'path', { d: 'M9 18h6M10 22h4M8 14a6 6 0 1 1 8 0c-.8.7-1 1.3-1 2H9c0-.7-.2-1.3-1-2Z' } ],
				[_('Процессор и соединения')]: [ 'fragment', [
					[ 'rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 } ],
					[ 'path', { d: 'M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4' } ]
				] ],
				[_('Проверка интернета')]: [ 'fragment', [
					[ 'circle', { cx: 12, cy: 12, r: 9 } ],
					[ 'path', { d: 'M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18' } ]
				] ],
				[_('Замер скорости')]: [ 'fragment', [
					[ 'path', { d: 'M4 19a9 9 0 1 1 16 0' } ],
					[ 'path', { d: 'm12 13 4-5M7 19h10' } ],
					[ 'circle', { cx: 12, cy: 13, r: 1 } ]
				] ],
				[_('Хранение истории и резервные копии')]: [ 'fragment', [
					[ 'ellipse', { cx: 12, cy: 5, rx: 8, ry: 3 } ],
					[ 'path', { d: 'M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3' } ]
				] ],
				[_('Режим и функции мониторинга')]: [ 'fragment', [
					[ 'path', { d: 'M12 2v3m0 14v3M4.9 4.9 7 7m10 10 2.1 2.1M2 12h3m14 0h3M4.9 19.1 7 17m10-10 2.1-2.1' } ],
					[ 'circle', { cx: 12, cy: 12, r: 5 } ]
				] ],
				[_('Уведомления')]: [ 'fragment', [
					[ 'path', { d: 'M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4' } ]
				] ],
				[_('Управление ботом')]: [ 'fragment', [
					[ 'rect', { x: 3, y: 7, width: 18, height: 13, rx: 3 } ],
					[ 'path', { d: 'M12 3v4M8 13h.01M16 13h.01M9 17h6' } ]
				] ],
				[_('Подключение и инструменты')]: [ 'fragment', [
					[ 'path', { d: 'M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4' } ]
				] ]
			};
			function cfgIcon() {
				const spec = icons[title] || [ 'circle', { cx: 12, cy: 12, r: 8 } ];
				const svg = SVG('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
				if (spec[0] === 'fragment')
					spec[1].forEach(([ tag, attrs ]) => svg.appendChild(SVG(tag, attrs)));
				else
					svg.appendChild(SVG(spec[0], spec[1]));
				return svg;
			}
			return E('details', { class: 'nfm-cfg-g' + (cls ? ' ' + cls : ''), open: true }, [
				E('summary', { class: 'nfm-cfg-head' }, [
					E('span', { class: 'nfm-cfg-icon', 'aria-hidden': 'true' }, cfgIcon()),
					E('span', { class: 'nfm-cfg-heading' }, title),
					E('span', { class: 'nfm-cfg-chevron', 'aria-hidden': 'true' }, '⌄')
				]),
				E('div', { class: 'nfm-cfg-body' }, [
					E('div', { class: 'nfm-cfg' }, keys.map(cfgField).filter(Boolean)),
					extra || ''
				])
			]);
		}
		const cfgCard = card(_('Настройки предупреждений'), E('div', {}, [
			E('div', { class: 'nfm-cfg-layout' }, [
				cfgGroup(_('Температура и память'), [ 'TEMP_WARN', 'TEMP_CRIT', 'MEM_MIN_PCT', 'FLASH_MAX_PCT' ]),
				cfgGroup(_('Процессор и соединения'), [ 'CPU_MAX_PCT', 'CPU_MINUTES', 'CT_MAX_PCT' ]),
				cfgGroup(_('Проверка интернета'), [ 'PING_TARGET', 'PING_TARGET2' ]),
				cfgGroup(_('Замер скорости'), [ 'SPEED_URL', 'SPEED_STREAMS' ]),
				cfgGroup(_('Хранение истории и резервные копии'), [ 'PERSIST_DIR', 'PERSIST_HOURS', 'HIST_DAYS', 'BACKUP_KEEP', 'PERSIST_ANY', 'JOURNAL', 'WIFI_HIST' ]),
				cfgGroup(_('Режим и функции мониторинга'), [ 'LITE', 'APPS', 'NEWDEV' ])
			]),

			E('div', { class: 'nfm-cfg-actions' }, [
				E('button', { class: 'nfm-act', click: () => saveCfg() }, _('✓ Сохранить и применить')),
				E('button', { class: 'nfm-act', click: () => (S.cfg ? Promise.resolve(S.cfg) : callCfg([ 'get' ]).then(c => (S.cfg = c))).then(c => fillCfg(c && c.defaults)) }, _('Значения по умолчанию')),
				E('button', { class: 'nfm-act', click: () => copyDiag() }, _('Скопировать диагностику')),
				E('button', { class: 'nfm-act', click: () => {
					backupMsg.textContent = _('Создаю и проверяю резервную копию…');
					fs.exec('/usr/libexec/nightfall-backup', [ 'create' ]).then(r => {
						backupMsg.textContent = ((r.stdout || '') + (r.stderr || '')).trim() || _('Нет ответа от архиватора.');
					}).catch(e => { backupMsg.textContent = _('Не удалось создать копию: ') + String((e && e.message) || e); });
				} }, _('Создать резервную копию сейчас'))
			]),
			cfgMsg,
			backupMsg,
			E('details', { class: 'nfm-cfg-help' }, [
				E('summary', {}, _('Справка по настройкам')),
				E('div', {}, _('Для честного разделения трафика укажите известные VPN-серверы в формате IP:порт (через запятую): их внешний трафик будет показан как «VPN». Содержимое внутри зашифрованного туннеля определить нельзя. Пустой адрес 1 отключает проверку интернета. Историю безопаснее хранить на USB/SD. Путь внутри /overlay разрешается только при включённом переключателе внутренней флеш-памяти: это ускоряет износ и может заполнить системный раздел, поэтому оставляйте запас свободного места. Корневой / и /rom всегда запрещены. Резервные копии лежат отдельно в nightfall-backups; если USB отключён, копия временно создаётся в /tmp. После сохранения сборщик перезапускается, накопленная история не теряется.'))
			])
		]), 'nfm-cfg-settings-card');

		/* ---- Telegram control centre: settings moved here from History. ---- */
		cfgInputs.TG_IFACE = E('input', { type: 'hidden', value: '' });
		cfgInputs.TG_ROUTE_MODE = E('input', { type: 'hidden', value: '' });
		cfgInputs.TG_ROUTE_OUTPUT = E('input', { type: 'hidden', value: '' });

		const tgModeRadios = {};
		/* Keep the native select's option DOM stable between 2-second monitor polls.
		 * Replacing options while its popup is open cancels mouse selection in browsers. */
		let tgOutputSignature = null;
		const tgSteerValue = E('b', {}, _('Определение…'));
		const tgOutputCount = E('b', {}, '–');
		const tgRouteState = E('div', { class: 'nfm-tg-state' }, _('Загрузка данных маршрутизации…'));
		const tgApiState = E('div', { class: 'nfm-tg-state' }, _('Проверка ещё не выполнялась'));
		const tgRouteStatus = E('div', { class: 'nfm-tg-state' }, _('Маршрут ещё не применён.'));
		const tgSettingsMsg = E('div', { class: 'nfm-tg-state' }, '');
		const tgOutputList = E('div', { class: 'nfm-tg-output-list', role: 'group', 'aria-label': _('VPN-выход для Telegram') });
		function chooseTgOutput(item) {
			if (!item || item.ready === false) return;
			cfgInputs.TG_ROUTE_OUTPUT.value = item.id;
			Array.from(tgOutputList.querySelectorAll('button[data-output]')).forEach(button => {
				button.classList.toggle('selected', button.getAttribute('data-output') === item.id);
				button.setAttribute('aria-pressed', button.getAttribute('data-output') === item.id ? 'true' : 'false');
			});
			tgRouteState.textContent = _('Выбранный выход: ') + (item.label || item.id);
		}
		const tgProxyField = cfgField('TG_PROXY');
		const tgProxyPane = E('div', { class: 'nfm-tg-mode-pane' }, [
			E('div', { class: 'nfm-note-s' }, _('Прокси используется только запросами Nightfall к Telegram API. Для DNS через прокси используйте socks5h://.')),
			tgProxyField
		]);
		const tgVpnPane = E('div', { class: 'nfm-tg-mode-pane' }, [
			E('label', { class: 'nfm-cfg-label' }, _('Обнаруженные VPN-выходы и policy-routing таблицы')),
			tgOutputList,
			E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, _('Nightfall использует существующую таблицу Steer или создаёт собственную таблицу только для выбранного обычного VPN-интерфейса. Правила и маршруты других программ не переписываются.'))
		]);
		const tgModeDescription = E('div', { class: 'nfm-note-s', style: 'margin-top:10px' });
		function setTgMode(mode) {
			cfgInputs.TG_ROUTE_MODE.value = mode;
			renderTelegram();
		}
		function tgModeChoice(mode, title, description) {
			const radio = E('input', { type: 'radio', name: 'nfm-tg-route-mode', value: mode, change: () => setTgMode(mode) });
			tgModeRadios[mode] = radio;
			return E('label', { class: 'nfm-tg-mode-choice', 'data-mode': mode }, [
				radio,
				E('span', { class: 'nfm-tg-mode-copy' }, [
					E('b', {}, title),
					E('small', {}, description)
				])
			]);
		}
		const tgRouteCard = card(_('Маршрут подключения к Telegram'), E('div', {}, [
			E('div', { class: 'nfm-tg-mode-list' }, [
				tgModeChoice('system', _('Системный маршрут'), _('Обычная маршрутизация OpenWrt. Никакие VPN-настройки не изменяются.')),
				tgModeChoice('proxy', _('Через прокси'), _('SOCKS5 / SOCKS5H / HTTP(S). Работает независимо от Steer.')),
				tgModeChoice('vpn', _('Через VPN'), _('Только соединения Telegram направляются через выбранный VPN-выход. При его отказе прямого обхода не будет.'))
			]),
			tgProxyPane,
			tgVpnPane,
			tgModeDescription,
			E('div', { class: 'nfm-actions', style: 'margin-top:12px' }, [
				E('button', { type: 'button', class: 'nfm-act', click: () => loadTelegram(true) }, _('Обновить список выходов')),
				E('button', { type: 'button', class: 'nfm-act', click: () => applyTelegramRoute() }, _('Сохранить и применить маршрут'))
			]),
			tgRouteState
		]));

		const tgMasterField = cfgField('TG');
		const tgHero = E('div', { class: 'nfm-tg-hero' }, [
			E('div', { class: 'nfm-tg-brand' }, [
				E('div', { class: 'nfm-tg-logo', 'aria-hidden': 'true' }, '➤'),
				E('div', {}, [
					E('h2', {}, _('Telegram-бот')),
					E('div', { class: 'nfm-sub' }, _('Управление роутером и получение уведомлений через Telegram'))
				])
			]),
			E('div', { class: 'nfm-tg-master' }, [
				E('span', {}, _('Бот и уведомления')),
				tgMasterField
			])
		]);
		const tgConnectionCard = card(_('Подключение'), E('div', {}, [
			cfgField('TG_TOKEN'),
			cfgField('TG_CHAT'),
			tgTools
		]));
		const tgNotifyGroup = cfgGroup(_('Уведомления'), [ 'TG_ALERTS', 'TG_UPDATES', 'TG_SEC', 'TG_REPORT' ]);
		const tgBotGroup = cfgGroup(_('Управление ботом'), [ 'TG_BOT', 'TG_CLEAN', 'TG_WIDGETS' ]);
		const tgNotifyDisclosure = E('details', { class: 'nfm-tg-disclosure' }, [ E('summary', {}, [ E('span', { class: 'nfm-tg-disclosure-icon' }, '◉'), _('Уведомления'), E('span', { class: 'nfm-tg-disclosure-hint' }, _('События и отчёты')) ]), tgNotifyGroup ]);
		const tgBotDisclosure = E('details', { class: 'nfm-tg-disclosure' }, [ E('summary', {}, [ E('span', { class: 'nfm-tg-disclosure-icon' }, '⌘'), _('Управление ботом'), E('span', { class: 'nfm-tg-disclosure-hint' }, _('Команды и меню')) ]), tgBotGroup ]);
		const tgIntegrationCard = card(_('Обнаруженная интеграция'), E('div', {}, [
			E('div', { class: 'nfm-tg-info-row' }, [ E('span', {}, _('VPN-менеджер')), tgSteerValue ]),
			E('div', { class: 'nfm-tg-info-row' }, [ E('span', {}, _('Доступные выходы')), tgOutputCount ]),
			E('div', { class: 'nfm-tg-note' }, _('Обнаружение строится по интерфейсам ядра и правилам ip rule. Поддержка не зависит от фиксированных имён Steer, WireGuard или TUN.'))
		]));
		const tgApiCard = card(_('Адреса Telegram'), E('div', {}, [
			E('div', { class: 'nfm-tg-info-row' }, [ E('span', {}, 'api.telegram.org'), E('b', {}, 'HTTPS · 443') ]),
			E('div', { class: 'nfm-tg-note' }, _('Все проверки выполняются тем же Telegram-клиентом Nightfall и тем же выбранным способом подключения.')),
			tgApiState
		]));
		const tgRouteStatusCard = card(_('Статус маршрута'), E('div', {}, [
			tgRouteStatus,
			E('div', { class: 'nfm-tg-note' }, _('Статус проверяется по живым данным Steer, состоянию интерфейса, policy-routing таблице, метке и фактическому выбору маршрута ядром. Это подтверждает маршрут на уровне OpenWrt; доступность Telegram API проверяется отдельно кнопкой теста. Остальной трафик роутера не перенаправляется.'))
		]));
		const tgAdvanced = E('details', { class: 'nfm-cfg-g nfm-tg-advanced' }, [
			E('summary', { class: 'nfm-cfg-head' }, [
				E('span', { class: 'nfm-cfg-icon' }, '⚙'),
				E('span', { class: 'nfm-cfg-heading' }, _('Расширенные настройки')),
				E('span', { class: 'nfm-cfg-chevron' }, '⌄')
			]),
			E('div', { class: 'nfm-cfg-body' }, [
				E('div', { class: 'nfm-cfg' }, [ cfgField('TG_USERS') ]),
				E('div', { class: 'nfm-note-s' }, _('Список разрешённых пользователей для управления ботом в групповом чате. В личном чате не требуется.'))
			])
		]);
		const tgTab = E('div', { hidden: true, class: 'nfm-tg-page' }, [
			E('style', {}, [ '.nfm-tg-page{min-width:0}.nfm-tg-hero{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:16px 18px;margin-bottom:14px;border:1px solid var(--nfm-border);border-radius:14px;background:var(--nfm-card)}.nfm-tg-brand{display:flex;align-items:center;gap:14px;min-width:0}.nfm-tg-logo{width:54px;height:54px;display:grid;place-items:center;border-radius:50%;background:#168fd2;color:white;font-size:27px;font-weight:700;box-shadow:0 5px 18px #168fd233}.nfm-tg-brand h2{margin:0 0 4px}.nfm-tg-master{display:flex;align-items:center;gap:12px}.nfm-tg-mode-list{display:grid;gap:8px}.nfm-tg-mode-choice{display:flex;align-items:flex-start;gap:11px;padding:12px;border:1px solid var(--nfm-border);border-radius:11px;cursor:pointer;min-width:0}.nfm-tg-mode-choice:has(input:checked){border-color:var(--nfm-accent);background:color-mix(in srgb,var(--nfm-accent) 9%,var(--nfm-card))}.nfm-tg-mode-choice input{margin-top:3px;flex:0 0 auto}.nfm-tg-mode-copy{display:flex;flex-direction:column;gap:3px;min-width:0}.nfm-tg-mode-copy small{color:var(--nfm-dim);line-height:1.4}.nfm-tg-mode-pane{margin-top:10px;padding:12px;border:1px solid var(--nfm-border);border-radius:10px;background:var(--nfm-card2)}.nfm-tg-info-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--nfm-border)}.nfm-tg-info-row:last-of-type{border-bottom:0}.nfm-tg-note,.nfm-tg-state{margin-top:10px;padding:10px 12px;border-radius:9px;background:var(--nfm-card2);line-height:1.45}.nfm-tg-state{font-size:.94em}.nfm-tg-output-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:6px;max-height:190px;overflow:auto;margin-top:7px;padding:1px 3px 1px 1px}.nfm-tg-output-choice{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-width:0;padding:9px 11px;border:1px solid var(--nfm-border);border-radius:9px;background:var(--nfm-card);color:var(--nfm-text);font:inherit;font-size:12px;line-height:1.35;text-align:left;cursor:pointer}.nfm-tg-output-choice:hover:not(:disabled){border-color:var(--nfm-accent)}.nfm-tg-output-choice.selected{border-color:var(--nfm-accent);background:color-mix(in srgb,var(--nfm-accent) 12%,var(--nfm-card));box-shadow:inset 0 0 0 1px var(--nfm-accent)}.nfm-tg-output-choice:disabled{opacity:.5;cursor:not-allowed}.nfm-tg-output-name{min-width:0;overflow-wrap:anywhere}.nfm-tg-output-state{flex:0 0 auto;font-size:11px;color:var(--nfm-dim)}.nfm-tg-output-state.is-ready{color:#36c77a}.nfm-tg-output-state.is-unavailable{color:#e0a34b}.nfm-tg-advanced{margin-top:10px}.nfm-tg-advanced .nfm-cfg-body{padding-top:12px}.nfm-tg-secondary{align-items:start}.nfm-tg-disclosure{min-width:0;border:1px solid var(--nfm-border);border-radius:12px;background:var(--nfm-card);padding:0 14px;overflow:hidden}.nfm-tg-disclosure>summary{display:flex;align-items:center;gap:9px;min-height:52px;cursor:pointer;list-style:none;font-weight:600;font-size:13px}.nfm-tg-disclosure>summary::-webkit-details-marker{display:none}.nfm-tg-disclosure>summary:after{content:"⌄";margin-left:auto;color:var(--nfm-dim);transition:transform .2s}.nfm-tg-disclosure[open]>summary:after{transform:rotate(180deg)}.nfm-tg-disclosure-icon{display:grid;place-items:center;width:28px;height:28px;border-radius:9px;background:color-mix(in srgb,var(--nfm-accent) 14%,var(--nfm-card2));color:var(--nfm-accent)}.nfm-tg-disclosure-hint{margin-left:auto;color:var(--nfm-dim);font-size:11px;font-weight:400}.nfm-tg-disclosure[open] .nfm-tg-disclosure-hint{display:none}.nfm-tg-disclosure .nfm-cfg-g{border:0;padding:0 0 12px;background:transparent;box-shadow:none}.nfm-tg-disclosure .nfm-cfg-head{display:none}.nfm-tg-disclosure .nfm-cfg-body{padding:0}.nfm-tg-page .nfm-card{padding:14px 16px}.nfm-tg-page .nfm-card-title{margin-bottom:9px}.nfm-tg-page .nfm-tg-state{margin-top:8px}.nfm-tg-page .nfm-tg-mode-choice{padding:9px 10px}.nfm-tg-page .nfm-tg-mode-copy small{font-size:11.5px}.nfm-tg-page .nfm-tg-mode-pane{padding:10px}.nfm-tg-page .nfm-tg-hero{padding:13px 16px;margin-bottom:10px}.nfm-tg-page .nfm-tg-logo{width:46px;height:46px;font-size:24px}.nfm-tg-page .nfm-tg-advanced{margin-top:10px}.nfm-tg-page .nfm-tg-status-row .nfm-tg-note{font-size:12px}@media(max-width:700px){.nfm-tg-output-list{grid-template-columns:1fr;max-height:220px}.nfm-tg-hero{align-items:flex-start}.nfm-tg-master{width:100%;justify-content:space-between}.nfm-tg-mode-choice{padding:10px}.nfm-tg-disclosure-hint{font-size:10px}}' ]),
			tgHero,
			E('div', { class: 'nfm-grid nfm-g21' }, [ tgConnectionCard, tgRouteCard ]),
			E('div', { class: 'nfm-grid nfm-g3 nfm-tg-secondary' }, [ tgNotifyDisclosure, tgBotDisclosure, tgIntegrationCard ]),
			E('div', { class: 'nfm-grid nfm-g21 nfm-tg-status-row' }, [ tgApiCard, tgRouteStatusCard ]),
			tgAdvanced,
			card(_('Применение настроек'), E('div', {}, [
				E('div', { class: 'nfm-note-s' }, _('Сохраните параметры бота отдельно от применения VPN-маршрута. Тест отправит реальное сообщение через выбранный способ подключения.')),
				E('div', { class: 'nfm-actions', style: 'margin-top:10px' }, [
					E('button', { type: 'button', class: 'nfm-act', click: () => saveTelegramConfig().then(r => {
						tgSettingsMsg.textContent = r ? _('Настройки Telegram сохранены.') : _('Не удалось сохранить настройки Telegram.');
					}) }, _('Сохранить настройки Telegram')),
					E('button', { type: 'button', class: 'nfm-act', click: () => tgRun('test').then(r => {
						tgApiState.textContent = (r && r.ok ? _('Telegram API ответил успешно.') : _('Проверка не пройдена: ') + ((r && r.error) || _('нет ответа'))) + ' · ' + new Date().toLocaleTimeString();
						tgApiState.classList.toggle('is-good', !!(r && r.ok));
						tgApiState.classList.toggle('is-bad', !(r && r.ok));
					}) }, _('Тест подключения'))
				]),
				tgSettingsMsg
			]))
		]);

		function renderTelegramRuntime(mode) {
			const status = S.tgRouteRuntime;
			if (!status || !status.ok) {
				tgRouteStatus.textContent = status && status.error
					? _('Не удалось получить состояние маршрута: ') + status.error
					: _('Проверяю, установлен ли отдельный маршрут Telegram…');
				tgRouteStatus.classList.remove('is-good', 'is-bad');
				return;
			}
			if (status.blocked) {
				tgRouteStatus.textContent = _('Защитная блокировка активна: Telegram не уйдёт напрямую. Выход: ') + (status.output || cfgInputs.TG_ROUTE_OUTPUT.value || 'VPN');
				tgRouteStatus.classList.add('is-bad');
				tgRouteStatus.classList.remove('is-good');
				return;
			}
			if (status.active) {
				tgRouteStatus.textContent = _('Маршрут ядра активен: ') +
					(status.source === 'steer' ? 'Steer' : _('VPN-интерфейс')) +
					' · ' + (status.device || status.output || '') +
					(status.table ? ' · table ' + status.table : '');
				tgRouteStatus.classList.add('is-good');
				tgRouteStatus.classList.remove('is-bad');
				return;
			}
			tgRouteStatus.textContent = mode === 'system'
				? _('Отдельные правила не установлены. Telegram использует системный маршрут OpenWrt.')
				: mode === 'proxy'
					? _('Прокси выбран. Проверка доступности Telegram появится после тестового запроса.')
					: _('VPN выбран, но изолированный маршрут ещё не применён. Нажмите «Сохранить и применить маршрут».');
			tgRouteStatus.classList.remove('is-good', 'is-bad');
		}

		function renderTelegram() {
			const values = S.cfg && S.cfg.values || {};
			const mode = cfgInputs.TG_ROUTE_MODE.value || values.TG_ROUTE_MODE || (values.TG_PROXY ? 'proxy' : values.TG_IFACE ? 'vpn' : 'system');
			// Migrate legacy TG_IFACE/TG_PROXY values into the new route fields
			// before any save action can overwrite the old configuration.
			if (!cfgInputs.TG_ROUTE_MODE.value) cfgInputs.TG_ROUTE_MODE.value = mode;
			if (!cfgInputs.TG_ROUTE_OUTPUT.value)
				cfgInputs.TG_ROUTE_OUTPUT.value = values.TG_ROUTE_OUTPUT || (values.TG_IFACE ? 'iface:' + values.TG_IFACE : '');
			if (!cfgInputs.TG_IFACE.value && values.TG_IFACE) cfgInputs.TG_IFACE.value = values.TG_IFACE;
			for (const key of Object.keys(tgModeRadios))
				tgModeRadios[key].checked = key === mode;
			tgProxyPane.hidden = mode !== 'proxy';
			tgVpnPane.hidden = mode !== 'vpn';
			tgModeDescription.textContent = mode === 'system'
				? _('Используется системный маршрут OpenWrt.')
				: mode === 'proxy'
					? _('Telegram API будет доступен только через указанный прокси.')
					: _('VPN-режим использует отдельный UID и policy routing. При отсутствии рабочего выхода отправка блокируется.');

			if (!S.tgInfo || !S.tgInfo.ok) {
				tgSteerValue.textContent = S.tgInfo && S.tgInfo.error ? _('Ошибка обнаружения') : _('Не проверено');
				tgOutputCount.textContent = '–';
				tgRouteState.textContent = S.tgInfo && S.tgInfo.error ? _('Не удалось обнаружить выходы: ') + S.tgInfo.error : _('Нажмите «Обновить список выходов».');
				renderTelegramRuntime(mode);
				if (tgOutputSignature !== 'unavailable' && !tgOutputList.contains(document.activeElement)) {
					tgOutputList.replaceChildren(E('div', { class: 'nfm-note-s' }, _('Список выходов пока не получен')));
					tgOutputSignature = 'unavailable';
				}
				return;
			}

			const info = S.tgInfo;
			tgSteerValue.textContent = info.steer && info.steer.found
				? _('Steer ') + (info.steer.version || _('обнаружен'))
				: _('Универсальный Linux policy routing');
			const steerOutputs = info.outputs || [];
			const steerDevices = new Set(steerOutputs.map(item => item.device).filter(Boolean));
			/* Do not show the same kernel tunnel twice: Steer output entries are the
			 * canonical choices; generic Point-to-point/TUN entries are fallbacks only. */
			const genericInterfaces = (info.interfaces || []).filter(item => !steerDevices.has(item.device));
			const outputs = steerOutputs.concat(genericInterfaces);
			const readyCount = outputs.filter(item => item.ready !== false).length;
			tgOutputCount.textContent = _('%d из %d готовы').format(readyCount, outputs.length);
			const current = cfgInputs.TG_ROUTE_OUTPUT.value || values.TG_ROUTE_OUTPUT || (values.TG_IFACE ? 'iface:' + values.TG_IFACE : '');
			const outputSignature = JSON.stringify([ outputs.map(item => [ item.id, item.label || '', item.ready !== false ]) ]);
			/* Show all discovered routes. Their state comes from steer status plus
			 * kernel link/table checks; unavailable routes remain visible but disabled. */
			if (outputSignature !== tgOutputSignature && !tgOutputList.contains(document.activeElement)) {
				const choices = outputs.map(item => {
					const ready = item.ready !== false;
					return E('button', {
						type: 'button',
						class: 'nfm-tg-output-choice' + (item.id === current ? ' selected' : ''),
						'data-output': item.id,
						'aria-pressed': item.id === current ? 'true' : 'false',
						disabled: !ready,
						click: () => chooseTgOutput(item)
					}, [
						E('span', { class: 'nfm-tg-output-name' }, item.label || item.id),
						E('span', { class: 'nfm-tg-output-state' + (ready ? ' is-ready' : ' is-unavailable') },
							ready ? (item.id.startsWith('steer:') ? _('Готов · Steer') : _('Готов · VPN')) : _('Не готов'))
					]);
				});
				tgOutputList.replaceChildren(...(choices.length ? choices : [ E('div', { class: 'nfm-note-s' }, _('VPN-выходы не обнаружены. Проверьте состояние Steer или VPN-интерфейсов.')) ]));
				tgOutputSignature = outputSignature;
			}
			Array.from(tgOutputList.querySelectorAll('button[data-output]')).forEach(button => {
				const selected = button.getAttribute('data-output') === current;
				button.classList.toggle('selected', selected);
				button.setAttribute('aria-pressed', selected ? 'true' : 'false');
			});
			if (mode === 'vpn') {
				const selected = outputs.find(item => item.id === current);
				tgRouteState.textContent = selected
					? (selected.ready === false ? _('Сохранённый выход сейчас не готов. Выберите доступный выход.') : _('Выбранный выход: ') + (selected.label || selected.id))
					: current ? _('Сохранённый VPN-выход не обнаружен. Выберите другой выход или восстановите подключение.') : _('Выберите VPN-выход. Автоматически первый выход не выбирается.');
			} else if (mode === 'proxy') {
				tgRouteState.textContent = cfgInputs.TG_PROXY.value ? _('Прокси указан. После сохранения можно проверить Telegram API.') : _('Укажите адрес прокси для этого режима.');
			} else {
				tgRouteState.textContent = _('Telegram использует стандартную маршрутизацию OpenWrt.');
			}
			renderTelegramRuntime(mode);
		}

		function loadTelegram(force) {
			if (!force && S.tgInfo && Date.now() - (S.tgInfoAt || 0) < 30000) {
				renderTelegram();
				return Promise.resolve();
			}
			const helper = '/usr/libexec/nightfall-telegram-route';
			return Promise.all([
				fs.exec(helper, [ 'inspect' ]).then(res => {
					try { return JSON.parse(res.stdout || '{}'); }
					catch (e) { return { ok: false, error: _('Некорректный ответ службы маршрутизации') }; }
				}).catch(err => ({ ok: false, error: (err && err.message) || String(err) })),
				fs.exec(helper, [ 'status' ]).then(res => {
					try { return JSON.parse(res.stdout || '{}'); }
					catch (e) { return { ok: false, error: _('Некорректный ответ статуса маршрута') }; }
				}).catch(err => ({ ok: false, error: (err && err.message) || String(err) }))
			]).then(([info, status]) => {
				S.tgInfo = info;
				S.tgRouteRuntime = status;
				S.tgInfoAt = Date.now();
				renderTelegram();
			});
		}

		function applyTelegramRoute() {
			tgRouteState.textContent = _('Сохраняю настройки и проверяю маршрут…');
			return saveTelegramConfig().then(saved => {
				if (!saved) return null;
				return fs.exec('/usr/libexec/nightfall-telegram-route', [ 'apply' ]).then(res => {
					let result = null;
					try { result = JSON.parse(res.stdout || '{}'); } catch (e) {}
					if (result && result.ok) {
						tgRouteState.textContent = result.mode === 'vpn'
							? _('VPN-маршрут активен: ') + (result.device || result.output || '')
							: result.mode === 'proxy' ? _('Прокси сохранён и готов к проверке.') : _('Используется системный маршрут OpenWrt.');
						tgRouteStatus.textContent = tgRouteState.textContent;
						loadTelegram(true);
						return result;
					}
					tgRouteState.textContent = result && result.error ? result.error : _('Не удалось применить маршрут Telegram.');
					tgRouteStatus.textContent = tgRouteState.textContent;
					return null;
				}).catch(err => {
					tgRouteState.textContent = _('Не удалось запустить маршрутизацию: ') + (err.message || err);
					tgRouteStatus.textContent = tgRouteState.textContent;
					return null;
				});
			});
		}

		const jrnTiles = E('div', { class: 'nfm-tiles t4', style: 'margin-bottom:10px' }, [ [ 'jCnt', _('обрывов за 7 дней') ], [ 'jSum', _('без связи суммарно') ], [ 'jAv', _('доступность') ], [ 'jBoot', _('последняя загрузка') ] ]
			.map(([ k, l ]) => E('div', { class: 'nfm-tile' }, [ l, T[k] = E('b', {}, '–') ])));
		const jrnBox = E('div');
		const spdTiles = E('div', { class: 'nfm-tiles t4', style: 'margin-bottom:10px' }, [ [ 'sLast', _('последний замер') ], [ 'sAvg', _('среднее за 7 дней') ], [ 'sMax', _('максимум') ], [ 'sMin', _('минимум') ] ]
			.map(([ k, l ]) => E('div', { class: 'nfm-tile' }, [ l, T[k] = E('b', {}, '–') ])));
		const spdChart = chart({ height: 180, series: [ { key: 'mbps', cls: 'c-down', fill: .16, label: _('Скорость'), fmt: v => nf1.format(v) + _(' Мбит/с') } ],
			fmtLeft: v => nf0.format(v) + _(' Мбит/с'), fmtRight: () => '' });
		const spdList = E('div', { class: 'nfm-lst', style: 'margin-top:12px' });
		const spdNote = E('div', { class: 'nfm-note-s', style: 'margin-top:8px' });
		const spdSel = E('select', { class: 'nfm-sel', title: _('Автоматический замер'), change: ev => {
			callCfg([ 'set', 'SPEED_HOURS=' + ev.target.value ]).then(r => { if (!(r && r.ok)) ui.addNotification(null, E('p', {}, _('Не сохранено: ') + ((r && r.error) || _('нет ответа'))), 'danger'); S.at.spd = 0; }); } },
			[ [ '0', _('Автозамер выключен') ], [ '1', _('Каждый час') ], [ '3', _('Каждые 3 часа') ], [ '6', _('Каждые 6 часов') ], [ '12', _('Каждые 12 часов') ], [ '24', _('Раз в сутки') ] ].map(([ v, l ]) => E('option', { value: v }, l)));
		const SPEED_PRESETS = [
			[ 'https://speed.cloudflare.com/__down?bytes=25000000', _('Cloudflare (25 МБ на поток)') ],
			[ 'https://mirror.yandex.ru/ubuntu/ls-lR.gz', _('Яндекс.Зеркало (Россия)') ],
			[ 'https://speed.hetzner.de/100MB.bin', _('Hetzner (Германия, 100 МБ на поток)') ],
			[ 'https://proof.ovh.net/files/100Mb.dat', _('OVH (Франция, 100 МБ на поток)') ] ];
		const spdSrc = E('select', { class: 'nfm-sel', title: _('Откуда качать тестовый файл'), change: ev => {
			if (!ev.target.value) { ui.addNotification(null, E('p', {}, _('Свой адрес впишите в поле «Файл для замера скорости» в настройках ниже.')), 'info'); return; }
			callCfg([ 'set', 'SPEED_URL=' + ev.target.value ]).then(r => {
				if (r && r.ok) { if (S.cfg && S.cfg.values) S.cfg.values.SPEED_URL = ev.target.value; if (cfgInputs.SPEED_URL) cfgInputs.SPEED_URL.value = ev.target.value; }
				else ui.addNotification(null, E('p', {}, _('Не сохранено: ') + ((r && r.error) || _('нет ответа'))), 'danger'); }); } },
			SPEED_PRESETS.map(([ v, l ]) => E('option', { value: v }, l)).concat([ E('option', { value: '' }, _('Свой адрес (в настройках)')) ]));
		const spdBtn = E('button', { class: 'nfm-btn', click: () => startSpeed() }, _('Измерить сейчас'));
		const flashBox = E('div');
		const dayBody = E('div', { class: 'nfm-day' }, E('div', { class: 'nfm-empty' }, _('Загружаю…')));
		const wqBody = E('div', { class: 'nfm-wq' });
		const homeBox = E('div', { class: 'nfm-evlist' }), susBox = E('div', { class: 'nfm-evlist' });
		const wbBox = E('div'), wrBox = E('div'), wjBox = E('div', { class: 'nfm-evlist' });
		/* ---- v1.23.0: диапазоны, рекомендации и журнал подключений Wi‑Fi ---- */
		/* ---- «Кто дома» (по Wi‑Fi) и необычная активность (по трафику за дни) ---- */
		function renderDevExtra() {
			const R = S.wq, cl = wifiDisplayRows(), up = m => String(m).toUpperCase();
			const here = {}, via = {};
			for (const c of cl) if (c.mac && !c.proxyStation && (!c.proxy || [ 'REACHABLE', 'DELAY', 'PROBE' ].includes(c.proxyState))) {
				here[up(c.mac)] = true;
				if (c.proxy) via[up(c.mac)] = true;
			}
			const st = {};
			for (const e of (R && R.events) || []) { const m = up(e[1]), o = st[m] = st[m] || { join: 0, leave: 0 }; if (e[2] === 'join') o.join = Math.max(o.join, e[0]); else o.leave = Math.max(o.leave, e[0]); }
			for (const m in here) st[m] = st[m] || { join: 0, leave: 0 };
			const rows = Object.keys(st).map(m => ({ m, home: !!here[m], t: here[m] ? st[m].join : st[m].leave })).sort((a, b) => (b.home - a.home) || (b.t - a.t));
			homeBox.replaceChildren(...(rows.length ? rows.map(x => E('div', { class: 'nfm-ev-i ' + (x.home ? 'ok' : 'info') }, [ E('i'), E('time', {}, x.home ? _('дома') : _('не в сети')),
				E('span', {}, devName(x.m) + (via[x.m] ? _(' · через ретранслятор') : '') + (x.t ? (x.home ? _(' · подключился ') : _(' · ушёл ')) + fmtTs(x.t) : '')) ])) : [ E('div', { class: 'nfm-empty' }, R || S.wifi ? _('Пока нет данных о подключениях по Wi‑Fi.') : _('Загружаю…')) ]));
			/* необычная активность: сегодня заметно больше обычного или устройство отдаёт много больше, чем получает */
			const base = {};
			for (const x of (S.dd && S.dd.rows) || []) { const k = x[4] && x[4] !== '-' ? up(x[4]) : x[1]; const b = base[k] = base[k] || {}; b[x[0]] = (b[x[0]] || 0) + (+x[2]) + (+x[3]); }
			const out = [];
			for (const r of S.devRows || []) {
				if (r.k === 'router' || r.k === 'v6') continue;
				const today = r.dd + r.du, nm = (r.mac && devName(r.mac)) || names[r.ip] || r.ip;
				const b = base[r.mac] || base[r.ip], days = b ? Object.values(b) : [];
				const avg = days.length >= 3 ? days.reduce((a, c) => a + c, 0) / days.length : 0;
				if (avg > 0 && today > 3 * avg && today > 300e6) out.push([ 'warn', nm + _(': сегодня ') + fmtBytes(today) + _(', обычно около ') + fmtBytes(avg) + _(' в день.') ]);
				else if (r.du > 5 * r.dd && r.du > 200e6) out.push([ 'warn', nm + _(': отдано ') + fmtBytes(r.du) + _(', получено только ') + fmtBytes(r.dd) + _('. Это может быть облачная копия камеры или телефона, но стоит убедиться.') ]);
			}
			susBox.replaceChildren(...(out.length ? out.map(o => E('div', { class: 'nfm-ev-i nt warn' }, [ E('i'), E('span', {}, o[1]) ])) : [ E('div', { class: 'nfm-empty' }, S.devRows ? _('Ничего необычного: трафик устройств в пределах их обычного.') : _('Загружаю…')) ]));
		}
		/* Клиенты за ретранслятором: DHCP хранит их собственные MAC,
		 * а ip neigh может показывать MAC промежуточной Wi-Fi-станции.
		 * Не склеиваем такие устройства по proxy MAC — только добавляем отдельные строки,
		 * когда несколько DHCP-клиентов сходятся на одну реально ассоциированную станцию.
		 */
		function wifiDisplayRows() {
			const dv = S.devs || {};
			return monitorBuildWifiDisplayRows(S.wifi || [], hints, dv.neigh || [], dv.leases || []);
		}
		function renderWifiExtra() {
			const cl = wifiDisplayRows(), R = S.wq;
			const bands = {};
			for (const c of cl) { if (c.proxy) continue; const b = c.band || '?'; const e = bands[b] = bands[b] || { n: 0, sum: 0, rate: 0, rn: 0 }; e.n++; if (c.signal) e.sum += c.signal; if (c.rx && c.rx.rate) { e.rate += c.rx.rate; e.rn++; } }
			const bk = Object.keys(bands).sort();
			wbBox.replaceChildren(...(bk.length ? [ E('div', { class: 'nfm-two' }, bk.map(b => { const e = bands[b]; return E('div', { class: 'nfm-tile' }, [ E('div', { class: 'nfm-k' }, BANDS[b] || _('Диапазон не определён')), E('div', { class: 'nfm-v' }, e.n + ' ' + (e.n === 1 ? _('устройство') : _('устройств'))),
				E('div', { class: 'nfm-s' }, _('средний сигнал ') + (e.n ? Math.round(e.sum / e.n) : '–') + _(' дБм') + (e.rn ? _(' · линк ') + nf0.format(e.rate / e.rn / 1000) + _(' Мбит/с') : '')) ]); })) ] : [ E('div', { class: 'nfm-empty' }, S.wifi ? _('Подключённых Wi-Fi клиентов нет') : _('Данные о Wi-Fi недоступны')) ]));
			/* рекомендации */
			const tips = [];
			const by = {};
			const bridgeMacs = new Set(cl.filter(c => c.proxyStation).map(c => String(c.mac).toUpperCase()));
			for (const x of (R && R.rows) || []) { const m = String(x[1]).toLowerCase(), v = +x[2]; if (bridgeMacs.has(m.toUpperCase()) || !isFinite(v)) continue; (by[m] = by[m] || []).push(v); }
			const leaves = {};
			for (const e of (R && R.events) || []) if (e[2] === 'leave' && !bridgeMacs.has(String(e[1]).toUpperCase())) { const k = String(e[1]).toLowerCase(); leaves[k] = (leaves[k] || 0) + 1; }
			for (const m of Object.keys(by)) { const v = by[m], avg = v.reduce((a, b) => a + b, 0) / v.length; if (v.length >= 5 && avg <= -75) tips.push([ 'warn', devName(m) + _(': средний сигнал ') + Math.round(avg) + _(' дБм. Поднесите ближе к роутеру или добавьте точку доступа; если устройство на 2,4 ГГц, проверьте, нет ли помех на канале (карточка ниже).') ]); }
			for (const m of Object.keys(leaves)) if (leaves[m] >= 6) tips.push([ 'warn', devName(m) + ': ' + leaves[m] + _(' отключений за период. Часто виновато энергосбережение Wi‑Fi на устройстве; попробуйте отключить его или включить «Фиксированный MAC» вместо частного.') ]);
			const n24 = (bands['2g'] || {}).n || 0, n5 = (bands['5g'] || {}).n || 0;
			if (n5 && n24 > 2 * n5 + 1) tips.push([ 'info', _('На 2,4 ГГц ') + n24 + _(' устройств, на 5 ГГц ') + n5 + _('. Если часть устройств умеет 5 ГГц, переведите их туда: быстрее и меньше помех.') ]);
			if (!tips.length) tips.push([ 'info', R && (R.rows || []).length ? _('Жалоб нет: сигнал и стабильность у всех клиентов в норме.') : _('Данных пока мало: история сигнала копится с запуска сборщика (в режиме Lite не ведётся).') ]);
			wrBox.replaceChildren(...tips.map(t => E('div', { class: 'nfm-ev-i nt ' + (t[0] === 'warn' ? 'warn' : 'info') }, [ E('i'), E('span', {}, t[1]) ])));
			/* журнал подключений */
			const ev = ((R && R.events) || []).slice(-40).reverse();
			wjBox.replaceChildren(...(ev.length ? ev.map(e => E('div', { class: 'nfm-ev-i ' + (e[2] === 'join' ? 'info' : 'warn') }, [ E('i'), E('time', {}, fmtTs(e[0])), E('span', {}, devName(String(e[1]).toUpperCase()) + (e[2] === 'join' ? _(' подключился') : _(' отключился'))) ])) : [ E('div', { class: 'nfm-empty' }, R ? _('Подключений и отключений пока не было.') : _('Загружаю…')) ]));
		}
		function wqVerdict(c) {
			if (!c || typeof c !== 'object') return _('Нет ответа от роутера. Обновите тему на роутере до последней версии.');
			const devs = c.devs || [], n = devs.reduce((a, d) => a + (+d[1] || 0), 0), ok = devs.reduce((a, d) => a + (+d[2] || 0), 0);
			if (c.hist === '0') return _('Запись истории Wi-Fi выключена: поставьте WIFI_HIST=1 в настройках сборщика (вкладка «История», внизу) и сохраните.');
			if (!c.iwinfo) return _('Роутер не отдаёт данные радиомодулей (нет ubus iwinfo). Проверьте, что Wi-Fi включён, и установите пакет rpcd-mod-iwinfo.');
			if (!devs.length) return _('Радиомодули не найдены: ни один Wi-Fi интерфейс сейчас не включён. Включите Wi-Fi в «Сеть → Беспроводная сеть».');
			if (!n) return _('Wi-Fi работает (') + devs.map(d => d[0]).join(', ') + _('), но сейчас к нему никто не подключён. Подключите телефон, первые точки появятся примерно через минуту. Проводные устройства здесь не учитываются.');
			if (!ok) return _('Клиентов Wi-Fi: ') + n + _(', но уровень сигнала разобрать не удалось. Пришлите это сообщение разработчику: ') + (c.sample || _('пример недоступен'));
			if (c.collector === 0 && (c.age < 0 || c.age > 180)) return _('Клиенты Wi-Fi есть (') + n + _('), но сборщик не работает. Перезапустите его: /etc/init.d/nightfall-collector restart, либо перезагрузите роутер.');
			if (!c.lines) return _('Клиенты Wi-Fi есть (') + n + _('), сигнал читается (') + ok + _('), сборщик работает') + (c.collector ? '' : _(' (данные свежие)')) + _(', но записей в истории нет. Подождите 1–2 минуты и обновите страницу. Если не помогло: /etc/init.d/nightfall-collector restart.');
			return _('Записей в истории: ') + c.lines + _('. Обновите страницу.');
		}

		function renderWq() {
			const R = S.wq;
			if (R === undefined) { wqBody.replaceChildren(E('div', { class: 'nfm-empty' }, _('Загружаю…'))); return; }
			const bridgeMacs = new Set(wifiDisplayRows().filter(c => c.proxyStation).map(c => String(c.mac).toLowerCase()));
			const rows = (R && R.rows || []).filter(x => !bridgeMacs.has(String(x[1]).toLowerCase()));
			if (!rows.length) {
				const verdict = E('div', { class: 'nfm-note-s' });
				const btn = E('button', { type: 'button', class: 'nfm-btn', click: () => {
					btn.disabled = true; verdict.textContent = _('Проверяю…');
					callHistory([ 'wifi-check' ]).then(c => { btn.disabled = false; verdict.textContent = wqVerdict(c); }).catch(() => { btn.disabled = false; verdict.textContent = _('Не удалось выполнить проверку: обновите тему на роутере до последней версии.'); });
				} }, _('Почему пусто? Проверить'));
				wqBody.replaceChildren(E('div', { class: 'nfm-hint' }, _('Данных пока нет: история сигнала копится раз в минуту с запуска сборщика, только для клиентов Wi-Fi.') + ((R && R.info && R.info.wifi_hist === '0') ? _(' Запись истории Wi-Fi выключена в настройках (WIFI_HIST=0).') : '')),
					E('div', { class: 'nfm-row', style: 'display:flex;margin-top:8px;gap:10px;align-items:center;flex-wrap:wrap' }, [ btn, verdict ]));
				return;
			}
			const by = {};
			for (const x of rows) { const m = String(x[1]).toLowerCase(), v = +x[2]; if (!isFinite(v)) continue; const e = by[m] = by[m] || { v: [], last: 0, lastT: 0 }; e.v.push(v); if (x[0] >= e.lastT) { e.lastT = x[0]; e.last = v; } }
			const leaves = {}, from = rows[0][0];
			for (const e of R.events || []) if (e[2] === 'leave' && e[0] >= from) { const k = String(e[1]).toLowerCase(); leaves[k] = (leaves[k] || 0) + 1; }
			const ORD = { bad: 0, mid: 1, ok: 2 };
			const list = Object.keys(by).map(m => {
				const v = by[m].v, avg = v.reduce((a, b) => a + b, 0) / v.length, weak = 100 * v.filter(x => x <= -75).length / v.length, lv = leaves[m] || 0;
				/* оценка: сильный сигнал и без обрывов — хорошо; слабый сигнал или частые отключения — плохо */
				const q = (avg <= -75 || weak >= 40 || lv >= 6) ? 'bad' : (avg <= -65 || weak >= 15 || lv >= 3) ? 'mid' : 'ok';
				return { m, avg, weak, lv, last: by[m].last, q, live: R.now - by[m].lastT < 180 };
			}).sort((a, b) => ORD[a.q] - ORD[b.q] || a.avg - b.avg);
			const QL = { ok: _('хорошо'), mid: _('терпимо'), bad: _('плохо') };
			const nm = m => devName(m);
			wqBody.replaceChildren(
				E('table', { class: 'nfm-table' }, [
					E('thead', {}, E('tr', {}, [ E('th', {}, _('Устройство')), E('th', { class: 'r' }, _('Сейчас')), E('th', { class: 'r' }, _('В среднем')), E('th', { class: 'r' }, _('Слабый')), E('th', { class: 'r' }, _('Отключений')), E('th', {}, _('Оценка')) ])),
					E('tbody', {}, list.map(c => E('tr', { class: 'nfm-click', title: _('Показать сигнал в динамике'), click: () => wifiDialog(c.m, nm(c.m), {}) }, [
						E('td', {}, [ nm(c.m), c.live ? '' : E('span', { class: 'nfm-chip' }, _('не в сети')) ]),
						E('td', { class: 'r' }, c.live ? c.last + _(' дБм') : '–'), E('td', { class: 'r' }, nf0.format(c.avg) + _(' дБм')),
						E('td', { class: 'r' }, nf0.format(c.weak) + '%'), E('td', { class: 'r' }, String(c.lv)),
						E('td', {}, E('span', { class: 'nfm-wq-b ' + c.q }, QL[c.q])) ]))) ]),
				E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, _('Слабый — доля времени с сигналом −75 дБм и ниже. «Плохо»: средний сигнал слабый или частые отключения; обычно помогает поднести устройство ближе или сменить канал. Нажмите строку, чтобы увидеть график.')));
		}
		/* ---- устройство по MAC: имя из DHCP, иначе вид и производитель по MAC ---- */
		const devId = (mac, host) => { try { return mac ? DevId.identify(mac, host || '') : null; } catch (e) { return null; } };
		const devIcon = id => { const i = E('i', { class: 'nfm-dv-i' + (id && id.priv ? ' priv' : '') }); i.innerHTML = DevId.icon(id.kind); return i; };
		const devName = mac => {
			const m = String(mac).toUpperCase(), h = hints[m] || hints[String(mac).toLowerCase()] || {}, id = devId(m, h.name);
			return h.name || (id && id.known ? [ id.label || _('Устройство'), id.vendor && id.vendor !== id.label ? id.vendor : '' ].filter(Boolean).join(' ') : '') || (h.ipaddrs || [])[0] || m;
		};

		/* ---- Сигнал Wi‑Fi по часам: тепловая карта по клиентам ---- */
		const whBody = E('div', { class: 'nfm-wh' });
		const whTabs = E('div', { class: 'nfm-tabs' }, [ [ 'd', _('24 часа') ], [ 'w', _('7 дней') ] ].map(([ k, t ]) =>
			E('button', { class: 'nfm-tab' + (k === 'd' ? ' on' : ''), type: 'button', click: ev => { S.whR = k; for (const b of whTabs.children) b.classList.toggle('on', b === ev.currentTarget); renderWHeat(); } }, t)));
		const WHQ = [ [ -60, 'q0', _('отличный (−60 и выше)') ], [ -67, 'q1', _('хороший (−60…−67)') ], [ -75, 'q2', _('слабоват (−67…−75)') ], [ -200, 'q3', _('плохой (ниже −75)') ] ];
		const whQ = v => WHQ.find(q => v >= q[0]) || WHQ[3];
		function renderWHeat() {
			const R = S.whr;
			if (R === undefined) { whBody.replaceChildren(E('div', { class: 'nfm-empty' }, _('Загружаю…'))); return; }
			const bridgeMacs = new Set(wifiDisplayRows().filter(c => c.proxyStation).map(c => String(c.mac).toLowerCase()));
			const rows = (R && R.rows || []).filter(x => !bridgeMacs.has(String(x[1]).toLowerCase()));
			if (!rows.length) { whBody.replaceChildren(E('div', { class: 'nfm-hint' }, _('Данных пока нет: сборщик записывает средний сигнал каждого клиента раз в час (первые точки появятся через час после запуска) и хранит их на накопителе, если он подключён.') + (R === null ? _(' Обновите тему на роутере до последней версии.') : ''))); return; }
			const week = S.whR === 'w', step = week ? 21600 : 3600, n = week ? 28 : 24, end = R.now;
			const by = {};
			for (const [ ts, mac, v, c ] of rows) {
				const i = Math.floor((end - (ts - 1800)) / step);
				if (i < 0 || i >= n || !isFinite(+v)) continue;
				const e = by[mac] || (by[mac] = { m: mac, s: new Array(n).fill(0), c: new Array(n).fill(0), all: 0, k: 0 });
				const w = Math.max(1, +c || 1);
				e.s[n - 1 - i] += v * w; e.c[n - 1 - i] += w; e.all += v * w; e.k += w;
			}
			const list = Object.values(by).map(e => (e.avg = e.all / e.k, e)).sort((a, b) => a.avg - b.avg).slice(0, 14);
			if (!list.length) { whBody.replaceChildren(E('div', { class: 'nfm-hint' }, _('За этот период записей нет.'))); return; }
			const g = E('div', { class: 'nfm-wh-g', style: '--n:' + n });
			g.appendChild(E('span'));
			for (let c = 0; c < n; c++) {
				const t0 = new Date((end - (n - c) * step) * 1000);
				g.appendChild(E('span', { class: 'nfm-wh-h' }, week ? (t0.getHours() < 6 ? t0.toLocaleDateString(NF_LOC, { weekday: 'short' }) : '') : (t0.getHours() % 3 === 0 ? String(t0.getHours()) : '')));
			}
			for (const e of list) {
				const id = devId(e.m, (hints[e.m.toUpperCase()] || {}).name);
				g.appendChild(E('span', { class: 'nfm-wh-n', title: _('Показать сигнал в динамике · ') + e.m.toUpperCase() + (id && id.hint ? '\n' + id.hint : ''), click: () => wifiDialog(e.m, devName(e.m), {}) }, [ id ? devIcon(id) : '', devName(e.m) ]));
				for (let c = 0; c < n; c++) {
					const t0 = new Date((end - (n - c) * step) * 1000), when = t0.toLocaleString(NF_LOC, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) + (week ? '–' + new Date((end - (n - c - 1) * step) * 1000).toLocaleTimeString(NF_LOC, { hour: '2-digit', minute: '2-digit' }) : '');
					if (!e.c[c]) { g.appendChild(E('span', { class: 'nfm-wh-c', title: when + _(' — не было в сети') })); continue; }
					const v = e.s[c] / e.c[c], q = whQ(v);
					g.appendChild(E('span', { class: 'nfm-wh-c ' + q[1], title: devName(e.m) + ', ' + when + ' — ' + nf0.format(v) + _(' дБм') }));
				}
			}
			whBody.replaceChildren(g,
				E('div', { class: 'nfm-wh-leg' }, WHQ.map(q => E('span', {}, [ E('i', { class: 'nfm-wh-c ' + q[1] }), q[2] ])).concat([ E('span', {}, [ E('i', { class: 'nfm-wh-c' }), _('нет в сети') ]) ])),
				E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, _('Строки — клиенты Wi‑Fi, сверху самые слабые. Столбец — ') + (week ? _('шесть часов') : _('час')) + _(', цвет — средний сигнал. Если устройство стабильно красное, поднесите его ближе или добавьте повторитель; красное только в определённые часы — помеха от соседей или бытовой техники. Нажмите имя, чтобы увидеть минутный график.')));
		}

		/* ---- Wi‑Fi: загруженность каналов ---- */
		const airBody = E('div', { class: 'nfm-air' });
		const airBtn = E('button', { type: 'button', class: 'nfm-btn', click: () => scanAir() }, _('Сканировать эфир'));
		function scanAir() {
			if (S.airBusy) return;
			S.airBusy = true; renderAir();
			callHistory([ 'airscan' ]).then(r => { S.air = r || false; S.airT = Date.now(); }).catch(() => { S.air = false; }).then(() => { S.airBusy = false; renderAir(); });
		}
		const NODFS5 = [ 36, 40, 44, 48, 149, 153, 157, 161, 165 ];
		function airModel(rd, aps) {
			const own = +rd.ch || 0, g = +rd.ghz || 0, band = g ? (g < 3 ? '2g' : g < 5.9 ? '5g' : '6g') : (own && own <= 14 ? '2g' : '5g');
			const nets = aps.filter(a => a[0] === rd.dev && a[2] !== rd.bssid && a[3] > 0).map(a => ({ ssid: a[1], bssid: a[2], ch: +a[3], sig: +a[4] }));
			const w = s => Math.min(1, Math.max(0.08, (s + 92) / 52));
			const chans = band === '2g' ? Array.from({ length: 13 }, (_, i) => i + 1) : Array.from(new Set(NODFS5.concat(own || [], nets.map(x => x.ch)))).sort((a, b) => a - b);
			const col = chans.map(c => {
				let load = 0, k = 0;
				for (const x of nets) {
					const d = Math.abs(x.ch - c), f = band === '2g' ? (d < 5 ? (5 - d) / 5 : 0) : (d === 0 ? 1 : 0);
					if (f > 0) { load += w(x.sig) * f; if (d === 0) k++; }
				}
				return { ch: c, load, k };
			});
			const pool = col.filter(x => band === '2g' ? [ 1, 6, 11 ].includes(x.ch) : NODFS5.includes(x.ch));
			const best = pool.reduce((m, x) => !m || x.load < m.load - 0.05 || (Math.abs(x.load - m.load) <= 0.05 && x.ch === own) ? x : m, null);
			return { band, own, nets, col, best, cur: col.find(x => x.ch === own) || null, ht: rd.ht || '', auto: rd.cfg === 'auto' };
		}
		const airLv = l => l < 0.5 ? 0 : l < 1.5 ? 1 : l < 3 ? 2 : 3;
		function renderAir() {
			airBtn.disabled = !!S.airBusy;
			airBtn.textContent = S.airBusy ? _('Сканирую…') : S.air ? _('Сканировать заново') : _('Сканировать эфир');
			if (S.airBusy) { airBody.replaceChildren(E('div', { class: 'nfm-empty' }, _('Сканирую эфир… это занимает 5–15 секунд.'))); return; }
			if (S.air === undefined) { airBody.replaceChildren(E('div', { class: 'nfm-hint' }, _('Покажет, какие соседние сети мешают вашему Wi‑Fi и какой канал свободнее. Сканирование на несколько секунд отвлекает радиомодуль, поэтому запускается только по кнопке: лучше не во время видеозвонка.')), E('div', { style: 'margin-top:8px' }, airBtn)); return; }
			const R = S.air;
			if (!R || !(R.radios || []).length) { airBody.replaceChildren(E('div', { class: 'nfm-hint' }, R === false ? _('Не удалось выполнить сканирование: обновите тему на роутере до последней версии.') : _('Радиомодули не найдены: включите Wi‑Fi в «Сеть → Беспроводная сеть».')), E('div', { style: 'margin-top:8px' }, airBtn)); return; }
			const secs = R.radios.map(rd => {
				const m = airModel(rd, R.aps || []);
				const mx = Math.max(3, ...m.col.map(x => x.load));
				const bars = E('div', { class: 'nfm-air-bars' }, m.col.map(x => E('div', { class: 'nfm-air-b l' + airLv(x.load) + (x.ch === m.own ? ' own' : ''), title: _('Канал ') + x.ch + _(': сетей на нём ') + x.k + _(', нагрузка ') + nf1.format(x.load) + (x.ch === m.own ? _(' (ваш)') : '') }, E('i', { style: '--h:' + Math.max(3, Math.round(100 * Math.min(x.load, mx) / mx)) + '%' }))));
				const xs = E('div', { class: 'nfm-air-x' }, m.col.map(x => E('span', { class: (x.ch === m.own ? 'own' : '') + (m.best && x.ch === m.best.ch && x.ch !== m.own ? ' best' : '') }, String(x.ch))));
				let verdict;
				if (!m.own) verdict = _('Канал роутера определить не удалось.');
				else if (!m.best) verdict = _('Не хватило данных для рекомендации.');
				else if (m.best.ch === m.own || !m.cur || m.cur.load - m.best.load < 0.4) verdict = [ _('Ваш канал '), E('b', {}, String(m.own)), m.cur && m.cur.load < 0.5 ? _(' свободен: менять ничего не нужно.') : _(' занят не сильнее других: менять канал нет смысла.') ];
				else verdict = [ _('Канал '), E('b', {}, String(m.own)), _(' загружен (сетей на нём: ') + m.cur.k + _(', нагрузка ') + nf1.format(m.cur.load) + _('). Свободнее канал '), E('b', {}, String(m.best.ch)), _(' (нагрузка ') + nf1.format(m.best.load) + _('). Сменить: «Сеть → Беспроводная сеть → Изменить → Канал».') + (m.auto ? _(' Сейчас стоит «auto»: роутер выбирает сам, но не всегда удачно.') : '') ];
				const top = m.nets.slice().sort((a, b) => b.sig - a.sig).slice(0, 8);
				return E('div', { class: 'nfm-air-r' }, [
					E('h4', {}, [ BANDS[m.band] || m.band, E('small', {}, rd.dev + (rd.ssid ? ' · ' + rd.ssid : '') + (m.own ? _(' · канал ') + m.own : '') + (m.ht ? ' · ' + m.ht : '')) ]),
					bars, xs, E('div', { class: 'nfm-air-v' }, verdict),
					top.length ? E('table', { class: 'nfm-table' }, [ E('thead', {}, E('tr', {}, [ E('th', {}, _('Соседняя сеть')), E('th', { class: 'r' }, _('Канал')), E('th', { class: 'r' }, _('Сигнал')) ])),
						E('tbody', {}, top.map(x => E('tr', {}, [ E('td', {}, x.ssid || E('i', {}, _('скрытая сеть'))), E('td', { class: 'r' }, String(x.ch)), E('td', { class: 'r' }, x.sig + _(' дБм')) ]))) ]) : E('div', { class: 'nfm-note-s' }, _('Соседних сетей не найдено.')) ]);
			});
			airBody.replaceChildren(...secs, E('div', { class: 'nfm-note-s' }, _('Нагрузка считается по числу соседних сетей и их силе; на 2,4 ГГц учитывается наложение соседних каналов, поэтому советуются только 1, 6 и 11. На 5 ГГц советуются каналы без радиолокационного режима (DFS). Измерено ') + new Date(S.airT).toLocaleTimeString(NF_LOC, { hour: '2-digit', minute: '2-digit' }) + '. ' + _('Каналы выше 6 ГГц и ширина канала 80/160 МГц в расчёте упрощены.')), E('div', { style: 'margin-top:8px' }, airBtn));
		}
		const heatBody = E('div', { class: 'nfm-heat' });
		const heatTabs = E('div', { class: 'nfm-tabs' }, Object.keys(HEAT).map(k =>
			E('button', { class: 'nfm-tab' + (k === 'cpu' ? ' on' : ''), type: 'button', 'data-k': k, click: ev => { S.heat = k; for (const b of heatTabs.children) b.classList.toggle('on', b === ev.currentTarget); renderHeat(); } }, HEAT[k][0])));
		function renderHeat() {
			const D = S.day, key = S.heat || 'cpu', H = HEAT[key];
			if (!D || !D.h || !D.h.info || !D.h.info.started) { heatBody.replaceChildren(E('div', { class: 'nfm-empty' }, D ? _('Нет данных') : _('Загружаю…'))); return; }
			const sum = [], cnt = [];
			for (let i = 0; i < 168; i++) { sum[i] = 0; cnt[i] = 0; }
			const now = new Date();
			/* подробные данные хранятся 7 суток; всё, что старше, берём из длинной истории (шаг 30 минут), если она уже накопилась */
			const fine = D.h.rows || [], t0 = fine.length ? fine[0][0] : Infinity;
			const old = ((S.lg && S.lg.rows) || []).filter(r => r[0] < t0);
			const all = old.concat(fine), span = all.length ? Math.max(1, Math.round((D.h.now - all[0][0]) / 86400)) : 0;
			for (const r of all) {
				const v = H[1](r); if (v == null || v < 0) continue;
				const d = new Date(r[0] * 1000), i = ((d.getDay() + 6) % 7) * 24 + d.getHours();
				sum[i] += v; cnt[i]++;
			}
			const avg = sum.map((x, i) => cnt[i] ? x / cnt[i] : null);
			const mx = Math.max(0, ...avg.filter(v => v != null)) || 1;
			const days = [ _('Пн'), _('Вт'), _('Ср'), _('Чт'), _('Пт'), _('Сб'), _('Вс') ];
			const grid = E('div', { class: 'nfm-heat-grid' });
			grid.appendChild(E('span'));
			for (let h = 0; h < 24; h++) grid.appendChild(E('span', { class: 'nfm-heat-h' }, h % 3 === 0 ? String(h) : ''));
			for (let d = 0; d < 7; d++) {
				grid.appendChild(E('span', { class: 'nfm-heat-d' + (d === (now.getDay() + 6) % 7 ? ' today' : '') }, days[d]));
				for (let h = 0; h < 24; h++) {
					const v = avg[d * 24 + h];
					grid.appendChild(E('span', { class: 'nfm-heat-c', style: v == null ? '' : `--hv:${Math.round(100 * v / mx)}%`, title: days[d] + ', ' + h + ':00 — ' + (v == null ? _('нет данных') : H[2](v)) }));
				}
			}
			heatBody.replaceChildren(grid, E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, _('Среднее по часам за ') + (span > 7 ? _('последние ') + span + _(' дн.') : _('последние 7 дней')) + _('. Тёмнее — меньше, ярче — больше (максимум ') + H[2](mx) + ').' + (avg.some(v => v == null) ? _(' Пустые клетки — время, за которое истории ещё нет: подробные данные хранятся 7 суток, а длинная история (до ') + ((D.h.info && D.h.info.hist_days) || 30) + _(' суток) копится с момента обновления до v1.14.0 и со временем заполнит карту.') : '')));
		}
		/* ---- Сводка недели: пиковые часы, самое «тяжёлое» устройство, средний пинг ---- */
		const wkBody = E('div', { class: 'nfm-wk' });
		function renderWeek() {
			const D = S.day;
			if (!D || !D.h || !D.h.info || !D.h.info.started) { wkBody.replaceChildren(E('div', { class: 'nfm-empty' }, D ? _('Нет данных') : _('Загружаю…'))); return; }
			const hs = new Array(24).fill(0), hc = new Array(24).fill(0), byDay = {};
			let ps = 0, pc = 0;
			for (const r of D.h.rows || []) {
				const d = new Date(r[0] * 1000), h = d.getHours();
				if (r[4] >= 0 && r[5] >= 0) { hs[h] += trafficBytes(r[4]) + trafficBytes(r[5]); hc[h]++; }
				if (r[7] >= 0) { const ping = trafficBytes(r[7]); ps += ping; pc++; const k = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(), t = byDay[k] || (byDay[k] = [ 0, 0 ]); t[0] += ping; t[1]++; }
			}
			const av = hs.map((x, i) => hc[i] ? x / hc[i] : 0);
			let bi = -1, bv = 0;
			for (let i = 0; i < 24; i++) { const v = av[i] + av[(i + 1) % 24] + av[(i + 2) % 24]; if (v > bv) { bv = v; bi = i; } }
			const hh = h => String(h % 24).padStart(2, '0') + ':00';
			const peak = bi < 0 ? [ '—', _('нет данных о трафике') ] : [ hh(bi) + '–' + hh(bi + 3), _('в среднем ') + (bv / 3 * 8 / 1e6).toFixed(1) + _(' Мбит/с') ];
			/* тяжёлое устройство */
			let heavy = [ '—', _('учёт по приложениям не включён или данных ещё нет') ];
			const A = S.wkA;
			if (A && ((A.hist || []).length || (A.day || []).length)) {
				const t = String(A.today || ''), base = /^\d{8}$/.test(t) ? new Date(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8)) : new Date();
				base.setDate(base.getDate() - 6);
				const from = base.getFullYear() * 10000 + (base.getMonth() + 1) * 100 + base.getDate();
				const top = sumMonitorAppDeviceTraffic(A, from, hints, S.devs && S.devs.neigh, S.wifi, routerIps, S.devs && S.devs.leases).filter(row => row.key !== 'router');
				if (top.length) {
					const name = row => row.mac ? ((hints[row.mac] || hints[row.mac.toLowerCase()] || {}).name || row.ip) : names[row.ip] || row.ip;
					heavy = [ name(top[0]), fmtBytes(top[0].total) + _(' за неделю') + (top[1] ? _(' · дальше ') + fmtBytes(top[1].total) : '') ];
				}
			}
			/* пинг */
			let ping = [ '—', _('нет данных о задержке') ];
			if (pc) {
				const dk = Object.keys(byDay).sort(), worst = dk.reduce((w, k) => (!w || byDay[k][0] / byDay[k][1] > byDay[w][0] / byDay[w][1]) ? k : w, null);
				ping = [ Math.round(ps / pc) + _(' мс'), worst && dk.length > 1 ? _('хуже всего ') + worst.slice(6, 8) + '.' + worst.slice(4, 6) + ' · ' + Math.round(byDay[worst][0] / byDay[worst][1]) + _(' мс') : _('до интернета') ];
			}
			const tile = (ic, t, v, sub) => E('div', { class: 'nfm-wk-t' }, [ E('span', { class: 'nfm-wk-l' }, t), E('b', {}, v), E('span', { class: 'nfm-note-s' }, sub) ]);
			wkBody.replaceChildren(tile('', _('Пик трафика'), peak[0], peak[1]), tile('', _('Самое «тяжёлое» устройство'), heavy[0], heavy[1]), tile('', _('Средний пинг'), ping[0], ping[1]));
		}
		/* ---- Трафик по месяцам: календарь суточных итогов (счётчики WAN, а если они занижены, то сумма по устройствам) ---- */
		const monBody = E('div', { class: 'nfm-mon' });
		const lim = () => { try { return Math.max(0, parseFloat(localStorage.getItem('nfm-limit-gb')) || 0); } catch (e) { return 0; } };
		function renderMon() {
			const T = S.tr; if (!T) { monBody.replaceChildren(E('div', { class: 'nfm-empty' }, _('Загружаю…'))); return; }
			const now = new Date(); if (!S.mon) S.mon = { y: now.getFullYear(), m: now.getMonth() };
			const { y, m } = S.mon, dim = new Date(y, m + 1, 0).getDate(), first = (new Date(y, m, 1).getDay() + 6) % 7;
			const pre = String(y) + String(m + 1).padStart(2, '0'), by = {};
			let rx = 0, tx = 0, mx = 1, days = 0, viaDev = 0;
			for (const r of T.rows || []) if (r[0].indexOf(pre) === 0) { const d = +r[0].slice(6, 8), down = trafficBytes(r[1]), up = trafficBytes(r[2]); by[d] = [ r[0], down, up, r[3] ]; rx += down; tx += up; mx = Math.max(mx, down + up); days++; if (r[3] === 1) viaDev++; }
			const cur = y === now.getFullYear() && m === now.getMonth(), elapsed = cur ? now.getDate() : dim, total = rx + tx;
			const avg = days ? total / Math.max(1, Math.min(days, elapsed)) : 0, fc = cur ? total + avg * (dim - elapsed) : total;
			const step = k => { const d = new Date(y, m + k, 1); S.mon = { y: d.getFullYear(), m: d.getMonth() }; renderMon(); };
			const title = new Date(y, m, 1).toLocaleDateString(NF_LOC, { month: 'long', year: 'numeric' }).replace(/\s*г\.?$/, '');
			const L = lim() * 1073741824;
			const limIn = E('input', { type: 'number', min: '0', step: '10', value: lim() || '', placeholder: _('ГБ'), class: 'nfm-mon-lim', 'aria-label': _('Лимит в месяц, ГБ'),
				change: ev => { try { localStorage.setItem('nfm-limit-gb', String(Math.max(0, +ev.target.value || 0))); } catch (e) {} renderMon(); } });
			const grid = E('div', { class: 'nfm-mon-grid' });
			[ _('Пн'), _('Вт'), _('Ср'), _('Чт'), _('Пт'), _('Сб'), _('Вс') ].forEach(d => grid.appendChild(E('span', { class: 'nfm-mon-w' }, d)));
			for (let i = 0; i < first; i++) grid.appendChild(E('span'));
			for (let d = 1; d <= dim; d++) {
				const r = by[d], v = r ? trafficBytes(r[1]) + trafficBytes(r[2]) : 0;
				grid.appendChild(E('span', Object.assign({ class: 'nfm-mon-d' + (cur && d === now.getDate() ? ' today' : '') + (r ? ' has' : ''), style: r ? `--hv:${Math.max(8, Math.round(100 * v / mx))}%` : '',
					title: r ? _('%s: ↓ %s, ↑ %s%s. Нажмите, чтобы увидеть, кто сколько скачал').format(d, fmtBytes(r[1]), fmtBytes(r[2]), r[3] === 1 ? _(' (по данным устройств)') : '') : _('%s: нет данных').format(d) },
					r ? { role: 'button', tabindex: '0', click: () => dayReport(r[0]), keydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); dayReport(r[0]); } } } : {}), [ E('b', {}, String(d)), E('i', {}, r ? fmtBytes(v) : '') ]));
			}
			const kids = [
				E('div', { class: 'nfm-mon-h' }, [
					E('button', { type: 'button', class: 'nfm-tab', 'aria-label': _('Предыдущий месяц'), click: () => step(-1) }, '‹'),
					E('b', { class: 'nfm-mon-t' }, title),
					E('button', { type: 'button', class: 'nfm-tab', 'aria-label': _('Следующий месяц'), click: () => step(1) }, '›'),
					E('span', { class: 'nfm-spacer' }), E('label', { class: 'nfm-note-s' }, [ _('Лимит, ГБ '), limIn ]) ]),
				E('div', { class: 'nfm-mon-sum' }, [
					E('div', {}, [ E('span', {}, _('Всего')), E('b', {}, fmtBytes(total)) ]),
					E('div', {}, [ E('span', {}, _('↓ принято')), E('b', {}, fmtBytes(rx)) ]),
					E('div', {}, [ E('span', {}, _('↑ отправлено')), E('b', {}, fmtBytes(tx)) ]),
					E('div', {}, [ E('span', {}, _('В день')), E('b', {}, days ? fmtBytes(avg) : '—') ]),
					cur ? E('div', {}, [ E('span', {}, _('Прогноз на месяц')), E('b', {}, days ? '≈ ' + fmtBytes(fc) : '—') ]) : '' ]) ];
			if (L > 0) {
				const pc = Math.min(100, 100 * total / L), pf = 100 * fc / L;
				kids.push(E('div', { class: 'nfm-mon-bar', 'data-lvl': pc >= 100 ? 'bad' : pc >= 80 ? 'mid' : 'ok' }, [ E('i', { style: `width:${pc}%` }) ]),
					E('div', { class: 'nfm-note-s' }, _('Использовано %s%% лимита').format(Math.round(pc)) + (cur && days ? _('; по прогнозу к концу месяца ≈ %s%%').format(Math.round(pf)) + (pf > 100 ? _(' — лимит будет превышен') : '') : '')));
			}
			kids.push(grid);
			if (viaDev) kids.push(E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, _('За ') + viaDev + ' ' + (viaDev === 1 ? _('день') : viaDev < 5 ? _('дня') : _('дней')) + _(' счётчики порта WAN показывали заметно меньше, чем прошло через устройства (аппаратное ускорение пакетов скрывает трафик от порта), поэтому итог взят по данным устройств, без трафика самого роутера. Они совпадают с отчётом по дню (нажмите на день).')));
			if (!T.persist) kids.push(E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, _('Итоги хранятся в памяти и обнулятся при перезагрузке роутера. Чтобы копить месяцы, укажите папку на флешке в настройках сборщика (PERSIST_DIR).')));
			monBody.replaceChildren(...kids);
		}
		/* ---- отчёт за день: кто сколько скачал и отдал (по нажатию на день в календаре) ---- */
		function dayReport(ymd) {
			const dt = new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
			const title = _('Трафик за ') + dt.toLocaleDateString(NF_LOC, { day: 'numeric', month: 'long', year: 'numeric' });
			const body = E('div', { class: 'nfm nfm-dr' }, E('div', { class: 'nfm-empty' }, _('Собираю отчёт…')));
			ui.showModal(title, [ body, E('div', { class: 'button-row' }, [ E('button', { class: 'btn', click: ui.hideModal }, _('Закрыть')) ]) ]);
			const J = a => callHistory(a).catch(() => null);
			Promise.all([ J([ 'devdaily' ]), J([ 'devices' ]), J([ 'devhr' ]) ]).then(([ dd, dv, hr ]) => {
				const norm = normalizeMonitorIp, ipMac = monitorBuildIpMacMap(hints, dv && dv.neigh, S.wifi, dv && dv.leases);
				routerIps.learn(dv && dv.info);
				const ymdOf = d => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
				const nowD = new Date(), today = ymdOf(nowD), yest = ymdOf(new Date(nowD.getTime() - 86400000));
				let src = [], how = '';
				const arch = ((dd && dd.rows) || []).filter(r => r[0] === ymd);
				if (arch.length) { src = arch.map(r => [ r[1], r[2], r[3], r[4] !== '-' ? r[4].toUpperCase() : '' ]); how = _('Итоги за сутки, сохранённые сборщиком.'); }
				else if (ymd === today && dv && dv.day && dv.day.length) { src = dv.day.map(r => [ r[0], r[1], r[2], '' ]); how = _('Сегодняшний день ещё не закончен: цифры растут.'); }
				else if (ymd === yest && dv && dv.yday && dv.yday.length) { src = dv.yday.map(r => [ r[0], r[1], r[2], '' ]); how = _('Итоги за сутки по данным сборщика.'); }
				else {
					const by = {};
					for (const r of (hr && hr.rows) || []) if (ymdOf(new Date(r[0] * 1000)) === ymd) { const e = by[r[1]] || (by[r[1]] = [ r[1], 0, 0, '' ]); e[1] += trafficBytes(r[2]); e[2] += trafficBytes(r[3]); }
					src = Object.values(by);
					if (src.length) how = _('Собрано из почасовых итогов: точность до часа.');
				}
				const acc = {};
				for (const [ ip, rx, tx, mac0 ] of src) {
					const rowMac = String(mac0 || '').toUpperCase(), mac = rowMac && rowMac !== '-' ? rowMac : ipMac[norm(ip)] || '', k = routerIps.has(ip) ? 'router' : mac || (String(ip).indexOf(':') >= 0 ? 'v6' : ip);
					const e = acc[k] || (acc[k] = { k, mac, ip, rx: 0, tx: 0 });
					e.rx += trafficBytes(rx); e.tx += trafficBytes(tx);
				}
				const list = Object.values(acc).sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx));
				const wan = ((S.tr && S.tr.rows) || []).find(r => r[0] === ymd);
				const sumRx = list.reduce((a, e) => a + e.rx, 0), sumTx = list.reduce((a, e) => a + e.tx, 0), mx = Math.max(1, ...list.map(e => e.rx + e.tx));
				const kids = [];
				if (wan) kids.push(E('div', { class: 'nfm-mon-sum' }, [
					E('div', {}, [ E('span', {}, wan[3] === 1 ? _('Всего (по устройствам)') : _('Всего через WAN')), E('b', {}, fmtBytes(trafficBytes(wan[1]) + trafficBytes(wan[2]))) ]),
					E('div', {}, [ E('span', {}, _('↓ принято')), E('b', {}, fmtBytes(trafficBytes(wan[1]))) ]),
					E('div', {}, [ E('span', {}, _('↑ отправлено')), E('b', {}, fmtBytes(trafficBytes(wan[2]))) ]) ]));
				if (!list.length) kids.push(E('div', { class: 'nfm-hint' }, _('По устройствам за этот день данных нет. Подробные итоги по устройствам копятся с версии 1.15 (в архив уходят сутки, закончившиеся после обновления), а почасовых данных хватает примерно на две недели. Чтобы они переживали перезагрузку, подключите накопитель (История → «Накопители»).')));
				else {
					kids.push(E('table', { class: 'nfm-table' }, [
						E('thead', {}, E('tr', {}, [ E('th', {}, _('Устройство')), E('th', { class: 'r' }, _('↓ скачано')), E('th', { class: 'r' }, _('↑ отдано')), E('th', { class: 'r' }, _('Всего')) ])),
						E('tbody', {}, list.slice(0, 40).map(e => {
							const h = e.mac ? (hints[e.mac] || {}) : {}, id = e.mac ? devId(e.mac, h.name) : null;
							const label = e.k === 'router' ? _('Сам роутер (VPN, DNS, обновления)') : e.k === 'v6' ? _('Другие адреса IPv6') : (h.name || (id && id.known ? [ id.label || _('Устройство'), id.vendor && id.vendor !== id.label ? id.vendor : '' ].filter(Boolean).join(' ') : '') || e.ip);
							return E('tr', {}, [
								E('td', {}, [ id ? devIcon(id) : '', label, e.k !== 'router' && e.k !== 'v6' && label !== e.ip ? E('span', { class: 'nfm-chip' }, e.ip) : '',
									E('div', { class: 'nfm-mon-bar', 'data-lvl': 'ok', style: 'margin-top:4px;height:4px' }, E('i', { style: 'width:' + Math.max(2, Math.round(100 * (e.rx + e.tx) / mx)) + '%' })) ]),
								E('td', { class: 'r' }, fmtBytes(e.rx)), E('td', { class: 'r' }, fmtBytes(e.tx)), E('td', { class: 'r' }, E('b', {}, fmtBytes(e.rx + e.tx))) ]);
						})) ]));
					if (list.length > 40) kids.push(E('div', { class: 'nfm-note-s' }, _('Показаны 40 самых активных из ') + list.length + '.'));
					if (list.some(e => e.k === 'router')) kids.push(E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, _('Строка «Сам роутер» (адрес вашего роутера у провайдера) — это трафик самого роутера: прокси или VPN на нём, обновления, DNS. Трафик устройств через такой прокси считается дважды: у устройства и у роутера. Поэтому в «Всего» и в календаре строка не входит.')));
					if (wan && (trafficBytes(wan[1]) + trafficBytes(wan[2])) > (sumRx + sumTx) * 1.15) kids.push(E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, _('Сумма по устройствам (') + fmtBytes(sumRx + sumTx) + _(') меньше счётчика WAN: часть трафика не приписывается устройствам (аппаратное ускорение пакетов, служебный трафик, устройства вне первой сотни записей).')));
				}
				if (how) kids.push(E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, how));
				body.replaceChildren(...kids);
			});
		}
		/* ---- Сравнение периодов: недели и месяцы по суточным итогам WAN ---- */
		const cmpBody = E('div', { class: 'nfm-cmp' });
		const CMP = { w: _('Неделя к прошлой'), m: _('Месяц к прошлому') };
		const cmpTabs = E('div', { class: 'nfm-tabs' }, Object.keys(CMP).map(k =>
			E('button', { class: 'nfm-tab' + (k === 'w' ? ' on' : ''), type: 'button', click: ev => { S.cmp = k; for (const b of cmpTabs.children) b.classList.toggle('on', b === ev.currentTarget); renderCmp(); } }, CMP[k])));
		function renderCmp() {
			const T = S.tr; if (!T) { cmpBody.replaceChildren(E('div', { class: 'nfm-empty' }, _('Загружаю…'))); return; }
			const mode = S.cmp || 'w', by = {};
			for (const r of T.rows || []) by[r[0]] = r;
			const key = d => String(d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate());
			const shift = (d, k) => { const x = new Date(d); x.setDate(x.getDate() + k); return x; };
			const ddmm = d => String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');
			const now = new Date(); now.setHours(12, 0, 0, 0);
			let cur = [], prev = [], hc, hp;
			if (mode === 'w') {
				for (let i = 6; i >= 0; i--) { cur.push(shift(now, -i)); prev.push(shift(now, -i - 7)); }
				hc = [ _('Последние 7 дней'), ddmm(cur[0]) + '–' + ddmm(cur[6]) ]; hp = [ _('Предыдущие 7 дней'), ddmm(prev[0]) + '–' + ddmm(prev[6]) ];
			} else {
				const y = now.getFullYear(), m = now.getMonth(), n = now.getDate(), pm = new Date(y, m - 1, 1, 12), pdim = new Date(y, m, 0).getDate();
				for (let d = 1; d <= n; d++) cur.push(new Date(y, m, d, 12));
				for (let d = 1; d <= Math.min(n, pdim); d++) prev.push(new Date(pm.getFullYear(), pm.getMonth(), d, 12));
				const mn = d => d.toLocaleDateString(NF_LOC, { month: 'long' }), cap = x => x.charAt(0).toUpperCase() + x.slice(1);
				hc = [ cap(mn(cur[0])), '1–' + n + _(' число') ]; hp = [ cap(mn(pm)), '1–' + Math.min(n, pdim) + _(' число') ];
			}
			const agg = list => {
				let rx = 0, tx = 0, n = 0, mx = null;
				for (const d of list) { const r = by[key(d)]; if (!r) continue; n++; rx += r[1]; tx += r[2]; if (!mx || r[1] + r[2] > mx[1]) mx = [ d, r[1] + r[2] ]; }
				return { rx, tx, n, tot: rx + tx, avg: n ? (rx + tx) / n : 0, mx };
			};
			const a = agg(cur), b = agg(prev);
			const chg = (x, y) => {
				if (!b.n || !y) return [ '—', 'eq' ];
				const p = (x - y) / y * 100;
				if (Math.abs(p) < 1) return [ '≈ 0%', 'eq' ];
				return [ (p > 0 ? '↑ +' : '↓ −') + Math.round(Math.abs(p)) + '%', p > 0 ? 'up' : 'dn' ];
			};
			const rows = [ [ _('Всего'), a.tot, b.tot ], [ _('Принято'), a.rx, b.rx ], [ _('Отправлено'), a.tx, b.tx ], [ _('В среднем за день'), a.avg, b.avg ] ];
			const cells = [ E('div', { class: 'h' }, ''), E('div', { class: 'h n' }, [ hc[0], E('small', {}, hc[1]) ]), E('div', { class: 'h n' }, [ hp[0], E('small', {}, hp[1]) ]), E('div', { class: 'h n' }, _('Разница')) ];
			for (const [ t, x, y ] of rows) {
				const c = chg(x, y);
				cells.push(E('div', {}, t), E('div', { class: 'n' }, a.n ? fmtBytes(x) : '—'), E('div', { class: 'n' }, b.n ? fmtBytes(y) : '—'), E('div', { class: 'n ' + c[1] }, c[0]));
			}
			/* качество связи по длинной истории (шаг 30 минут): пинг, потери, пики скорости, нагрузка */
			const L = S.lg && S.lg.rows || [];
			if (L.length) {
				const ck = new Set(cur.map(key)), pk = new Set(prev.map(key));
				const q = set => {
					const o = { n: 0, ping: [], loss: [], cpu: [], temp: [], pk: 0 };
					for (const r of L) {
						if (!set.has(key(new Date(r[0] * 1000)))) continue;
						o.n++;
						if (r[7] >= 0) o.ping.push(r[7]); if (r[8] >= 0) o.loss.push(r[8]); if (r[1] >= 0) o.cpu.push(r[1]); if (r[3] >= 0) o.temp.push(r[3]);
						if (r[10] > o.pk) o.pk = r[10];
					}
					return o;
				};
				const avg = l => l.length ? l.reduce((x, y) => x + y, 0) / l.length : null;
				const qa = q(ck), qb = q(pk);
				const line = (t, x, y, f) => {
					const c = x != null && y != null && y > 0 ? chg(x, y) : [ '—', 'eq' ];
					cells.push(E('div', {}, t), E('div', { class: 'n' }, x != null ? f(x) : '—'), E('div', { class: 'n' }, y != null ? f(y) : '—'), E('div', { class: 'n ' + c[1] }, c[0]));
				};
				cells.push(E('div', { class: 'sec' }, _('Качество связи')), E('div', { class: 'sec' }), E('div', { class: 'sec' }), E('div', { class: 'sec' }));
				line(_('Пинг в среднем'), avg(qa.ping), avg(qb.ping), v => nf0.format(v) + _(' мс'));
				line(_('Потери пакетов'), avg(qa.loss), avg(qb.loss), v => nf1.format(v) + '%');
				line(_('Пик загрузки'), qa.pk || null, qb.pk || null, v => rateText(v));
				line(_('Процессор в среднем'), avg(qa.cpu), avg(qb.cpu), v => nf0.format(v) + '%');
				line(_('Температура в среднем'), avg(qa.temp), avg(qb.temp), v => nf1.format(v) + ' °C');
			}
			const hv = o => o.mx ? ddmm(o.mx[0]) + ' · ' + fmtBytes(o.mx[1]) : '—';
			cells.splice(cells.findIndex(c => c.classList && c.classList.contains('sec')) < 0 ? cells.length : cells.findIndex(c => c.classList && c.classList.contains('sec')), 0, E('div', {}, _('Самый тяжёлый день')), E('div', { class: 'n' }, hv(a)), E('div', { class: 'n' }, hv(b)), E('div', { class: 'n eq' }, ''));
			const note = !a.n ? _('За этот период суточных итогов ещё нет.') : !b.n ? _('За прошлый период данных нет: сборщик ведёт суточные итоги с момента установки, сравнение появится позже.')
				: (a.n < cur.length || b.n < prev.length) ? _('Дней с данными: ') + a.n + _(' из ') + cur.length + _(' и ') + b.n + _(' из ') + prev.length + _('. Итоги считаются только по ним.') : _('Трафик через WAN: принято и отправлено провайдеру. ↑ больше, чем раньше, ↓ меньше.');
			cmpBody.replaceChildren(E('div', { class: 'nfm-cmp-t' }, cells), E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, note));
		}

		/* ---- Экспорт данных в CSV (разделитель «;», кодировка UTF-8 с BOM: открывается в Excel) ---- */
		const expNote = E('span', { class: 'nfm-note-s' });
		function csvText(rows) {
			return '﻿' + rows.map(r => r.map(v => { v = v == null ? '' : String(v); return /[;"\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(';')).join('\r\n') + '\r\n';
		}
		function saveCsv(name, rows) {
			const url = URL.createObjectURL(new Blob([ csvText(rows) ], { type: 'text/csv;charset=utf-8' }));
			const a = E('a', { href: url, download: name, style: 'display:none' });
			document.body.appendChild(a); a.click();
			setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
		}
		const isoD = s => /^\d{8}$/.test(String(s)) ? String(s).slice(0, 4) + '-' + String(s).slice(4, 6) + '-' + String(s).slice(6, 8) : String(s);
		const isoT = ts => { const d = new Date(ts * 1000), z = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds()); };
		const nonneg = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : ''; };
		const stamp = () => isoD(new Date().getFullYear() * 10000 + (new Date().getMonth() + 1) * 100 + new Date().getDate());
		const EXPORTS = [
			[ _('Трафик по дням'), () => {
				const r = S.tr && S.tr.rows; if (!r || !r.length) return null;
				return [ 'nightfall-traffic-' + stamp() + '.csv', [ [ _('Дата'), _('Принято, байт'), _('Отправлено, байт'), _('Всего, байт') ] ].concat(r.map(x => { const d = trafficBytes(x[1]), u = trafficBytes(x[2]); return [ isoD(x[0]), d, u, d + u ]; })) ];
			} ],
			[ _('Приложения'), () => {
				const A = S.wkA; if (!A || !((A.hist || []).length || (A.day || []).length)) return null;
				const nm = {}, map = monitorBuildIpMacMap(hints, S.devs && S.devs.neigh, S.wifi, S.devs && S.devs.leases);
				for (const ip in map) { const h = hints[map[ip]] || hints[map[ip].toLowerCase()] || {}; if (h.name) nm[ip] = h.name; }
				const t = /^\d{8}$/.test(String(A.today || '')) ? isoD(A.today) : stamp();
				const out = [ [ _('Дата'), _('Устройство (IP)'), _('Имя'), _('Приложение'), _('Принято, байт'), _('Отправлено, байт'), _('Маршрут') ] ];
				for (const [ dt, ip, app, route, d, u ] of A.hist || []) out.push([ isoD(dt), ip, nm[ip] || '', app, trafficBytes(d), trafficBytes(u), route ]);
				for (const [ ip, app, route, d, u ] of A.day || []) out.push([ t, ip, nm[ip] || '', app, trafficBytes(d), trafficBytes(u), route ]);
				return [ 'nightfall-apps-' + stamp() + '.csv', out ];
			} ],
			[ _('Графики (выбранный период)'), () => {
				const r = S.hist && S.hist.rows; if (!r || !r.length) return null;
				return [ 'nightfall-metrics-' + stamp() + '.csv', [ [ _('Время'), _('Процессор, %'), _('Память, %'), _('Температура, °C'), _('Загрузка, байт/с'), _('Отдача, байт/с'), _('Пинг до шлюза, мс'), _('Пинг до интернета, мс') ] ]
					.concat(r.map(x => [ isoT(x[0]), nonneg(x[1]), nonneg(x[2]), nonneg(x[3]), nonneg(x[4]), nonneg(x[5]), nonneg(x[6]), nonneg(x[7]) ])) ];
			} ],
			[ _('Журнал обрывов и перезагрузок'), () => {
				const r = S.jrn && S.jrn.rows; if (!r || !r.length) return null;
				return [ 'nightfall-journal-' + stamp() + '.csv', [ [ _('Время'), _('Событие'), _('Длительность, с') ] ].concat(r.slice().sort((a, b) => a[0] - b[0]).map(x => [ isoT(x[0]), x[1] === 'outage' ? _('обрыв интернета') : x[1] === 'boot' ? _('перезагрузка') : x[1], x[2] == null ? '' : x[2] ])) ];
			} ]
		];
		const expBtns = EXPORTS.map(([ label, make ]) => E('button', { type: 'button', class: 'nfm-btn', click: () => {
			let r = null; try { r = make(); } catch (e) { r = null; }
			if (!r) { expNote.textContent = '«' + label + _('»: данных пока нет.'); return; }
			saveCsv(r[0], r[1]); expNote.textContent = _('Сохранён файл ') + r[0] + _(' (записей: ') + (r[1].length - 1) + ').';
		} }, '⬇ ' + label));

		const hist = E('div', { class: 'nfm-history', hidden: true }, [
			histNote,
			E('div', { class: 'nfm-grid' }, [ card([ _('Сводка за день'), E('span', { class: 'nfm-spacer' }), E('span', { class: 'nfm-note-s' }, _('с 00:00 по данным сборщика')) ], dayBody) ]),
			E('div', { class: 'nfm-grid' }, [ card([ _('Сводка недели'), E('span', { class: 'nfm-spacer' }), E('span', { class: 'nfm-note-s' }, _('последние 7 дней')) ], wkBody) ]),
			E('div', { class: 'nfm-grid' }, [ card(_('Трафик по месяцам'), monBody) ]),
			E('div', { class: 'nfm-grid' }, [ card([ _('Сравнение периодов'), E('span', { class: 'nfm-spacer' }), cmpTabs ], cmpBody) ]),
			E('div', { class: 'nfm-grid' }, [ card([ _('Тепловая карта по часам'), E('span', { class: 'nfm-spacer' }), heatTabs ], heatBody) ]),
			E('div', { class: 'nfm-grid' }, [
				card([ _('Процессор, память, температура'), E('span', { class: 'nfm-spacer' }),
					E('span', { class: 'nfm-legend' }, [ legendDot('c-cpu', _('Процессор')), legendDot('c-mem', _('Память')), legendDot('c-temp', _('Температура, °C')), legendDot('c-base', _('как обычно')) ]), rangeTabs ], histMain.el)
			]),
			E('div', { class: 'nfm-grid nfm-g21' }, [
				card([ _('Интернет: задержка'), E('span', { class: 'nfm-spacer' }),
					E('span', { class: 'nfm-legend' }, [ legendDot('c-up', _('до шлюза')), legendDot('c-down', _('до интернета')) ]) ], histPing.el),
				card(_('Качество связи'), E('div', {}, [ pingTiles, E('div', { class: 'nfm-note-s', style: 'margin-top:10px' }, _('Пропуски на графике — моменты, когда ответа не было.')) ]))
			]),
			E('div', { class: 'nfm-grid' }, [
				card([ _('Скорость интернета (WAN)'), E('span', { class: 'nfm-spacer' }),
					E('span', { class: 'nfm-legend' }, [ legendDot('c-down', _('Загрузка')), legendDot('c-up', _('Отдача')) ]) ], histNet.el)
			]),
			E('div', { class: 'nfm-grid' }, [
				card(_('Хранение истории и износ флеш-памяти'), flashBox)
			]),
			E('div', { class: 'nfm-grid' }, [ card([ _('Экспорт данных в CSV'), E('span', { class: 'nfm-spacer' }), E('span', { class: 'nfm-note-s' }, _('открывается в Excel и Google Таблицах')) ], E('div', {}, [ E('div', { class: 'nfm-exp' }, expBtns), E('div', { style: 'margin-top:8px' }, expNote) ])) ]),
			E('div', { class: 'nfm-grid' }, [ card([ _('Накопители'), E('span', { class: 'nfm-spacer' }), E('button', { type: 'button', class: 'nfm-btn', click: () => { dskBody.replaceChildren(E('div', { class: 'nfm-empty' }, _('Ищу накопители…'))); loadDisks(); } }, _('Обновить')) ], E('div', {}, [ dskBody, dskMsg, E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, _('История (графики, трафик по дням и приложениям, журнал) сохраняется на накопитель раз в час и не пропадает при перезагрузке. Флешка не изнашивает память роутера.')) ])) ]),
			E('div', { class: 'nfm-grid' }, [ cfgCard ])
		]);

		/* ---- новые вкладки (v1.21.0): готовые карточки перенесены из «Сети» и «Истории», добавлено недостающее ---- */
		/* ---- единый журнал: события, обрывы и перезагрузки, блокировки; поиск и фильтр ---- */
		const LOGK = [ [ 'all', _('Все') ], [ 'ev', _('События') ], [ 'jr', _('Обрывы и перезагрузки') ], [ 'bl', _('Блокировки') ], [ 'pin', _('Закреплённые') ] ];
		const logQ = E('input', { class: 'nfm-search', type: 'search', placeholder: _('Поиск по журналу…'), 'aria-label': _('Поиск по журналу'), input: () => renderLogTools() });
		const logChips = E('div', { class: 'nfm-tabs', style: 'margin-bottom:10px' }, LOGK.map(([ k, l ]) => E('button', { type: 'button', class: 'nfm-tab' + (k === 'all' ? ' on' : ''), 'data-k': k,
			click: () => { S.logK = k; renderLogTools(); } }, l)));
		const logBox = E('div', { class: 'nfm-evlist' });
		const LOGP = [ [ 0, _('За всё время') ], [ 86400, _('За 24 часа') ], [ 604800, _('За 7 дней') ], [ 2592000, _('За 30 дней') ] ];
		const logPer = E('select', { class: 'nfm-sel', 'aria-label': _('Период'), change: ev => { S.logP = +ev.target.value; renderLogTools(); } }, LOGP.map(([ v, l ]) => E('option', { value: String(v) }, l)));
		let logShown = [];
		const pinLoad = () => { try { return JSON.parse(window.localStorage.getItem('nfm_pins') || '[]'); } catch (e) { return []; } };
		const pinToggle = id => { try { const l = pinLoad(), i = l.indexOf(id); if (i >= 0) l.splice(i, 1); else l.unshift(id); window.localStorage.setItem('nfm_pins', JSON.stringify(l.slice(0, 100))); } catch (e) { /* без закрепления */ } renderLogTools(); };
		const logCsv = E('button', { type: 'button', class: 'nfm-btn', title: _('Скачать показанные записи в файл CSV'), click: () => {
			const q = v => '"' + String(v).replace(/"/g, '""') + '"';
			const txt = '\ufeff' + _('время;тип;событие\n') + logShown.map(x => [ new Date(x.t * 1000).toLocaleString(NF_LOC), ({ ev: _('событие'), jr: _('обрыв/перезагрузка'), bl: _('блокировка') })[x.k] || x.k, trEv(x.txt) ].map(q).join(';')).join('\n');
			const a = E('a', { href: URL.createObjectURL(new Blob([ txt ], { type: 'text/csv;charset=utf-8' })), download: _('nightfall-журнал.csv') }); document.body.appendChild(a); a.click(); a.remove();
		} }, _('Скачать CSV'));
		/* ---- журнал самого роутера (logread): поиск, уровень, служба ---- */
		const rlQ = E('input', { class: 'nfm-search', type: 'search', placeholder: _('Поиск по журналу роутера…'), 'aria-label': _('Поиск по журналу роутера'), input: () => { S.rlLimit = 300; renderRouterLog(); } });
		const rlSvc = E('select', { class: 'nfm-sel', 'aria-label': _('Служба'), change: () => { S.rlLimit = 300; renderRouterLog(); } }, E('option', { value: '' }, _('Все службы')));
		const RLV = [ [ 'all', _('Все') ], [ 'warn', _('Предупреждения и ошибки') ], [ 'err', _('Только ошибки') ], [ 'info', _('Информация') ], [ 'debug', _('Отладка') ] ];
		const rlChipRefs = {};
		const rlChips = E('div', { class: 'nfm-tabs nfm-log-tabs', style: 'margin-bottom:8px' }, RLV.map(([ k, l ]) => {
			const count = E('span', { class: 'nfm-log-tab-count' }, '0');
			const button = E('button', { type: 'button', class: 'nfm-tab' + (k === 'all' ? ' on' : ''), 'data-k': k, click: () => { S.rlK = k; S.rlLimit = 300; renderRouterLog(); } }, [ l, count ]);
			rlChipRefs[k] = { button, count };
			return button;
		}));
		let rlVisible = [];
		const rlSummary = E('div', { class: 'nfm-log-summary' });
		const rlDiag = E('div', { class: 'nfm-log-diagnostics' });
		const rlStatus = E('span', { class: 'nfm-log-status' }, _('Загрузка журнала…'));
		const rlAutoBtn = E('button', { type: 'button', class: 'nfm-btn', title: _('Автоматически получать новые записи каждые 20 секунд'), click: () => {
				S.rlAuto = S.rlAuto === false;
				setRouterLogAutoLabel();
				if (S.rlAuto) refreshRouterLog();
			} }, _('Автообновление: вкл'));
		const rlRefreshBtn = E('button', { type: 'button', class: 'nfm-btn', title: _('Получить журнал сейчас'), click: () => refreshRouterLog() }, _('Обновить'));
		const rlCopyBtn = E('button', { type: 'button', class: 'nfm-btn', title: _('Скопировать отфильтрованные записи'), click: () => copyRouterLog() }, _('Копировать'));
		const rlExportBtn = E('button', { type: 'button', class: 'nfm-btn', title: _('Скачать отфильтрованные записи в CSV'), click: () => exportRouterLog() }, _('Экспорт CSV'));
		const rlGroupBtn = E('button', { type: 'button', class: 'nfm-btn', title: _('Объединять одинаковые сообщения'), click: () => { S.rlGrouped = S.rlGrouped === false; renderRouterLog(); } }, _('Повторы: сгруппированы'));
		const rlTools = E('div', { class: 'nfm-log-tools' }, [ rlAutoBtn, rlRefreshBtn, rlCopyBtn, rlExportBtn, rlGroupBtn, rlStatus ]);
		const rlBox = E('div', { class: 'nfm-evlist nfm-rlog' });
		const rlMore = E('div', { class: 'nfm-log-more', hidden: '' }, E('button', { type: 'button', class: 'nfm-btn', click: () => { S.rlLimit = (S.rlLimit || 300) + 300; renderRouterLog(); } }, _('Показать ещё')));
		const MONRU = { Jan: _('янв.'), Feb: _('февр.'), Mar: _('мар.'), Apr: _('апр.'), May: _('мая'), Jun: _('июн.'), Jul: _('июл.'), Aug: _('авг.'), Sep: _('сент.'), Oct: _('окт.'), Nov: _('нояб.'), Dec: _('дек.') };
		const wifiTab = E('div', { hidden: true }, [
			E('div', { class: 'nfm-grid' }, [
				card([ _('Wi-Fi клиенты'), E('span', { class: 'nfm-spacer' }), E('span', { class: 'nfm-note-s' }, _('нажмите на строку — график сигнала · скорость — согласованная, не текущий трафик')) ],
					E('table', { class: 'nfm-table' }, [
						E('thead', {}, E('tr', {}, [ E('th', {}, _('Устройство')), E('th', {}, _('Сеть')), E('th', {}, _('Сигнал')),
							E('th', { class: 'r' }, _('↓ линк')), E('th', { class: 'r' }, _('↑ линк')), E('th', { class: 'r' }, _('В сети')) ])), wifiBody ]))
			]),
			E('div', { class: 'nfm-grid' }, [ card(_('Диапазоны: 2,4 и 5 ГГц'), wbBox) ]),
			E('div', { class: 'nfm-grid' }, [ card(_('Рекомендации'), wrBox) ]),
			E('div', { class: 'nfm-grid' }, [ card(_('Качество Wi‑Fi по клиентам'), wqBody) ]),
			E('div', { class: 'nfm-grid' }, [ card(_('Подключения и отключения'), wjBox) ]),
			E('div', { class: 'nfm-grid' }, [ card([ _('Сигнал Wi‑Fi по часам'), E('span', { class: 'nfm-spacer' }), whTabs ], whBody) ]),
			E('div', { class: 'nfm-grid' }, [ card([ _('Wi‑Fi: загруженность каналов'), E('span', { class: 'nfm-spacer' }) ], airBody) ]),
		]);
		const appTrafficBody = E('div', { class: 'nfm-app-traffic' }, E('div', { class: 'nfm-empty' }, _('Собираю статистику приложений…')));
		const appPeriod = E('select', { class: 'nfm-sel', 'aria-label': _('Период статистики приложений'), change: ev => { S.appPeriod = ev.target.value; renderAppTraffic(); } }, [
			E('option', { value: 'day' }, _('Сегодня')), E('option', { value: '7' }, _('7 дней')), E('option', { value: '30' }, _('30 дней'))
		]);
		const appDevice = E('select', { class: 'nfm-sel', 'aria-label': _('Устройство для статистики приложений'), change: ev => { S.appDevice = ev.target.value; renderAppTraffic(); } }, E('option', { value: '' }, _('Все устройства')));
		let appRenderedData = null, appRenderedPeriod = null, appRenderedDevice = null;
		function renderAppTraffic() {
			const d = S.appTraffic;
			if (d === undefined) { appTrafficBody.replaceChildren(E('div', { class: 'nfm-empty' }, _('Загружаю статистику приложений…'))); return; }
			if (!d || typeof d.enabled === 'undefined') { appTrafficBody.replaceChildren(E('div', { class: 'nfm-empty' }, _('Не удалось получить статистику. Проверьте, что сборщик Nightfall запущен.'))); return; }
			if (d.lite) { appTrafficBody.replaceChildren(E('div', { class: 'nfm-empty' }, [ E('b', {}, _('Учёт приложений недоступен в режиме Lite')), E('span', {}, _('Для экономии ресурсов режим Lite отключает DNS-журнал и разбор трафика по приложениям. Переключите монитор в режим «Мощный», если роутер справляется с нагрузкой.')) ])); return; }
			if (!d.enabled) { appTrafficBody.replaceChildren(E('div', { class: 'nfm-empty' }, [ E('b', {}, _('Учёт трафика по приложениям выключен')), E('span', {}, _('Включите его в настройках монитора: История → Настройки → «Учёт трафика по приложениям». После включения потребуется время, чтобы накопить DNS-сопоставления.')) ])); return; }
			if (d === appRenderedData && S.appPeriod === appRenderedPeriod && S.appDevice === appRenderedDevice) return;
			const periodDays = S.appPeriod === '30' ? 30 : S.appPeriod === '7' ? 7 : 1;
			const ips = Array.from(new Set([ ...(d.day || []).map(r => r[0]), ...(d.hist || []).map(r => r[1]) ])).filter(Boolean).sort();
			/* Группировка адресов использует тот же resolver, что трафик устройств,
			 * дневной отчёт и карточки. Неоднозначные DHCP/ARP записи не склеиваются. */
			const ipMac = monitorBuildIpMacMap(hints, S.devs && S.devs.neigh, S.wifi, S.devs && S.devs.leases);
			const deviceGroups = {};
			for (const addr of ips) {
				const macValue = ipMac[normalizeMonitorIp(addr)] || '';
				const hint = macValue ? hints[macValue] || hints[macValue.toLowerCase()] || {} : {};
				const knownIps = new Set((hint.ipaddrs || []).concat(hint.ip6addrs || []).map(normalizeMonitorIp));
				/* Для одиночного IP сохраняем старый value select: это совместимо
				 * с сохранённым выбором и существующими сценариями LuCI. */
				const key = macValue && knownIps.size > 1 ? 'mac:' + macValue : addr;
				const group = deviceGroups[key] || (deviceGroups[key] = { key, mac: macValue, ips: new Set(), label: '' });
				group.ips.add(normalizeMonitorIp(addr));
				group.label = hint.name || names[addr] || group.label || addr;
			}
			const options = Object.values(deviceGroups).sort((a, b) => a.label.localeCompare(b.label, NF_LOC));
			if (!options.some(group => group.key === S.appDevice)) {
				const legacy = options.find(group => group.ips.has(normalizeMonitorIp(S.appDevice || '')));
				S.appDevice = legacy ? legacy.key : '';
			}
			appDevice.replaceChildren(E('option', { value: '' }, _('Все устройства')), ...options.map(group =>
				E('option', { value: group.key }, group.label + (group.ips.size > 1 ? ' · ' + group.ips.size + _(' адреса') : ' · ' + Array.from(group.ips)[0]))
			));
			appDevice.value = S.appDevice;
			appPeriod.value = S.appPeriod;
			appRenderedData = d; appRenderedPeriod = S.appPeriod; appRenderedDevice = S.appDevice;
			const selectedGroup = options.find(group => group.key === S.appDevice);
			const result = sumMonitorAppTraffic(d, periodDays, selectedGroup ? selectedGroup.ips : '');
			const total = result.total, fmtShare = n => total ? nf1.format(n / total * 100) + '%' : '0%';
			const summary = E('div', { class: 'nfm-tiles t4 nfm-app-summary' }, [
				[ _('Всего трафика'), total, 'c-cpu' ], [ 'VPN', result.routes.VPN, 'c-mem' ], [ _('Напрямую'), result.routes.Direct, 'c-temp' ], [ _('Неизвестный маршрут'), result.routes.Unknown, 'gx' ]
			].map(x => E('div', { class: 'nfm-tile' }, [ x[0], E('b', {}, fmtBytes(x[1])), E('small', { class: 'nfm-note-s' }, fmtShare(x[1])) ])));
			const appPalette = [ 'var(--c-cpu)', 'var(--c-mem)', 'var(--c-temp)', 'var(--c-down)', 'var(--c-up)', 'var(--c-flash)', 'var(--gx)' ];
			const catRows = result.categories.map((c, i) => {
				const apps = Object.values(c.apps).sort((a, b) => b.total - a.total);
				const color = appPalette[i % appPalette.length];
				const share = total ? c.total / total * 100 : 0;
				const details = E('details', { class: 'nfm-app-category', style: '--nfm-app-color:' + color }, [
					E('summary', {}, [
						E('span', { class: 'nfm-app-category-icon', 'aria-hidden': 'true' }),
						E('span', { class: 'nfm-app-category-name' }, _(c.name)),
						E('span', { class: 'nfm-app-category-bar', 'aria-hidden': 'true' }, E('i', { style: 'width:' + share.toFixed(2) + '%' })),
						E('b', {}, fmtBytes(c.total)), E('small', {}, fmtShare(c.total))
					]),
					E('div', { class: 'nfm-app-category-items' }, apps.map(a => E('div', { class: 'nfm-app-item' }, [
						E('span', { class: 'nfm-app-item-name' }, appTrafficDisplayName(a.name)),
						E('span', { class: 'nfm-app-item-route' }, [ 'VPN', 'Direct', 'Unknown' ].filter(k => a.routes[k] > 0).map(k => E('small', { class: 'nfm-chip', title: (k === 'VPN' ? 'VPN' : k === 'Direct' ? _('Напрямую') : _('Неизвестный маршрут')) + ': ' + fmtBytes(a.routes[k]) }, (k === 'VPN' ? 'VPN' : k === 'Direct' ? _('Напрямую') : _('Неизв.')) + ' ' + fmtBytes(a.routes[k])))),
						E('b', {}, fmtBytes(a.total))
					])))
				]);
				return details;
			});
			let donutOffset = 0;
			const donutStops = result.categories.map((c, i) => {
				const from = donutOffset;
				donutOffset += total ? c.total / total * 100 : 0;
				return appPalette[i % appPalette.length] + ' ' + from.toFixed(2) + '% ' + donutOffset.toFixed(2) + '%';
			});
			const donut = E('div', { class: 'nfm-app-donut', style: 'background:' + (total ? 'conic-gradient(' + donutStops.join(',') + ')' : 'var(--nfm-card2)') },
				E('div', { class: 'nfm-app-donut-center' }, [ E('b', {}, fmtBytes(total)), E('small', {}, _('Всего')) ]));
			const legendRows = result.categories.map((c, i) => E('div', { class: 'nfm-app-legend-row' }, [
				E('i', { class: 'nfm-app-legend-dot', style: '--nfm-app-color:' + appPalette[i % appPalette.length] }),
				E('span', {}, _(c.name)), E('b', {}, fmtShare(c.total)), E('small', { class: 'nfm-app-legend-size' }, fmtBytes(c.total))
			]));
			const primaryLegend = E('div', { class: 'nfm-app-legend' }, legendRows.slice(0, 6));
			const remaining = legendRows.slice(6);
			const remainingTotal = result.categories.slice(6).reduce((sum, c) => sum + c.total, 0);
			if (remaining.length) primaryLegend.appendChild(E('details', { class: 'nfm-app-legend-more' }, [
				E('summary', {}, [ E('span', {}, _('Прочие (') + remaining.length + _(' категорий)')), E('span', {}, fmtBytes(remainingTotal)) ]),
				E('div', { class: 'nfm-app-legend' }, remaining)
			]));
			const donutBox = E('div', { class: 'nfm-app-distribution' }, [ donut, primaryLegend ]);
			const top = result.apps.slice(0, 30);
			const unknown = result.apps.filter(a => a.category === 'Не определено').slice(0, 12);
			const unknownBox = E('div', { class: 'nfm-app-unknown-list' }, unknown.length ? unknown.map(a => E('div', { class: 'nfm-host' }, [
				E('span', {}, appTrafficDisplayName(a.name)),
				E('b', {}, fmtBytes(a.total)),
				E('small', {}, [ 'VPN', 'Direct', 'Unknown' ].filter(k => a.routes[k] > 0).map(k => (k === 'VPN' ? 'VPN' : k === 'Direct' ? _('Напрямую') : _('Неизв.')) + ': ' + fmtBytes(a.routes[k])).join(' · '))
			])) : [ E('div', { class: 'nfm-empty' }, _('Нераспознанных записей пока нет.')) ]);
			const appsBox = E('div', { class: 'nfm-app-top-list' }, top.length ? top.map(a => E('div', { class: 'nfm-host' }, [
				E('span', {}, [ appTrafficDisplayName(a.name), E('small', {}, _(a.category)) ]),
				E('b', {}, fmtBytes(a.total)),
				E('div', { class: 'nfm-bar' }, E('div', { class: 'nfm-bar-fill ' + (a.category === 'Не определено' ? 'gx' : 'c-cpu'), style: 'width:' + (a.total / Math.max(1, top[0].total) * 100).toFixed(1) + '%' }))
			])) : [ E('div', { class: 'nfm-empty' }, _('За выбранный период трафик ещё не накоплен.')) ]);
			appTrafficBody.replaceChildren(
				E('div', { class: 'nfm-app-toolbar' }, [ appPeriod, appDevice ]),
				summary,
				E('div', { class: 'nfm-grid' }, [
					card(_('Распределение по категориям'), donutBox)
				]),
				E('div', { class: 'nfm-grid' }, [
					card(_('Трафик по категориям'), E('div', { class: 'nfm-app-categories' }, catRows.length ? catRows : [ E('div', { class: 'nfm-empty' }, _('Нет данных по категориям.')) ]))
				]),
				E('div', { class: 'nfm-grid nfm-g21' }, [
					card(_('Топ приложений и доменов'), appsBox),
					card([ _('Не распознано'), E('span', { class: 'nfm-note-s' }, unknown.length ? _('Первые 12 записей · без ложной атрибуции') : _('Проверка неизвестного трафика')) ], unknownBox)
				]),
				E('div', { class: 'nfm-note-s' }, _('Категории строятся по распознанным именам сервисов. Общие CDN, IP без DNS-имени и неоднозначные домены не приписываются приложениям. VPN / Direct / неизвестный маршрут учитываются независимо от категории.'))
			);
		}
		const appsTab = E('div', { hidden: true }, [
			E('div', { class: 'nfm-grid' }, [ card([ _('Трафик приложений'), E('span', { class: 'nfm-spacer' }), E('span', { class: 'nfm-note-s' }, _('Обновление данных раз в 30 секунд')) ], appTrafficBody) ])
		]);
		const devsTab = E('div', { hidden: true }, [
			E('div', { class: 'nfm-grid nfm-g21' }, [ card([ _('Кто дома'), E('span', { class: 'nfm-note-s' }, _('по подключениям к Wi‑Fi')) ], homeBox), card(_('Необычная активность'), susBox) ]),
			E('div', { class: 'nfm-grid' }, [
				card([ _('Трафик по устройствам'), E('span', { class: 'nfm-spacer' }), T.devTotal = E('span', { class: 'nfm-note-s' }), devSel ], E('div', {}, [
					devNote,
					E('table', { class: 'nfm-table' }, [
						E('thead', {}, E('tr', {}, [ E('th', {}, _('Устройство')), E('th', { class: 'r' }, _('↓ сейчас')), E('th', { class: 'r' }, _('↑ сейчас')),
							E('th', { class: 'r' }, _('↓ за день')), E('th', { class: 'r' }, _('↑ за день')) ])), devBody ]) ]))
			]),
		]);
		const logTab = E('div', { hidden: true }, [
			E('div', { class: 'nfm-grid' }, [ card([ _('Журнал событий'), E('span', { class: 'nfm-spacer' }), logPer, logCsv, logQ ], E('div', {}, [ logChips, logBox ])) ]),
			E('div', { class: 'nfm-grid' }, [ card(_('Журнал перезагрузок и обрывов связи'), E('div', {}, [ jrnTiles, jrnBox ])) ]),
			E('div', { class: 'nfm-grid' }, [ card([ _('Журнал роутера'), E('span', { class: 'nfm-spacer' }), rlSvc, rlQ ], E('div', {}, [ rlChips, rlSummary, rlDiag, rlTools, rlBox, rlMore ])) ])
		]);
		const diagTab = E('div', { hidden: true }, [
			E('div', { class: 'nfm-grid' }, [ card(_('Диагностика сети'), diagBody) ]),
			E('div', { class: 'nfm-grid' }, [ card(_('История проверок'), diagHistBox) ]),
			E('div', { class: 'nfm-grid' }, [ card([ _('Скорость интернета (замеры роутера)'), E('span', { class: 'nfm-spacer' }), spdSrc, spdSel, spdBtn ], E('div', {}, [ spdTiles, spdChart.el, spdList, spdNote ])) ]),
		]);
		const secTiles = E('div', { class: 'nfm-tiles t4' }, [ [ 'sFail', _('неудачных входов') ], [ 'sNew', _('новых за неделю') ], [ 'sOpen', _('портов открыто для сети') ], [ 'sFw', _('пробросов из интернета') ] ]
			.map(([ k, l ]) => E('div', { class: 'nfm-tile' }, [ l, T[k] = E('b', {}, '–') ])));
		const secVerdict = E('div', { class: 'nfm-hint' }, _('Собираю данные…'));
		const secLogins = E('div'), secPorts = E('div'), secDev = E('div'), secUpd = E('div'), secBans = E('div'), secChecks = E('div');
		const secTab = E('div', { hidden: true }, [
			E('div', { class: 'nfm-grid' }, [ card(_('Сводка безопасности'), E('div', {}, [ secVerdict, secTiles ])) ]),
			E('div', { class: 'nfm-grid nfm-g21' }, [ card(_('Попытки входа (LuCI и SSH)'), secLogins), card(_('Обновления'), secUpd) ]),
			E('div', { class: 'nfm-grid nfm-g21' }, [ card(_('Открытые порты роутера'), secPorts), card(_('Новые устройства'), secDev) ]),
			E('div', { class: 'nfm-grid' }, [ card(_('Проверки настроек'), secChecks) ]),
			E('div', { class: 'nfm-grid' }, [ card(_('Закрытые адреса'), secBans) ])
		]);

		const modeBadge = E('span', { class: 'nfm-mode', hidden: true });
		const setMode = r => {
			if (!r || (r.mode !== 'lite' && r.mode !== 'full')) { modeBadge.hidden = true; return; }
			const lite = r.mode === 'lite';
			modeBadge.hidden = false;
			modeBadge.className = 'nfm-mode' + (lite ? ' lite' : '');
			modeBadge.textContent = _('Режим: ') + (lite ? 'Lite' : _('Мощный')) + (+r.step ? _(' · опрос раз в ') + r.step + _(' с') : '');
			modeBadge.title = lite ? _('Lite для слабых роутеров: опрос раз в минуту, без учёта по приложениям и истории Wi‑Fi. Меняется в настройках ниже (LITE).') : _('Мощный режим: опрос каждые 15 секунд, доступны все функции. Для слабого роутера включите Lite в настройках ниже (LITE).');
		};
		const pill = E('span', { class: 'nfm-pill' }, _('обновляется каждые %s с').format(INTERVAL));
		const pauseBtn = E('button', { class: 'nfm-btn', click: () => setPaused(!S.paused) }, _('Пауза'));
		const onTab = (...k) => k.indexOf(S.tab) >= 0;
		const TAB_KEYS = [ 'overview', 'net', 'wifi', 'devs', 'apps', 'procs', 'svcs', 'diag', 'sec', 'log', 'hist', 'tg' ];
		const tabBtns = {};
		const tabs = E('div', { class: 'nfm-tabs', role: 'tablist' }, [ [ 'overview', _('Обзор') ], [ 'net', _('Сеть') ], [ 'wifi', 'Wi‑Fi' ], [ 'devs', _('Устройства') ], [ 'apps', _('Трафик') ], [ 'procs', _('Программы') ], [ 'svcs', _('Службы') ], [ 'diag', _('Диагностика') ], [ 'sec', _('Безопасность') ], [ 'log', _('Журнал') ], [ 'hist', _('История') ], [ 'tg', 'TG Bot' ] ]
			.map(([ k, l ]) => tabBtns[k] = E('button', { class: 'nfm-tab nfm-ti', 'data-ic': k, role: 'tab', click: () => { S.tab = k; refresh(); } }, l)));

		const svcFilter = E('input', { class: 'nfm-in', type: 'search', placeholder: _('Найти службу…'), input: () => renderServices() });
		const svcBox = E('div');
		const svcMore = E('div');
		const svcs = E('div', { hidden: true }, [
			E('div', { class: 'nfm-grid' }, [ card([ _('Состояние служб'), E('span', { class: 'nfm-spacer' }), svcFilter ], E('div', {}, [ svcBox,
				E('div', { class: 'nfm-note-s', style: 'margin-top:10px' }, _('Красным отмечены службы, которые включены в автозапуск, но сейчас не работают. Ключевые службы (сеть, веб-сервер, SSH, файрвол) нельзя остановить отсюда, чтобы не потерять доступ.')) ])) ]),
			E('div', { class: 'nfm-grid' }, [ svcMore ])
		]);
		{ const hv = (window.location.hash || '').replace('#', ''); if (TAB_KEYS.includes(hv)) S.tab = hv; }
		const root = E('div', { class: 'nfm' }, [
			E('style', {}, CSS + XCSS),
			E('div', { class: 'nfm-top' }, [
				E('div', {}, [ E('h2', {}, _('Монитор ресурсов')),
					E('div', { class: 'nfm-sub' }, [ (board.model || board.hostname || 'OpenWrt') + _(' · работает '), t('uptime') ]) ]),
				E('span', { class: 'nfm-spacer' }), modeBadge, pill, pauseBtn, tabs ]),
			overview, net, wifiTab, devsTab, appsTab, procs, svcs, diagTab, secTab, logTab, hist, tgTab
		]);

		/* host-theme dark/light adaptation: re-check after insertion, on theme
		   attribute toggles and on system scheme changes */
		requestAnimationFrame(() => {
			nfmApplyTheme(root);
			new MutationObserver(() => nfmApplyTheme(root)).observe(document.documentElement, { attributes: true, attributeFilter: [ 'data-darkmode', 'data-theme', 'class', 'style' ] });
			if (window.matchMedia)
				window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => nfmApplyTheme(root));
		});

		/* ---------- quick actions ---------- */
		function runChecked(fn) {
			return Promise.resolve().then(fn).then(res => {
				if (res && typeof res.code === 'number' && res.code !== 0)
					throw new Error((res.stderr || '').trim() || _('код возврата %s').format(res.code));
				return res;
			});
		}

		function confirmRun(title, text, fn, busy, reboot) {
			ui.showModal(title, [
				E('p', {}, text),
				E('div', { class: 'button-row' }, [
					E('button', { class: 'btn', click: ui.hideModal }, _('Отмена')),
					E('button', { class: 'btn cbi-button-negative important', click: () => {
						ui.showModal(null, [ E('p', { class: 'spinning' }, busy) ]);
						runChecked(fn).then(() => {
							if (reboot) window.setTimeout(() => window.location.reload(), 60000);
							else window.setTimeout(ui.hideModal, 2500);
						}).catch(err => {
							ui.hideModal();
							ui.addNotification(null, E('p', {}, _('Не удалось выполнить: ') + (err.message || err)), 'danger');
						});
					} }, _('Выполнить'))
				])
			]);
		}

		function wakeDialog() {
			const hosts = [];
			for (const mac in hints)
				hosts.push({ mac: mac.toUpperCase(), name: hints[mac].name || (hints[mac].ipaddrs || [])[0] || mac });
			hosts.sort((a, b) => a.name.localeCompare(b.name));

			const sel = E('select', { class: 'nfm-sel', style: 'width:100%' }, [ E('option', { value: '' }, _('— выберите устройство —')) ]
				.concat(hosts.map(h => E('option', { value: h.mac }, `${h.name} (${h.mac})`))));
			const man = E('input', { type: 'text', placeholder: _('или введите MAC-адрес: AA:BB:CC:DD:EE:FF'), style: 'width:100%;margin-top:8px' });

			ui.showModal(_('Разбудить устройство'), [
				E('p', {}, _('Магический пакет будет отправлен в сеть %s. Устройство должно поддерживать Wake-on-LAN.').format(lanDev)),
				sel, man,
				E('div', { class: 'button-row' }, [
					E('button', { class: 'btn', click: ui.hideModal }, _('Отмена')),
					E('button', { class: 'btn cbi-button-positive important', click: () => {
						const mac = (man.value.trim() || sel.value).toUpperCase();
						if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
							ui.addNotification(null, E('p', {}, _('Укажите корректный MAC-адрес.')), 'warning');
							return;
						}
						ui.hideModal();
						runChecked(() => fs.exec('/usr/bin/etherwake', [ '-b', '-i', lanDev, mac ])).then(() => {
							ui.addNotification(null, E('p', {}, _('Пакет пробуждения отправлен: %s').format(mac)), 'success');
						}).catch(err => {
							ui.addNotification(null, E('p', {}, _('Не удалось отправить пакет: ') + (err.message || err) + _('. Нужен пакет etherwake (apk add etherwake).')), 'danger');
						});
					} }, _('Разбудить'))
				])
			]);
		}

		/* Primary path: LuCI's own network model (same data the Overview page uses).
		   Fallback: raw ubus calls. Errors are kept in wifiErr for the empty-state hint. */
		let wifiErr = '';
		const bandOf = (band, ch, ghz) => {
			if (band) return String(band).toLowerCase().replace('2.4g', '2g').replace('5ghz', '5g').replace('2ghz', '2g');
			const g = parseFloat(ghz); if (g) return g < 3 ? '2g' : g < 5.9 ? '5g' : '6g';
			const c = parseInt(ch, 10); if (c) return c <= 14 ? '2g' : '5g';
			return null;
		};
		function fetchWifiModel() {
			return network.getWifiNetworks().then(nets => Promise.all((nets || []).map(n => {
				const ifname = n.getIfname && n.getIfname();
				if (!ifname) return [];
				const dev = n.getWifiDevice ? n.getWifiDevice() : null;
				const band = bandOf(dev && dev.get ? dev.get('band') : null, (n.getChannel && n.getChannel()) || (dev && dev.get ? dev.get('channel') : null), n.getFrequency && n.getFrequency());
				const ssid = (n.getActiveSSID && n.getActiveSSID()) || (n.getSSID && n.getSSID()) || ifname;
				return Promise.resolve(n.getAssocList()).then(list =>
					(list || []).map(c => Object.assign({}, c, { ssid: ssid, band: band })));
			}))).then(lists => [].concat(...lists));
		}

		function fetchWifiRaw() {
			return callWifi().then(st => {
				const ifs = [];
				for (const r in st)
					for (const i of (st[r].interfaces || []))
						if (i.ifname && (!i.config || !i.config.mode || i.config.mode === 'ap'))
							ifs.push({ ifname: i.ifname, ssid: (i.config || {}).ssid || i.ifname, band: bandOf((st[r].config || {}).band, (st[r].config || {}).channel, null) });
				return Promise.all(ifs.map(i => callAssoc(i.ifname).then(list =>
					(list || []).map(c => Object.assign({}, c, { ssid: i.ssid, band: i.band })))));
			}).then(lists => [].concat(...lists));
		}

		function fetchWifi() {
			wifiErr = '';
			return fetchWifiModel().catch(e1 => {
				wifiErr = 'network: ' + (e1 && e1.message || e1);
				return fetchWifiRaw();
			}).catch(e2 => {
				wifiErr += (wifiErr ? '; ' : '') + 'ubus: ' + (e2 && e2.message || e2);
				return null;
			});
		}

		function fmtDur(sec) {
			const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
			return h ? _('%s ч %s мин').format(h, m) : (m ? _('%s мин').format(m) : _('%s с').format(Math.floor(sec)));
		}

		/* Collector event texts are written backend-side in Russian; rebuild the
		   known shapes through catalog templates at display time. Unknown texts
		   pass through unchanged. */
		function trEvDur(s) {
			let m;
			if ((m = /^(\d+) ч (\d+) мин$/.exec(s))) return _('%s ч %s мин').format(m[1], m[2]);
			if ((m = /^(\d+) мин (\d+) с$/.exec(s))) return _('%s мин %s с').format(m[1], m[2]);
			if ((m = /^(\d+) с$/.exec(s))) return _('%s с').format(m[1]);
			return s;
		}

		/* Security audit texts are generated backend-side in Russian with
		   «level|text» prefixes stripped before display; rebuild the known
		   shapes through catalog templates. Unknown texts pass through. */
		function trSec(tx) {
			if (typeof tx !== 'string') return tx;
			let m;
			const exact = {
				'Пароль root задан.': 1, 'Пароль root не задан: зайти в роутер может любой из вашей сети.': 1,
				'SSH: парольный вход root включён (PasswordAuth и RootPasswordAuth). Для защиты отключите парольную аутентификацию и используйте SSH-ключи.': 1,
				'SSH: парольная аутентификация для непривилегированных пользователей разрешена; для root запрещена.': 1,
				'LuCI доступен по http (пароль идёт открытым текстом внутри сети). Включите «Redirect all HTTP to HTTPS».': 1,
				'LuCI: http перенаправляется на https.': 1,
				'Можно закрывать только внешние адреса (не локальные, не адрес самого роутера).': 1,
				'На роутере нет nft: закрытие адресов недоступно.': 1,
				'Некорректный адрес.': 1, 'Не удалось закрыть адрес.': 1, 'Не удалось подготовить правила nft.': 1
			};
			if (exact[tx]) return _(tx);
			if ((m = /^SSH: парольный вход root выключен \((.*)\); вход по ключу остаётся доступен\.$/.exec(tx))) return _('SSH: парольный вход root выключен (%s); вход по ключу остаётся доступен.').format(m[1]);
			if ((m = /^Сеть «(.+)» без пароля: подключиться может любой\.$/.exec(tx))) return _('Сеть «%s» без пароля: подключиться может любой.').format(m[1]);
			if ((m = /^Сеть «(.+)» использует WEP: он взламывается за минуты, включите WPA2 или WPA3\.$/.exec(tx))) return _('Сеть «%s» использует WEP: он взламывается за минуты, включите WPA2 или WPA3.').format(m[1]);
			if ((m = /^Сеть «(.+)»: шифрование (.+)\.$/.exec(tx))) return _('Сеть «%s»: шифрование %s.').format(m[1], m[2]);
			if ((m = /^Сеть «(.+)» допускает устаревшее шифрование \((.+)\): оставьте WPA2 \(psk2\+ccmp\) или WPA3 \(sae\)\.$/.exec(tx))) return _('Сеть «%s» допускает устаревшее шифрование (%s): оставьте WPA2 (psk2+ccmp) или WPA3 (sae).').format(m[1], m[2]);
			if ((m = /^Много неудачных входов в роутер: (\d+) за последнее время \(SSH и LuCI\)\. Откройте «Монитор → Безопасность»: там можно закрыть адрес нарушителя\.$/.exec(tx))) return _('Много неудачных входов в роутер: %s за последнее время (SSH и LuCI). Откройте «Монитор → Безопасность»: там можно закрыть адрес нарушителя.').format(m[1]);
			return tx;
		}

		function trEv(tx) {
			if (typeof tx !== 'string') return tx;
			let m;
			if (tx === 'Сборщик истории запущен') return _('Сборщик истории запущен');
			if (tx === 'Нет доступа в интернет') return _('Нет доступа в интернет');
			if (tx === 'Постоянное хранение Nightfall снова работает') return _('Постоянное хранение Nightfall снова работает');
			if ((m = /^Нет связи со шлюзом (\S+)$/.exec(tx))) return _('Нет связи со шлюзом %s').format(m[1]);
			if ((m = /^Процессор перегрет: ([\d.]+) °C \(порог (\d+) °C\)$/.exec(tx))) return _('Процессор перегрет: %s °C (порог %s °C)').format(m[1], m[2]);
			if ((m = /^Критическая температура процессора: ([\d.]+) °C$/.exec(tx))) return _('Критическая температура процессора: %s °C').format(m[1]);
			if ((m = /^Мало свободной памяти: занято (\d+)%$/.exec(tx))) return _('Мало свободной памяти: занято %s%').format(m[1]);
			if ((m = /^Флеш-память почти заполнена: (\d+)%$/.exec(tx))) return _('Флеш-память почти заполнена: %s%').format(m[1]);
			if ((m = /^Таблица соединений заполнена на (\d+)%$/.exec(tx))) return _('Таблица соединений заполнена на %s%').format(m[1]);
			if ((m = /^Процессор загружен на (\d+)% дольше (\d+) мин$/.exec(tx))) return _('Процессор загружен на %s% дольше %s мин').format(m[1], m[2]);
			if ((m = /^Снова в норме: (.+) \(длилось (\d+.*)\)$/.exec(tx))) return _('Снова в норме: %s (длилось %s)').format(trEv(m[1]), trEvDur(m[2]));
			if ((m = /^Новое устройство в сети: (.+)$/.exec(tx))) {
				let rest = m[1], priv = '';
				const pm = / \(частный адрес Wi-Fi, у телефона он может меняться\)$/.exec(rest);
				if (pm) { priv = ' ' + _('(частный адрес Wi-Fi, у телефона он может меняться)'); rest = rest.slice(0, pm.index); }
				rest = rest.replace(/^без имени,/, _('без имени') + ',');
				return _('Новое устройство в сети:') + ' ' + rest + priv;
			}
			if (/^Сохранение во внутреннюю флеш-память запрещено\./.exec(tx)) return _('Сохранение во внутреннюю флеш-память запрещено. Включите «Разрешить запись во внутреннюю флеш-память» и учитывайте износ и свободное место');
			if ((m = /^Постоянная история недоступна: (\S+) не находится/.exec(tx))) return _('Постоянная история недоступна: %s не находится на подключённом накопителе с разрешённым типом хранения. Сбор данных продолжается в RAM').format(m[1]);
			if ((m = /^Недостаточно свободного места во внутренней флеш-памяти \(нужно не менее (\d+) КБ\)/.exec(tx))) return _('Недостаточно свободного места во внутренней флеш-памяти (нужно не менее %s КБ). История продолжает собираться в RAM').format(m[1]);
			if ((m = /^Роутер загружен(; данных не было (.+))?$/.exec(tx))) return m[2] ? _('Роутер загружен; данных не было %s').format(trEvDur(m[2])) : _('Роутер загружен');
			if (tx === 'нет связи со шлюзом (кабель, модем или провайдер)') return _('нет связи со шлюзом (кабель, модем или провайдер)');
			if (tx === 'шлюз отвечал, нет выхода в интернет (провайдер или DNS)') return _('шлюз отвечал, нет выхода в интернет (провайдер или DNS)');
			return tx;
		}

		function hotInfo() {
			let n = 0, t0 = null, peak = 0;
			for (let i = S.temp.length - 1; i >= 0; i--) {
				const v = S.temp[i];
				if (v == null || v < HOT_WARN) break;
				n++; peak = Math.max(peak, v); t0 = S.times[i];
			}
			if (!n) return null;
			const dur = S.times[S.times.length - 1] - t0;
			return dur >= HOT_SECONDS ? { temp: S.temp[S.temp.length - 1], dur, crit: peak >= HOT_CRIT } : null;
		}

		/* ---------- history collector (nightfall-history) ---------- */
		function callHistory(args) {
			return fs.exec(HIST, args).then(res => {
				try { return JSON.parse(res.stdout); } catch (e) { return false; }
			}).catch(() => false);
		}

		function due(key, sec) {
			const n = Date.now();
			if (n - (S.at[key] || 0) < sec * 1000 - 300) return false;
			S.at[key] = n;
			return true;
		}

		function fetchExtras() {
			const jobs = [];
			if (due('alerts', ALERTS_EVERY * INTERVAL)) jobs.push(callHistory([ 'alerts' ]).then(r => { S.alerts = r; }));
			if (onTab('net', 'devs', 'overview', 'wifi') && due('devs', DEVICES_EVERY * INTERVAL)) jobs.push(callHistory([ 'devices' ]).then(r => { S.devs = r; refreshIdentityNames(); }));
			if (due('mode', 60)) jobs.push(callHistory([ 'mode' ]).then(setMode));
			if (onTab('hist', 'log') && due('hist', HIST_EVERY * INTERVAL)) jobs.push(callHistory([ 'series', RANGES[S.range][0] ]).then(r => { S.hist = r; }));
			if (S.tab === 'hist' && due('tr', 300)) jobs.push(callHistory([ 'traffic' ]).then(r => { S.tr = r; }));
			if (S.tab === 'hist' && due('day', 60)) jobs.push(Promise.all([ callHistory([ 'series', 'coarse' ]), callHistory([ 'devices' ]) ]).then(r => { S.day = { h: r[0], d: r[1] }; }));
			if (S.tab === 'hist' && due('wkA', 300)) jobs.push(callHistory([ 'apps' ]).then(r => { S.wkA = r || null; }));
			if (onTab('hist', 'wifi', 'devs') && due('wq', 60)) jobs.push(callHistory([ 'wifi' ]).then(r => { S.wq = r || null; }));
			if (onTab('hist', 'wifi') && due('whr', 120)) jobs.push(callHistory([ 'wifi-hr' ]).then(r => { S.whr = r || null; }));
			if (S.tab === 'hist' && due('lg', 300)) jobs.push(callHistory([ 'series', 'long' ]).then(r => { S.lg = r || null; }));
			if (S.tab === 'net' && due('chan', DEVICES_EVERY * INTERVAL)) jobs.push(callHistory([ 'channel' ]).then(r => { S.chan = r; }));
			if (S.tab === 'procs' && due('pm', 120)) jobs.push(callHistory([ 'procmem', String(S.pmH || 24) ]).then(r => { S.pm = r || null; }).catch(() => { S.pm = null; }));
			if (S.tab === 'devs' && due('dd', 600)) jobs.push(callHistory([ 'devdaily' ]).then(r => { S.dd = r || null; }).catch(() => { S.dd = null; }));
			if (S.tab === 'apps' && due('appTraffic', 30)) jobs.push(callHistory([ 'apps' ]).then(r => { S.appTraffic = r || null; }).catch(() => { S.appTraffic = null; }));
			if (S.tab === 'net' && due('extip', 120)) jobs.push(callHistory([ 'extip' ]).then(r => { S.extip = r || null; }).catch(() => { S.extip = null; }));
			if (S.tab === 'net' && due('dns', 30)) jobs.push(fs.exec('/usr/libexec/nightfall-dns', [ 'top' ]).then(r => { try { S.dns = JSON.parse(r.stdout); } catch (e) { S.dns = null; } }).catch(() => { S.dns = null; }));
			if (S.tab === 'sec' && due('sec', 60)) jobs.push(fs.exec(SECBIN, [ 'summary' ]).then(r => { try { S.sec = JSON.parse(r.stdout); S.secErr = ''; } catch (e) { S.sec = null; S.secErr = _('ответ скрипта не разобран') + (r.stderr ? ': ' + String(r.stderr).slice(0, 120) : ''); } }).catch(e => { S.sec = null; S.secErr = String((e && e.message) || e).slice(0, 120); }));
			if (S.tab === 'sec' && due('bans', 30)) jobs.push(fs.exec(SECBIN, [ 'bans' ]).then(r => { try { S.bans = JSON.parse(r.stdout); } catch (e) { S.bans = null; } }).catch(() => { S.bans = null; }));
			if (S.tab === 'sec' && due('secu', 600)) jobs.push(fs.exec(SECBIN, [ 'updates' ]).then(r => { try { S.secu = JSON.parse(r.stdout); } catch (e) { S.secu = null; } }).catch(() => { S.secu = null; }));
			if (S.tab === 'log' && (S.rlog === undefined || (S.rlAuto !== false && due('rlog', 20)))) jobs.push(fs.exec('/usr/libexec/nightfall-log', [ 'read', '800' ]).then(r => { try { S.rlog = JSON.parse(r.stdout); S.rlogUpdated = Date.now(); } catch (e) { S.rlog = null; } }).catch(() => { S.rlog = null; }));
			if (S.tab === 'log' && due('blog', 30)) jobs.push(fs.exec('/usr/libexec/nightfall-block', [ 'log' ]).then(r => { try { S.blog = JSON.parse(r.stdout); } catch (e) { S.blog = null; } }).catch(() => { S.blog = null; }));
			if (onTab('hist', 'log') && due('jrn', 30)) jobs.push(callHistory([ 'journal' ]).then(r => { S.jrn = r; }));
			if (onTab('hist', 'diag') && due('spd', S.spdRun ? 3 : 30)) jobs.push(callHistory([ 'speed' ]).then(r => { S.spd = r; if (S.spdRun && Date.now() - (S.spdT || 0) > 4000 && (!r || !r.running)) { S.spdRun = false; if (r === false) ui.addNotification(null, E('p', {}, _('Замер завершён, но результат не прочитан: ') + MISSING), 'danger'); } }));
			if (S.tab === 'svcs' && due('svc', 6)) jobs.push(Promise.all([ L.resolveDefault(callInitList(), null), L.resolveDefault(callServiceList(), null) ]).then(r => { S.svc = { init: r[0], run: r[1] }; }));
			if ((S.tab === 'hist' || S.tab === 'tg') && S.cfg === undefined) { S.cfg = null; jobs.push(callCfg([ 'get' ]).then(r => { S.cfg = r; fillCfg(r && r.values); renderDisks(); })); }
			if (S.tab === 'hist' && S.dsk === undefined) { S.dsk = null; jobs.push(loadDisks()); }
			return Promise.all(jobs);
		}

		const MISSING = _('Сборщик истории не запущен. На роутере выполните: /etc/init.d/nightfall-collector enable && /etc/init.d/nightfall-collector start');

		function callCfg(args) {
			return fs.exec(CFG, args).then(res => {
				try { return JSON.parse(res.stdout); } catch (e) { return false; }
			}).catch(() => false);
		}

		function fillCfg(v) {
			if (!v) { cfgMsg.textContent = _('Настройки недоступны: нужна служба сборщика и обновлённый пакет.'); return; }
			cfgMsg.textContent = '';
			for (const k in cfgInputs) {
				if (cfgBoolKeys.has(k)) cfgInputs[k].checked = String(v[k] == null ? '0' : v[k]) === '1';
				else cfgInputs[k].value = v[k] != null ? v[k] : '';
			}
		}

		function saveCfg() {
			const args = [ 'set' ].concat(Object.keys(cfgInputs).filter(k => !k.startsWith('TG')).map(k => k + '=' + (cfgBoolKeys.has(k) ? (cfgInputs[k].checked ? '1' : '0') : cfgInputs[k].value.trim())));
			callCfg(args).then(r => {
				if (r && r.ok) {
					cfgMsg.textContent = _('Сохранено, сборщик перезапущен.');
					S.at.alerts = 0; S.at.hist = 0;
					callCfg([ 'get' ]).then(c => { S.cfg = c; if (c) fillCfg(c.values); cfgMsg.textContent = _('Сохранено, сборщик перезапущен.'); });
					window.setTimeout(() => { cfgMsg.textContent = ''; }, 5000);
				}
				else ui.addNotification(null, E('p', {}, _('Не сохранено: ') + ((r && r.error) || _('нет ответа от nightfall-config'))), 'danger');
			});
		}

		function buildDiag(hd, cfg) {
			const d = S.last || {}, out = [], h = hd || {}, info = h.info || {};
			const rel = board.release || {};
			const fm = kb => fmtMB(kb);
			out.push(_('Nightfall monitor — диагностика, ') + new Date().toLocaleString(NF_LOC));
			out.push(_('Модель: %s · %s · ядро %s').format(board.model || '?', rel.description || rel.version || 'OpenWrt', board.kernel || '?'));
			if (d.up != null) out.push(_('Аптайм: %s · нагрузка %s').format(fmtUptime(d.up), (d.load || []).map(v => nf2.format(v)).join(' / ')));
			if (S.cpuNow) out.push(_('Процессор: %s яд., %s%% (программы %s%%, система %s%%, прерывания %s%%, ожидание диска %s%%)').format((d.cpu || []).length - 1, nf0.format(S.cpuNow.pct), nf0.format(S.cpuNow.apps), nf0.format(S.cpuNow.sys), nf1.format(S.cpuNow.irq), nf1.format(S.cpuNow.io)));
			if (d.temps) out.push(_('Температуры (как отдаёт система): ') + (d.temps.length ? d.temps.map(t => `${t[0]}=${nf1.format(t[1] / 1000)}°C`).join(', ') : _('датчиков нет')));
			if (d.mem) out.push(_('Память: занято %s из %s, кеш %s, swap %s из %s').format(fm(d.mem.total - d.mem.avail), fm(d.mem.total), fm(d.mem.cached + d.mem.buffers), fm(d.mem.swap - d.mem.swapfree), fm(d.mem.swap)));
			if (d.flash) out.push(_('Флеш: %s из %s · /tmp %s').format(fm(d.flash[1]), fm(d.flash[0]), d.tmp ? fm(d.tmp[1]) : '–'));
			if (d.ct) out.push(_('Соединения: %s из %s').format(d.ct[0], d.ct[1]));
			out.push(_('Интерфейсы (сейчас): ') + (d.net || []).map(n => { const r = (S.rates || {})[n[0]] || { rx: 0, tx: 0 }; return `${n[0]} ↓${rateText(r.rx)} ↑${rateText(r.tx)}`; }).join('; '));
			out.push(_('Wi-Fi клиентов: %s').format(S.wifi ? S.wifi.length : '–'));
			out.push(_('Сборщик: %s · WAN %s · шлюз %s · проверка %s · conntrack_acct=%s · flow offloading=%s · история сохраняется: %s').format(info.started ? _('работает') : _('НЕ ЗАПУЩЕН (данных нет)'), info.wan_dev || '–', info.gateway || '–', info.targets || '–', info.acct || '–', info.offload || '–', info.persist === '1' ? _('да') : _('нет')));
			const last = (h.rows || []).slice(-1)[0];
			if (last) out.push(_('Последний замер: CPU %s%%, память %s%%, температура %s, задержка шлюз %s / интернет %s').format(last[1], last[2], last[3] < 0 ? _('н/д') : last[3] + '°C', last[6] < 0 ? _('нет') : last[6] + _(' мс'), last[7] < 0 ? _('нет') : last[7] + _(' мс')));
			if (cfg && cfg.values) out.push(_('Настройки: ') + Object.keys(cfg.values).map(k => `${k}=${cfg.values[k]}`).join(' '));
			const act = h.active || [];
			out.push(_('Активные предупреждения: ') + (act.length ? act.map(a => a[3]).join('; ') : _('нет')));
			const evs = (h.events || []).slice(-10);
			if (evs.length) out.push(_('Последние события:\n') + evs.map(e => `  ${fmtTs(e[0])} [${e[1]}] ${e[2]}`).join('\n'));
			if (S.full) out.push(_('Программы по памяти: ') + groupedProcs().sort((a, b) => b.rss - a.rss).slice(0, 6).map(e => `${e.label} ${fmtMB(e.rss)}`).join(', '));
			return out.join('\n');
		}

		function copyDiag() {
			Promise.all([ callHistory([ 'series', 'fine' ]), callCfg([ 'get' ]) ]).then(([ hd, cfg ]) => {
				const text = buildDiag(hd || {}, cfg);
				const ta = E('textarea', { class: 'nfm-diag', readonly: '' }, text);
				const fallback = () => {
					ui.showModal(_('Диагностика'), [
						E('p', {}, _('Автоматически скопировать не удалось. Выделите текст и скопируйте вручную (Ctrl+C).')), ta,
						E('div', { class: 'button-row' }, [ E('button', { class: 'btn', click: ui.hideModal }, _('Закрыть')) ]) ]);
					ta.select();
				};
				const ok = () => ui.addNotification(null, E('p', {}, _('Диагностика скопирована в буфер обмена. IP- и MAC-адреса устройств в неё не входят.')), 'success');
				const legacy = () => {
					const t = E('textarea', { style: 'position:fixed;opacity:0' }, text);
					document.body.appendChild(t); t.select();
					let res = false;
					try { res = document.execCommand('copy'); } catch (e) {}
					t.remove();
					return res ? ok() : fallback();
				};
				if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, legacy);
				else legacy();
			});
		}

		function fmtTs(ts) {
			return new Date(ts * 1000).toLocaleString(NF_LOC, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
		}

		function xLabels(end, win) {
			const out = [];
			for (let i = 0; i <= 5; i++) {
				const d = new Date((end - win * (5 - i) / 5) * 1000);
				out.push(i === 5 ? _('сейчас') : win > 2 * 86400
					? d.toLocaleDateString(NF_LOC, { day: 'numeric', month: 'short' })
					: d.toLocaleTimeString(NF_LOC, { hour: '2-digit', minute: '2-digit' }));
			}
			return out;
		}

		function tempAlertOn() {
			return !!(S.alerts && (S.alerts.active || []).some(a => a[0] === 'temp' || a[0] === 'tempc'));
		}

		function renderAlerts() {
			const a = S.alerts && S.alerts.active || [];
			let dismissed = {};
			try { dismissed = JSON.parse(window.localStorage.getItem('nfm_alerts_dismissed') || '{}') || {}; } catch (e) {}
			const visible = a.filter(x => {
				const key = String(x && x[0] || 'unknown') + ':' + String(x && x[1] || 0);
				return !dismissed[key];
			});
			alertsBox.toggleAttribute('hidden', !visible.length);
			alertsBox.replaceChildren(...visible.map(x => {
				const key = String(x && x[0] || 'unknown') + ':' + String(x && x[1] || 0);
				const title = String(x && x[3] != null && x[3] !== '' ? x[3] : _('Предупреждение без описания'));
				return E('div', { class: 'nfm-alert' + (x[2] === 'crit' ? ' crit' : '') }, [
					E('div', { class: 'nfm-alert-copy' }, [ E('b', {}, title), E('small', {}, _('с ') + (x && x[1] ? fmtTs(x[1]) : _('время неизвестно'))) ]),
					E('button', { type: 'button', class: 'nfm-alert-dismiss', title: _('Скрыть после просмотра'), click: () => {
						dismissed[key] = Date.now();
						try { window.localStorage.setItem('nfm_alerts_dismissed', JSON.stringify(dismissed)); } catch (e) {}
						renderAlerts();
					} }, _('Понятно'))
				]);
			}));

			const last = S.alerts && S.alerts.last && S.alerts.last[0];
			if (!S.alerts) T.wanMini.textContent = S.alerts === false ? _('история не собирается') : '–';
			else if (!last || S.alerts.now - last[0] > 90) T.wanMini.textContent = _('нет данных');
			else T.wanMini.textContent = (last[7] >= 0 ? nf0.format(last[7]) + _(' мс') : _('нет ответа')) + (last[6] >= 0 ? _(' · шлюз ') + nf0.format(last[6]) + _(' мс') : '');
			if (last && S.alerts && S.alerts.now - last[0] <= 90) {
				rNet.set(last[7] >= 0 ? Math.min(100, last[7]) : 100, last[7] >= 0 ? nf0.format(last[7]) : '×');
				T.netMain.textContent = last[7] >= 0 ? _('есть') : _('нет ответа');
				T.netSub.textContent = last[6] >= 0 ? _('шлюз ') + nf0.format(last[6]) + _(' мс') : _('пинг до 1.1.1.1');
			} else { rNet.set(0, '–'); T.netMain.textContent = S.alerts === false ? _('не собирается') : _('нет данных'); T.netSub.textContent = _('нужен сборщик'); }
			updVerdict();
		}

		function renderTop3() {
			const list = (title, rows) => E('div', {}, [ E('div', { class: 'nfm-k', style: 'margin:0 0 4px' }, title) ].concat(rows.length ? rows.map(x => E('div', { class: 'nfm-host' }, [ E('span', {}, x[0]), E('b', {}, x[1]) ])) : [ E('div', { class: 'nfm-empty' }, _('Пока пусто')) ]));
			const progs = S.full ? groupedProcs().sort((a, b) => b.rss - a.rss).slice(0, 3).map(e => [ e.label, fmtMB(e.rss) ]) : [];
			const dv = S.devs && S.devs.day ? sumMonitorDeviceDailyTraffic(S.devs.day, hints, S.devs.neigh, S.wifi, routerIps, S.devs.leases).slice(0, 3) : [];
			const identityMap = monitorBuildIpMacMap(hints, S.devs && S.devs.neigh, S.wifi, S.devs && S.devs.leases);
			const nm = ip => {
				const mac = identityMap[normalizeMonitorIp(ip)];
				const h = mac ? hints[mac] || hints[mac.toLowerCase()] || {} : {};
				return h.name || names[ip] || ip;
			};
			top3Box.replaceChildren(list(_('Программы по памяти'), progs), E('div', { style: 'height:12px' }), list(_('Устройства по трафику сегодня'), dv.map(x => [ x.mac ? ((hints[x.mac] || hints[x.mac.toLowerCase()] || {}).name || x.ip) : nm(x.ip), fmtBytes(x.total) ])));
		}

		function renderDevices() {
			const dv = S.devs;
			devNote.toggleAttribute('hidden', true);
			if (!dv) {
				devBody.replaceChildren(E('tr', {}, E('td', { colspan: 5, class: 'nfm-empty' }, dv === false ? MISSING : _('Собираю данные…'))));
				T.devTotal.textContent = '';
				return;
			}
			const notes = [];
			if (dv.info && dv.info.acct === '0') notes.push(_('Учёт байтов в conntrack выключен, цифр не будет. Включите: sysctl -w net.netfilter.nf_conntrack_acct=1 (и добавьте net.netfilter.nf_conntrack_acct=1 в /etc/sysctl.conf).'));
			if (dv.info && dv.info.offload === '1') notes.push(_('Включён flow offloading: ускоренные соединения не попадают в conntrack-учёт, поэтому цифры по устройствам могут быть занижены. Это ограничение способа подсчёта, настройки файрвола менять не нужно.'));
			if (dv.info && dv.info.flow_hw === '1') notes.push(_('Включён аппаратный flow offloading: часть пакетов обрабатывается аппаратно и может обходить программные счётчики. Поэтому трафик WAN, устройств и приложений может заметно различаться; Nightfall не меняет эту настройку автоматически.'));
			if (notes.length) { devNote.textContent = notes.join(' '); devNote.removeAttribute('hidden'); }

			/* conntrack prints IPv6 in full form, DHCP/NDP hints in short form: compare in one form */
			const norm = normalizeMonitorIp;
			/* Keep exact DHCP identity and avoid merging clients behind proxy-ARP/repeaters. */
			const ipMac = monitorBuildIpMacMap(hints, dv.neigh || [], S.wifi, dv.leases || []);
			routerIps.learn(dv.info);

			const rows = {};
			const row = ip => {
				const mac = ipMac[norm(ip)], k = routerIps.has(ip) ? 'router' : mac || (ip.indexOf(':') >= 0 ? 'v6' : ip);
				return rows[k] || (rows[k] = { k, mac, ip, rd: 0, ru: 0, dd: 0, du: 0 });
			};
			const fresh = dv.now - dv.ts <= 60;
			if (fresh) for (const [ ip, d, u ] of dv.rate) { const r = row(ip); r.rd += trafficBytes(d); r.ru += trafficBytes(u); }
			for (const [ ip, d, u ] of dv[S.devDay] || []) { const r = row(ip); r.dd += trafficBytes(d); r.du += trafficBytes(u); if (!r.ip || r.ip.indexOf(':') >= 0) r.ip = ip; }

			const all = Object.values(rows).filter(r => r.rd + r.ru + r.dd + r.du > 0)
				.sort((a, b) => (b.dd + b.du) - (a.dd + a.du) || (b.rd + b.ru) - (a.rd + a.ru));
			S.devRows = all;
			const list = all.slice(0, 25);
			const mx = list.length ? Math.max(1, list[0].dd + list[0].du) : 1;
			let td = 0, tu = 0;
			for (const r of Object.values(rows)) { td += r.dd; tu += r.du; }
			T.devTotal.textContent = list.length ? _('всего ↓ %s · ↑ %s').format(fmtBytes(td), fmtBytes(tu)) + (all.length > list.length ? _(' · показаны %s самых активных из %s').format(list.length, all.length) : '') : '';

			const activeWifiMacs = new Set((S.wifi || []).map(c => String(c.mac || '').toUpperCase()).filter(Boolean));
			devBody.replaceChildren(...(list.length ? list.map(r => {
				const h = r.mac ? hints[r.mac] || hints[String(r.mac).toLowerCase()] || {} : {};
				const id = r.mac && r.k !== 'router' && r.k !== 'v6' ? devId(r.mac, h.name) : null;
				/* Для активной станции не используем имя, найденное только по IP:
				 * оно может принадлежать старой аренде другого MAC. */
				const ipName = r.mac && activeWifiMacs.has(String(r.mac).toUpperCase()) ? '' : names[r.ip];
				const label = r.k === 'v6' ? _('Другие адреса IPv6') : r.k === 'router' ? _('Сам роутер (VPN, DNS, обновления)') : (h.name || ipName || (id && id.known ? (id.label || _('Устройство')) : '') || r.ip);
				const sub = r.k === 'v6' || r.k === 'router' ? '' : ((h.ipaddrs || [])[0] || r.ip);
				return E('tr', { class: 'nfm-rowlink', tabindex: r.k === 'v6' || r.k === 'router' ? null : '0', title: r.k === 'v6' || r.k === 'router' ? null : _('Нажмите: карточка устройства'),
					click: () => { if (r.k !== 'v6' && r.k !== 'router') openDevCard(r); }, keydown: ev => { if (ev.key === 'Enter' && r.k !== 'v6' && r.k !== 'router') openDevCard(r); } }, [
					E('td', { title: id ? (id.hint ? id.hint + '\n' : '') + r.mac : '' }, [ id ? devIcon(id) : '', label, sub && sub !== label ? E('span', { class: 'nfm-chip' }, sub) : '',
						id && id.vendor ? E('span', { class: 'nfm-chip' }, id.vendor) : '', id && id.priv ? E('span', { class: 'nfm-chip priv' }, _('частный MAC')) : '',
						E('div', { class: 'nfm-bar nfm-bar-sm' }, E('div', { class: 'nfm-bar-fill c-down', style: `width:${100 * (r.dd + r.du) / mx}%` })) ]),
					E('td', { class: 'r' }, rateText(r.rd)), E('td', { class: 'r' }, rateText(r.ru)),
					E('td', { class: 'r' }, fmtBytes(r.dd)), E('td', { class: 'r' }, fmtBytes(r.du)) ]);
			}) : [ E('tr', {}, E('td', { colspan: 5, class: 'nfm-empty' }, _('Пока нет данных: учёт начинается после запуска сборщика, цифры накапливаются в течение дня.'))) ]));
		}

		/* ---- карточка устройства (по нажатию в «Устройствах»): трафик, приложения, сигнал, время появления, действия ---- */
		function openDevCard(r) {
			const mac = String(r.mac || '').toUpperCase(), ip = r.ip || '';
			const h = mac ? hints[mac] || hints[mac.toLowerCase()] || {} : {};
			/* В истории приложений ключом служит IP, поэтому собираем все известные
			 * IPv4/IPv6-адреса устройства, а не только адрес текущей conntrack-строки. */
			const deviceIps = new Set([ ip ].concat(h.ipaddrs || [], h.ip6addrs || []).filter(Boolean).map(normalizeMonitorIp));
			const id = mac ? devId(mac, h.name) : null;
			const label = (mac && devName(mac)) || names[ip] || ip || _('Устройство');
			const body = E('div', { class: 'nfm nfm-dc' }, E('div', { class: 'nfm-empty' }, _('Собираю данные…')));
			const acts = [];
			if (mac) {
				acts.push(E('button', { class: 'btn cbi-button-negative', click: () => { if (window.confirm(_('Заблокировать доступ в интернет для «') + label + '»?')) fs.exec('/usr/libexec/nightfall-block', [ 'block', mac ]).then(() => { ui.hideModal(); window.alert(_('Доступ закрыт. Снять блокировку можно на этой же вкладке в «Доступ в интернет».')); }).catch(() => window.alert(_('Не получилось.'))); } }, _('Заблокировать')));
				acts.push(E('button', { class: 'btn', title: _('Отправить «магический пакет», если устройство поддерживает Wake-on-LAN'), click: () => fs.exec('/usr/libexec/nightfall-wol', [ 'send', mac ]).then(() => window.alert(_('Пакет отправлен.'))).catch(() => window.alert(_('Не получилось.'))) }, _('Разбудить')));
			}
			ui.showModal(label, [ body, E('div', { class: 'button-row' }, acts.concat([ E('button', { class: 'btn', click: ui.hideModal }, _('Закрыть')) ])) ]);
			const J = a => callHistory(a).catch(() => null);
			Promise.all([ J([ 'devdaily' ]), J([ 'apps' ]), mac ? J([ 'wifi', mac ]) : Promise.resolve(null), J([ 'known' ]) ]).then(([ dd, ap, wf, kn ]) => {
				/* В devdaily хранится MAC на момент записи. Добавляем прежние IP,
				 * чтобы app history без MAC тоже попадала в карточку после смены адреса. */
				if (mac) for (const row of (dd && dd.rows) || [])
					if (String(row[4] || '').toUpperCase() === mac && row[1]) deviceIps.add(normalizeMonitorIp(row[1]));
				const ymdOf = d => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
				const mine = (rowIp, rowMac) => monitorDeviceOwnsHistoricalRow(mac, deviceIps, rowIp, rowMac);
				const asBytes = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; };
				const days = {};
				for (const x of (dd && dd.rows) || []) if (mine(x[1], x[4])) days[x[0]] = (days[x[0]] || 0) + asBytes(x[2]) + asBytes(x[3]);
				const nowD = new Date(), today = ymdOf(nowD);
				days[today] = (r.dd || 0) + (r.du || 0);
				const keys = []; for (let i = 13; i >= 0; i--) keys.push(ymdOf(new Date(nowD.getTime() - i * 86400000)));
				const vals = keys.map(k => days[k] || 0), mx = Math.max(1, ...vals);
				const total30 = Object.keys(days).filter(k => k >= ymdOf(new Date(nowD.getTime() - 29 * 86400000))).reduce((a, k) => a + days[k], 0);
				const yest = days[ymdOf(new Date(nowD.getTime() - 86400000))];
				const topApps = sumMonitorDeviceApps(ap, deviceIps).slice(0, 6);
				const sig = ((wf && wf.rows) || []).filter(x => !mac || String(x[1]).toUpperCase() === mac).map(x => +x[2]).filter(v => v < 0);
				const evs = ((wf && wf.events) || []).filter(x => String(x[1]).toUpperCase() === mac).slice(-6).reverse();
				const first = ((kn && kn.rows) || []).find(x => x[0] === mac);
				const kids = [
					E('div', { class: 'nfm-note-s' }, [ ip, mac ? ' · ' + mac : '', id && id.vendor ? ' · ' + id.vendor : '', id && id.priv ? _(' · частный MAC') : '' ].join('')),
					E('div', { class: 'nfm-mon-sum' }, [
						E('div', {}, [ E('span', {}, _('Сегодня')), E('b', {}, fmtBytes((r.dd || 0) + (r.du || 0))) ]),
						E('div', {}, [ E('span', {}, _('Вчера')), E('b', {}, yest != null ? fmtBytes(yest) : '–') ]),
						E('div', {}, [ E('span', {}, _('За 30 дней')), E('b', {}, fmtBytes(total30)) ]) ]),
					E('div', { class: 'nfm-k', style: 'margin:12px 0 6px' }, _('Трафик за 14 дней')),
					E('div', { class: 'nfm-dc-bars' }, vals.map((v, i) => E('i', { style: 'height:' + Math.max(2, Math.round(60 * v / mx)) + 'px', title: keys[i].slice(6) + '.' + keys[i].slice(4, 6) + ': ' + fmtBytes(v) }))) ];
				if (topApps.length) kids.push(E('div', { class: 'nfm-k', style: 'margin:12px 0 6px' }, _('Что качает (приложения)')), ...topApps.map(a => E('div', { class: 'nfm-host' }, [ E('span', {}, a[0]), E('b', {}, fmtBytes(a[1])) ])));
				if (sig.length) {
					const last = sig[sig.length - 1], avg = Math.round(sig.reduce((s, v) => s + v, 0) / sig.length);
					kids.push(E('div', { class: 'nfm-k', style: 'margin:12px 0 6px' }, 'Wi‑Fi'), E('div', { class: 'nfm-host' }, [ E('span', {}, _('Сигнал сейчас')), E('b', {}, last + _(' дБм')) ]), E('div', { class: 'nfm-host' }, [ E('span', {}, _('Средний за период')), E('b', {}, avg + _(' дБм')) ]));
				}
				if (evs.length) kids.push(E('div', { class: 'nfm-k', style: 'margin:12px 0 6px' }, _('Подключения и отключения')), ...evs.map(x => E('div', { class: 'nfm-host' }, [ E('span', {}, x[2] === 'join' ? _('подключился') : _('отключился')), E('small', {}, fmtTs(x[0])) ])));
				if (first && first[2]) kids.push(E('div', { class: 'nfm-note-s', style: 'margin-top:12px' }, _('Впервые замечено: ') + fmtTs(first[2])));
				body.replaceChildren(...kids);
			});
		}

		function renderDay() {
			const D = S.day;
			if (!D || !D.h || !D.h.info || !D.h.info.started) {
				dayBody.replaceChildren(E('div', { class: 'nfm-empty' }, D ? _('Сборщик истории не запущен — сводки нет.') : _('Загружаю…')));
				return;
			}
			const hwFlow = !!(D.h && D.h.info && D.h.info.flow_hw === '1');
			const mid = new Date().setHours(0, 0, 0, 0) / 1000;
			const rows = (D.h.rows || []).filter(r => r[0] >= mid);
			const col = i => rows.map(r => Number(r[i])).filter(v => Number.isFinite(v) && v >= 0);
			const max = a => a.length ? Math.max(...a) : null, avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
			const sum = (list, k) => (list || []).reduce((s, x) => s + trafficBytes(x[k]), 0);
			let dd = sum(D.d && D.d.day, 1), du = sum(D.d && D.d.day, 2), yd = sum(D.d && D.d.yday, 1) + sum(D.d && D.d.yday, 2);
			/* итоги дня берём из «Трафика по месяцам»: там уже выбран лучший источник (порт WAN или сумма по устройствам) */
			let ryDev = false;
			{
				const ymd = k => { const x = new Date(); x.setDate(x.getDate() - k); return String(x.getFullYear() * 10000 + (x.getMonth() + 1) * 100 + x.getDate()); };
				const rt = ((S.tr && S.tr.rows) || []).find(r => r[0] === ymd(0)), ry = ((S.tr && S.tr.rows) || []).find(r => r[0] === ymd(1));
				if (rt) { dd = rt[1]; du = rt[2]; }
				if (ry) { yd = ry[1] + ry[2]; ryDev = ry[3] === 1; }
			}
			/* свой трафик роутера (прокси, VPN, обновления) считаем отдельно, чтобы он не выдавал себя за устройство */
			routerIps.learn(D.d && D.d.info);
			let selfB = 0, cliD = 0, cliU = 0;
			for (const [ ip, d, u ] of (D.d && D.d.day) || []) { if (routerIps.has(ip)) selfB += trafficBytes(d) + trafficBytes(u); else { cliD += trafficBytes(d); cliU += trafficBytes(u); } }
			let srcNote = _('Скачано и отдано: по счётчикам порта WAN.'), swDev = false;
			const rtd = ((S.tr && S.tr.rows) || []).find(r => r[0] === (new Date().getFullYear() * 10000 + (new Date().getMonth() + 1) * 100 + new Date().getDate()) + '');
			if (rtd && rtd[3] === 1) {
				swDev = true;
				srcNote = _('Счётчики порта WAN показывают заметно меньше, чем прошло через устройства, поэтому все итоги по трафику (здесь, в календаре и в сравнении периодов) берутся по данным устройств.') + (hwFlow ? _(' Причина: на роутере включено аппаратное ускорение пакетов (Сеть → Межсетевой экран), оно скрывает часть трафика от счётчиков порта.') : _(' Вероятная причина: аппаратное ускорение пакетов (Сеть → Межсетевой экран) скрывает трафик от счётчиков порта.'));
			}
			if (cliD + cliU > 1.5 * (dd + du) && cliD + cliU > 50e6) {
				dd = cliD; du = cliU; swDev = true;
				srcNote = _('Счётчики порта WAN показывают заметно меньше, чем прошло через устройства, поэтому «Скачано» и «Отдано» взяты по данным устройств.') + (hwFlow ? _(' Причина: на роутере включено аппаратное ускорение пакетов (Сеть → Межсетевой экран), оно скрывает часть трафика от счётчиков порта.') : _(' Вероятная причина: аппаратное ускорение пакетов (Сеть → Межсетевой экран) скрывает трафик от счётчиков порта.'));
			}

			let drops = 0, down = 0;
			for (const e of D.h.events || []) {
				if (e[0] < mid) continue;
				const tx = String(e[2] || '');
				if (/Нет доступа в интернет/.test(tx) && !/Снова/.test(tx)) drops++;
				const m = /Снова в норме: Нет доступа в интернет.*длилось (?:(\d+) ч )?(?:(\d+) мин )?(?:(\d+) с)?/.exec(tx);
				if (m) down += (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
			}
			const dur = s => s >= 3600 ? Math.floor(s / 3600) + _(' ч ') + Math.floor(s % 3600 / 60) + _(' мин') : s >= 60 ? Math.floor(s / 60) + _(' мин') : s + _(' с');
			const pk = (a, f) => a == null ? '–' : f(a);
			const tile = (k, v, s) => E('div', { class: 'nfm-tile' }, [ k, E('b', {}, v), s ? E('span', { class: 'nfm-note-s' }, s) : '' ]);

			const topAll = sumMonitorDeviceDailyTraffic(D.d && D.d.day, hints, D.d && D.d.neigh, S.wifi, routerIps, D.d && D.d.leases);
			const list = topAll.slice(0, 3);
			const mx = list.length ? list[0].total : 1;

			dayBody.replaceChildren(
				E('div', { class: 'nfm-tiles d4' }, [
					tile(_('Скачано'), fmtBytes(dd), _('отдано ') + fmtBytes(du)),
					tile(_('Вчера всего'), yd ? fmtBytes(yd) : '–', yd ? (ryDev ? _('по данным устройств') : swDev ? _('по счётчикам порта WAN') : _('сегодня ') + nf0.format(100 * (dd + du) / yd) + _('% от вчера')) : ''),
					tile(_('Обрывов интернета'), String(drops), drops ? _('без связи ') + dur(down) : _('всё стабильно')),
					tile(_('Средний пинг'), pk(avg(col(7)), v => nf0.format(v) + _(' мс')), pk(max(col(7)), v => _('пик ') + nf0.format(v) + _(' мс'))),
					tile(_('Пик процессора'), pk(max(col(1)), v => nf0.format(v) + '%'), pk(avg(col(1)), v => _('в среднем ') + nf0.format(v) + '%')),
					tile(_('Пик температуры'), pk(max(col(3)), v => nf1.format(v) + ' °C'), pk(avg(col(3)), v => _('в среднем ') + nf1.format(v) + ' °C')),
					tile(_('Пик памяти'), pk(max(col(2)), v => nf0.format(v) + '%'), pk(avg(col(2)), v => _('в среднем ') + nf0.format(v) + '%'))
				]),
				list.length ? E('div', { class: 'nfm-day-top' }, [ E('div', { class: 'nfm-k' }, _('Больше всего трафика сегодня') + (topAll.length > list.length ? _(' · показаны ') + list.length + _(' из ') + topAll.length + _(' устройств') : '')) ].concat(list.map(row => {
					const hint = row.mac ? hints[row.mac] || hints[row.mac.toLowerCase()] || {} : {}, label = hint.name || names[row.ip] || row.ip;
					return E('div', { class: 'nfm-host' }, [ E('span', {}, [ label, label !== row.ip ? E('small', {}, row.ip) : '' ]), E('b', {}, fmtBytes(row.total)),
						E('div', { class: 'nfm-bar' }, E('div', { class: 'nfm-bar-fill c-down', style: `width:${100 * row.total / mx}%` })) ]);
				}))) : '',
				E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, srcNote + (selfB > 0 ? _(' Собственный трафик роутера: ') + fmtBytes(selfB) + _(' (обновления, DNS, замер скорости, прокси или VPN на роутере). В список устройств он не входит.') : '')));
		}

		function renderHist() {
			for (const k in rangeBtns) rangeBtns[k].classList.toggle('on', S.range === k);
			const h = S.hist, R = RANGES[S.range], win = R[1];
			const alive = !!(h && h.info && h.info.started);
			histNote.toggleAttribute('hidden', alive);
			if (!alive) histNote.textContent = h === false ? MISSING : _('Сборщик истории не запущен или ещё ничего не записал. Проверьте на роутере: /etc/init.d/nightfall-collector status; ls /tmp/nightfall');
			if (!h) { evBox.replaceChildren(E('div', { class: 'nfm-empty' }, h === false ? '' : _('Загружаю…'))); return; }

			const end = h.now;
			const rows = (h.rows || []).filter(r => end - r[0] <= win);
			const col = i => rows.map(r => { const v = Number(r[i]); return Number.isFinite(v) && v >= 0 ? v : null; });
			const times = rows.map(r => r[0]);
			const view = { win, end, labels: xLabels(end, win) };
			const vmax = a => a.reduce((m, v) => v != null && v > m ? v : m, 0);

			const temp = col(3), tm = vmax(temp);
			const usual = i => win > 604800 ? times.map(() => null) : usualCurve(S.day && S.day.h && S.day.h.rows, times, i);
			histMain.update(times, { cpuB: usual(1), cpu: col(1), mem: col(2), temp }, { left: 100, right: tm > 90 ? Math.ceil(tm / 20) * 20 : 100 }, view);

			const gw = col(6), net = col(7);
			histPing.update(times, { netB: usual(7), gw, net }, { left: niceCeil(Math.max(vmax(net), vmax(gw), 20)) }, view);
			const rx = col(4), tx = col(5);
			histNet.update(times, { rxB: usual(4), rx, tx }, { left: niceCeil(Math.max(vmax(rx), vmax(tx), 12500)) }, view);

			const ok = net.filter(v => v != null);
			T.pAvg.textContent = ok.length ? nf0.format(ok.reduce((a, b) => a + b, 0) / ok.length) + _(' мс') : '–';
			T.pMax.textContent = ok.length ? nf0.format(vmax(ok)) + _(' мс') : '–';
			const lossRows = rows.filter(r => r[8] >= 0);
			T.pLoss.textContent = lossRows.length ? nf1.format(lossRows.reduce((a, r) => a + r[8], 0) / lossRows.length) + '%' : '–';
			const evs = (h.events || []).filter(e => end - e[0] <= win);
			T.pCut.textContent = String(evs.filter(e => e[1] === 'crit' && /^Нет /.test(e[2])).length);

			const list = (h.events || []).slice().reverse().slice(0, 40);
			evBox.replaceChildren(...(list.length ? list.map(e => E('div', { class: 'nfm-ev-i ' + e[1] }, [ E('i'), E('time', {}, fmtTs(e[0])), E('span', {}, trEv(e[2])) ]))
				: [ E('div', { class: 'nfm-empty' }, _('Событий пока нет — это хорошо.')) ]));

			const i = h.info || {};
			histInfo.textContent = rows.length < 3 ? _('Данных пока мало: сборщик накапливает точки, график заполнится через несколько минут. ') : '';
			histInfo.textContent += _('Запись каждые %s с, недельная история — по 5 минут, длинная (30 и 90 дней) — по 30 минут').format(i.step || 15) + (+i.long_n > 0 ? _(' (накоплено %s сут из %s)').format(nf1.format(+i.long_n / 48), i.hist_days || 30) : '') + '. ' +
				(i.persist === '1' ? _('История сохраняется между перезагрузками. ') : _('История хранится в памяти и обнуляется при перезагрузке роутера. ')) +
				(i.limits ? _('Пороги: ') + i.limits + '. ' : '') + _('Настройки: /etc/nightfall-monitor.conf.');
		}


		/* ---------- что грузит канал ---------- */
		function ipLabel(ip) {
			const map = monitorBuildIpMacMap(hints, S.devs && S.devs.neigh, S.wifi, S.devs && S.devs.leases);
			const mac = map[normalizeMonitorIp(ip)], h = mac ? hints[mac] || hints[mac.toLowerCase()] || {} : {};
			return h.name || names[ip] || ip;
		}

		function renderDns() {
			const d = S.dns;
			if (!d) { dnsBox.replaceChildren(E('div', { class: 'nfm-empty' }, d === false ? MISSING : _('Собираю данные…'))); return; }
			if (!d.enabled) { dnsBox.replaceChildren(E('div', { class: 'nfm-empty' }, _('Журнал DNS-запросов выключен. Включить: uci set dhcp.@dnsmasq[0].logqueries=1; uci commit dhcp; /etc/init.d/dnsmasq restart'))); return; }
			const list = (title, rows, nm) => E('div', {}, [ E('div', { class: 'nfm-k', style: 'margin-bottom:6px' }, title) ].concat(rows.length ? rows.slice(0, 8).map(x => E('div', { class: 'nfm-host' }, [ E('span', {}, nm ? nm(x[0]) : x[0]), E('b', {}, String(x[1])) ])) : [ E('div', { class: 'nfm-empty' }, _('Пока пусто')) ]));
			const who = ip => names[ip] || ip;
			dnsBox.replaceChildren(
				E('div', { class: 'nfm-note-s', style: 'grid-column:1/-1' }, _('Запросов в журнале: ') + d.total + _(', не нашлось имён: ') + d.nx + (d.types && d.types.length ? ' · ' + d.types.slice(0, 4).map(x => x[0] + ' ' + x[1]).join(', ') : '')),
				list(_('Куда чаще обращаются'), d.sites || []), list(_('Кто спрашивает'), d.clients || [], who), list(_('Не нашлось (NXDOMAIN)'), d.nxd || []));
		}

		function renderChannel() {
			const c = S.chan;
			if (!c) { chanBox.replaceChildren(E('div', { class: 'nfm-empty' }, c === false ? MISSING : _('Собираю данные…'))); return; }
			const fresh = c.now - c.ts <= 60;
			const srcs = Array.from(new Set((c.svc || []).map(r => r[0])));
			const want = S.chanDev || '';
			chanSel.replaceChildren(E('option', { value: '' }, _('Все устройства')), ...srcs.map(ip => E('option', { value: ip }, ipLabel(ip))));
			chanSel.value = srcs.includes(want) ? want : '';
			if (!srcs.includes(want)) S.chanDev = '';
			if (!fresh) { chanBox.replaceChildren(E('div', { class: 'nfm-empty' }, _('Нет свежих данных. Нужен включённый учёт байтов в conntrack (см. подсказку выше) и работающий сборщик.'))); return; }

			const sel = S.chanDev || '';
			const svc = {}, dst = {};
			for (const [ ip, proto, port, d, u ] of c.svc || []) {
				if (sel && ip !== sel) continue;
				const k = portLabel(proto, port), e = svc[k] || (svc[k] = { k, d: 0, u: 0 });
				e.d += trafficBytes(d); e.u += trafficBytes(u);
			}
			for (const [ ip, host, d, u ] of c.dst || []) {
				if (sel && ip !== sel) continue;
				const e = dst[host] || (dst[host] = { k: host, d: 0, u: 0 });
				e.d += trafficBytes(d); e.u += trafficBytes(u);
			}
			const list = (obj, what) => {
				const rows = Object.values(obj).filter(r => r.d + r.u > 0).sort((a, b) => (b.d + b.u) - (a.d + a.u)).slice(0, 8);
				const mx = rows.length ? rows[0].d + rows[0].u : 1;
				return E('div', {}, [ E('h4', {}, what), E('div', { class: 'nfm-lst' }, rows.length ? rows.map(r => E('div', { class: 'nfm-li' }, [
					E('span', { class: 'nm' }, r.k), E('span', { class: 'v' }, '↓ ' + rateText(r.d)), E('span', { class: 'v' }, '↑ ' + rateText(r.u)),
					E('div', { class: 'nfm-bar nfm-bar-sm bar' }, E('div', { class: 'nfm-bar-fill c-down', style: `width:${100 * (r.d + r.u) / mx}%` })) ]))
					: [ E('div', { class: 'nfm-empty' }, _('Сейчас нет заметного трафика')) ]) ]);
			};
			chanBox.replaceChildren(list(svc, _('По службам и портам')), list(dst, _('По адресам в интернете')));
		}

		/* ---------- Wi-Fi клиент: сигнал в динамике ---------- */
		function wifiDialog(mac, label, c) {
			const body = E('div', { class: 'nfm nfm-wd' }, E('div', { class: 'nfm-empty' }, _('Загружаю историю сигнала…')));
			ui.showModal(label, [ body, E('div', { class: 'button-row' }, [ E('button', { class: 'btn', click: ui.hideModal }, _('Закрыть')) ]) ]);
			callHistory([ 'wifi', mac.toLowerCase() ]).then(r => {
				if (!r) { body.replaceChildren(E('div', { class: 'nfm-hint' }, MISSING)); return; }
				const rows = (r.rows || []).filter(x => +x[0] > 0).sort((a, b) => a[0] - b[0]);
				if (rows.length < 2) {
					body.replaceChildren(E('div', { class: 'nfm-hint' }, _('История сигнала копится раз в минуту с момента запуска сборщика (она хранится только в памяти). Загляните сюда через несколько минут.') +
						((r.info && r.info.wifi_hist === '0') ? _(' Сейчас запись истории Wi-Fi выключена в настройках (WIFI_HIST=0).') : '')));
					return;
				}
				const t0 = rows[0][0], t1 = Math.max(r.now, rows[rows.length - 1][0]), W = 300, H = 120, lo = -95, hi = -30;
				const X = ts => (ts - t0) / Math.max(1, t1 - t0) * W, Y = v => H - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo) * H;
				const grid = [ -40, -50, -60, -70, -80, -90 ].map(v => SVG('line', { x1: 0, x2: W, y1: Y(v), y2: Y(v), stroke: 'currentColor', 'stroke-opacity': .15, 'stroke-dasharray': '3 4', 'vector-effect': 'non-scaling-stroke' }));
				let d = '', prev = 0;
				for (const x of rows) { d += (prev && x[0] - prev <= 150 ? 'L' : 'M') + X(x[0]).toFixed(1) + ' ' + Y(+x[2]).toFixed(1); prev = x[0]; }
				const vals = rows.map(x => +x[2]), avg = vals.reduce((a, b) => a + b, 0) / vals.length;
				const svg = SVG('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' }, grid.concat([
					SVG('path', { d, fill: 'none', stroke: 'var(--nfm-accent, #0a84ff)', 'stroke-width': 1.8, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }) ]));
				const tm = ts => new Date(ts * 1000).toLocaleTimeString(NF_LOC, { hour: '2-digit', minute: '2-digit' });
				const evs = (r.events || []).slice().reverse().slice(0, 12);
				const weak = vals.filter(v => v <= -75).length / vals.length * 100;
				body.replaceChildren(
					E('div', { class: 'nfm-note-s', style: 'margin-bottom:6px' }, _('%s%s · период %s — %s (%s)').format(mac.toUpperCase(), c && c.ssid ? ' · ' + c.ssid : '', tm(t0), tm(t1), fmtDur(t1 - t0))),
					svg,
					E('div', { class: 'nfm-note-s', style: 'display:flex;justify-content:space-between;margin:2px 0 4px' }, [ E('span', {}, tm(t0)), E('span', {}, _('сейчас')) ]),
					E('div', { class: 'nfm-note-s', style: 'margin-bottom:10px' }, _('Линии сетки: −40, −50 … −90 дБм сверху вниз. Выше −65 — хороший сигнал, ниже −75 — слабый.')),
					E('div', { class: 'nfm-tiles t4' }, [ [ _('сейчас'), vals[vals.length - 1] + _(' дБм') ], [ _('в среднем'), nf0.format(avg) + _(' дБм') ], [ _('лучший'), Math.max(...vals) + _(' дБм') ], [ _('худший'), Math.min(...vals) + _(' дБм') ] ]
						.map(([ l, v ]) => E('div', { class: 'nfm-tile' }, [ l, E('b', {}, v) ]))),
					E('div', { class: 'nfm-note-s', style: 'margin:10px 0' }, weak >= 20
						? _('Слабый сигнал (−75 дБм и ниже) около %s%% времени: поднесите устройство ближе к роутеру или подумайте о повторителе.').format(nf0.format(weak))
						: _('Сигнал в основном уверенный.')),
					E('h4', { style: 'margin:10px 0 4px;font-size:12px;color:var(--nfm-dim)' }, _('Подключения и отключения')),
					E('div', { class: 'nfm-evlist', style: 'max-height:150px' }, evs.length ? evs.map(e => E('div', { class: 'nfm-ev-i ' + (e[2] === 'join' ? 'ok' : 'warn') }, [ E('i'), E('time', {}, fmtTs(e[0])), E('span', {}, e[2] === 'join' ? _('Подключилось') : _('Отключилось')) ]))
						: [ E('div', { class: 'nfm-empty' }, _('Переподключений не было с момента запуска сборщика.')) ]));
			});
		}

		/* ---------- журнал перезагрузок и обрывов ---------- */
		function renderJournal() {
			const j = S.jrn;
			if (!j) { jrnBox.replaceChildren(E('div', { class: 'nfm-empty' }, j === false ? MISSING : _('Загружаю…'))); return; }
			const WEEK = 604800, rows = (j.rows || []).slice().sort((a, b) => b[0] - a[0]);
			const out = rows.filter(r => r[1] === 'outage' && j.now - r[0] <= WEEK);
			const sum = out.reduce((a, r) => a + r[2], 0);
			const boot = rows.find(r => r[1] === 'boot');
			T.jCnt.textContent = String(out.length);
			T.jSum.textContent = sum ? fmtDur(sum) : '0';
			T.jAv.textContent = nf2.format(Math.max(0, 100 - sum * 100 / WEEK)) + '%';
			T.jBoot.textContent = boot ? fmtTs(boot[0]) : (j.up ? fmtTs(j.now - j.up) : '–');
			const disabled = j.info && j.info.journal === '0';
			const list = rows.slice(0, 30);
			jrnBox.replaceChildren(...(list.length ? list.map(r => E('div', { class: 'nfm-jr ' + r[1] }, [
				E('span', { class: 'ic' }, r[1] === 'outage' ? '⚠' : '⟳'), E('time', {}, fmtTs(r[0])),
				E('span', {}, r[1] === 'outage' ? _('Обрыв связи: ') + r[3] : r[3]), E('b', {}, r[1] === 'outage' ? fmtDur(r[2]) : '') ]))
				: [ E('div', { class: 'nfm-empty' }, disabled ? _('Журнал выключен (JOURNAL=0 в настройках).') : _('Записей пока нет: журнал пополняется при обрывах связи (от двух неудачных проверок подряд) и перезагрузках роутера.')) ]));
		}

		/* ---------- замер скорости ---------- */
		function startSpeed() {
			spdBtn.disabled = true; spdBtn.textContent = _('Идёт замер…');
			S.spdRun = true; S.spdT = Date.now(); S.at.spd = 0;
			fs.exec(SPEEDBIN, [ 'start' ]).catch(err => {
				S.spdRun = false;
				ui.addNotification(null, E('p', {}, _('Не удалось запустить замер: ') + (err.message || err)), 'danger');
			});
		}

		function renderSpeed() {
			const sp = S.spd;
			if (S.spdRun && Date.now() - (S.spdT || 0) > 60000) S.spdRun = false;   /* замер идёт не дольше ~15 с: дальше не ждём */
			const running = !!(sp && sp.running) || !!S.spdRun;
			spdBtn.disabled = running; spdBtn.textContent = running ? _('Идёт замер…') : _('Измерить сейчас');
			if (!sp) { spdList.replaceChildren(E('div', { class: 'nfm-empty' }, sp === false ? MISSING : _('Загружаю…'))); return; }
			if (sp.info && sp.info.speed_hours != null && document.activeElement !== spdSel) spdSel.value = sp.info.speed_hours;
			if (S.cfg && S.cfg.values && document.activeElement !== spdSrc) { const u = S.cfg.values.SPEED_URL || SPEED_PRESETS[0][0]; spdSrc.value = SPEED_PRESETS.some(p => p[0] === u) ? u : ''; }
			const WEEK = 604800, all = (sp.rows || []).filter(r => r[5] === 'ok' && sp.now - r[0] <= WEEK);
			const ok = all.map(r => +r[1]);
			T.sLast.textContent = ok.length ? nf1.format(ok[ok.length - 1]) + _(' Мбит/с') : '–';
			T.sAvg.textContent = ok.length ? nf1.format(ok.reduce((a, b) => a + b, 0) / ok.length) + _(' Мбит/с') : '–';
			T.sMax.textContent = ok.length ? nf1.format(Math.max(...ok)) + _(' Мбит/с') : '–';
			T.sMin.textContent = ok.length ? nf1.format(Math.min(...ok)) + _(' Мбит/с') : '–';
			const mx = ok.length ? Math.max(...ok) : 10;
			spdChart.update(all.map(r => r[0]), { mbps: ok }, { left: niceCeil(Math.max(mx, 10)) }, { win: WEEK, end: sp.now, labels: xLabels(sp.now, WEEK) });
			const last = (sp.rows || []).slice(-8).reverse();
			spdList.replaceChildren(...(last.length ? last.map(r => E('div', { class: 'nfm-li' }, [
				E('span', { class: 'nm' }, [ fmtTs(r[0]), r[5] !== 'ok' ? E('small', {}, _('не удалось скачать файл')) : (+r[4] > 300 ? E('small', {}, _('в это время шёл другой трафик')) : '') ]),
				E('span', { class: 'v' }, r[5] === 'ok' ? nf1.format(+r[1]) + _(' Мбит/с') : '–'), E('span', { class: 'v' }, r[5] === 'ok' ? fmtBytes(+r[2]) : '') ]))
				: [ E('div', { class: 'nfm-empty' }, _('Замеров ещё не было. Нажмите «Измерить сейчас».')) ]));
			spdNote.textContent = _('Роутер скачивает тестовый файл в несколько потоков (каждый поток качает весь файл; по умолчанию 4, число меняется параметром SPEED_STREAMS в /etc/nightfall-monitor.conf) и считает скорость сам, без браузера. Это скорость загрузки до выбранного сервера; адрес меняется в настройках ниже. Если в это время идёт другой трафик, результат занижен.');
		}

		/* ---------- хранение истории и износ флеш-памяти ---------- */
		function renderFlash() {
			const i = (S.hist && S.hist.info) || (S.jrn && S.jrn.info) || (S.spd && S.spd.info) || null;
			if (!i) { flashBox.replaceChildren(E('div', { class: 'nfm-empty' }, _('Загружаю…'))); return; }
			const hrs = +i.persist_hours || 6, kb = +i.persist_kb || 0;
			const rows = [
				[ _('Графики и события'), _('в памяти роутера (/tmp), на флеш-память не пишутся') ],
				[ _('Журнал обрывов и перезагрузок'), i.journal === '1' ? _('на флеш, одна короткая запись на событие, не больше 200 строк') : _('выключен') ],
				[ _('Сохранение между перезагрузками'), i.persist === '1' ? _('в %s раз в %s ч').format(i.persist_dir, hrs) + (kb ? _(', до %s КБ за раз').format(nf0.format(kb)) : '') + _(', неизменённые файлы пропускаются') : _('выключено, история обнуляется при перезагрузке') ]
			];
			const est = i.persist === '1' && kb ? kb * 24 / hrs : 0;
			flashBox.replaceChildren(
				...(i.persist_error === '1' ? [ E('div', { class: 'nfm-hint', style: 'border-color:#e5484d' }, [
					E('b', { class: 'nfm-warn' }, _('Не удалось сохранить историю. ')),
					_('Проверьте, подключён ли накопитель, существует ли папка и есть ли права на запись. После исправления сборщик повторит сохранение автоматически.')
				]) ] : []),
				...(i.persist_blocked === '1' ? [ E('div', { class: 'nfm-hint', style: 'border-color:#e5484d' }, [ E('b', { class: 'nfm-warn' }, _('Запись заблокирована. ')),
					_('Папка %s находится на встроенной флеш-памяти роутера, её нельзя изнашивать. Укажите папку на USB или SD-карте. Если это eMMC, SSD или SD-карта, которую можно писать, поставьте «Разрешить сохранение на встроенный накопитель» в 1.').format(i.persist_dir) ]) ] : []),
				E('div', { class: 'nfm-lst' }, rows.map(([ a, b ]) => E('div', {}, [ E('b', {}, a), E('div', { class: 'nfm-note-s' }, b) ]))),
				E('div', { class: 'nfm-note-s', style: 'margin-top:10px' }, est
					? _('Оценка записи на накопитель: около %s %s в сутки.').format(nf0.format(est / 1024 > 1 ? est / 1024 : est), est / 1024 > 1 ? _('МБ') : _('КБ'))
					: _('Запись на накопитель не ведётся, износ флеш-памяти минимален. Чтобы переживать перезагрузки, укажите папку на USB/SD в настройках ниже.')));
		}

		/* ---------- состояние служб ---------- */
		function svcLog(name) {
			const body = E('div', { class: 'nfm-evlist', style: 'max-height:55vh;overflow:auto;min-width:min(520px,80vw)' }, E('div', { class: 'nfm-empty' }, _('Читаю журнал…')));
			ui.showModal(_('Журнал: ') + name, [ body, E('div', { class: 'button-row' }, [ E('button', { class: 'btn', click: ui.hideModal }, _('Закрыть')) ]) ]);
			fs.exec('/usr/libexec/nightfall-log', [ 'read', '1500' ]).then(r => {
				let j = null; try { j = JSON.parse(r.stdout); } catch (e) { /* ignore */ }
				const rows = j && j.rows ? j.rows.filter(x => x[2] === name || (x[2] || '').indexOf(name) === 0).slice(-80).reverse() : [];
				body.replaceChildren(...(rows.length ? rows.map(x => E('div', { class: 'nfm-ev-i ' + (/err|crit|alert|emerg/.test(x[1]) ? 'crit' : /warn/.test(x[1]) ? 'warn' : 'info') }, [ E('i'), E('time', {}, x[0]), E('span', {}, x[3]) ])) : [ E('div', { class: 'nfm-empty' }, _('В журнале роутера записей этой службы нет.')) ]));
			}).catch(() => body.replaceChildren(E('div', { class: 'nfm-empty' }, _('Не удалось прочитать журнал.'))));
		}

		function svcAction(name, action, label, danger) {
			const run = () => {
				ui.showModal(null, [ E('p', { class: 'spinning' }, label + '…') ]);
				callInitAction(name, action).then(() => window.setTimeout(() => { ui.hideModal(); S.at.svc = 0; tick(); }, 1500))
					.catch(err => { ui.hideModal(); ui.addNotification(null, E('p', {}, _('Не удалось (%s: %s): ').format(name, action) + (err.message || err)), 'danger'); });
			};
			if (!danger) return run();
			ui.showModal(`${label}?`, [ E('p', {}, _('Служба «%s» важна для работы роутера. Соединение с панелью может прерваться на несколько секунд.').format(name)),
				E('div', { class: 'button-row' }, [ E('button', { class: 'btn', click: ui.hideModal }, _('Отмена')), E('button', { class: 'btn cbi-button-negative important', click: () => { ui.hideModal(); run(); } }, _('Выполнить')) ]) ]);
		}

		function renderServices() {
			const sv = S.svc;
			if (!sv || !sv.init) { svcBox.replaceChildren(E('div', { class: 'nfm-empty' }, sv ? _('Список служб недоступен: нет прав или не поддерживается этой версией LuCI.') : _('Загружаю…'))); svcMore.replaceChildren(); return; }
			const q = (svcFilter.value || '').trim().toLowerCase();
			const run = sv.run || {};
			const all = Object.keys(sv.init).map(n => {
				const inst = run[n] && run[n].instances ? Object.values(run[n].instances) : null;
				const known = !!run[n];
				const up = !!(inst && inst.some(i => i.running));
				return { n, en: !!sv.init[n].enabled, known, up, idx: sv.init[n].index };
			}).filter(x => !q || x.n.toLowerCase().includes(q) || (SVC_INFO[x.n] || '').toLowerCase().includes(q));
			const bad = x => x.en && x.known && !x.up;
			const proc = all.filter(x => x.known).sort((a, b) => (bad(b) - bad(a)) || (b.up - a.up) || a.n.localeCompare(b.n));
			const other = all.filter(x => !x.known).sort((a, b) => (b.en - a.en) || a.n.localeCompare(b.n));

			const row = x => {
				const prot = SVC_PROTECTED.includes(x.n);
				const st = x.known ? (x.up ? 'run' : (bad(x) ? 'bad' : 'off')) : 'off';
				const state = x.known ? (x.up ? _('работает') : (x.en ? _('не работает, хотя включена') : _('остановлена'))) : (x.en ? _('включена при загрузке') : _('выключена'));
				return E('div', { class: 'nfm-svc ' + st }, [ E('i', { class: 'st' }),
					E('div', {}, [ E('div', { class: 'nm' }, x.n), E('div', { class: 'ds' }, [ SVC_INFO[x.n] ? SVC_INFO[x.n] + ' · ' : '', state, x.known && x.en ? _(' · автозапуск включён') : (x.known ? _(' · автозапуск выключен') : '') ]) ]),
					E('div', { class: 'ac' }, [
						E('button', { class: 'nfm-mini', title: _('Последние записи журнала роутера по этой службе'), click: () => svcLog(x.n) }, _('Журнал')),
						E('button', { class: 'nfm-mini', click: () => svcAction(x.n, 'restart', _('Перезапустить ') + x.n, prot) }, _('Перезапустить')),
						x.up ? E('button', { class: 'nfm-mini', disabled: prot, title: prot ? _('Ключевая служба: остановка отсюда отключена') : '', click: () => svcAction(x.n, 'stop', _('Остановить ') + x.n) }, _('Остановить'))
							: E('button', { class: 'nfm-mini', click: () => svcAction(x.n, 'start', _('Запустить ') + x.n) }, _('Запустить')),
						E('button', { class: 'nfm-mini', disabled: prot && x.en, title: prot && x.en ? _('Ключевая служба: автозапуск менять нельзя') : '', click: () => svcAction(x.n, x.en ? 'disable' : 'enable', (x.en ? _('Отключить автозапуск ') : _('Включить автозапуск ')) + x.n) }, x.en ? _('Автозапуск: вкл') : _('Автозапуск: выкл')) ]) ]);
			};
			svcBox.replaceChildren(...(proc.length ? proc.map(row) : [ E('div', { class: 'nfm-empty' }, q ? _('Ничего не найдено') : _('Работающих служб не найдено')) ]));
			svcMore.replaceChildren(other.length ? E('details', { class: 'nfm-card' }, [ E('summary', { style: 'cursor:pointer;font-weight:600;font-size:14px' }, _('Скрипты без отдельного процесса (%s)').format(other.length)),
				E('div', { style: 'margin-top:8px' }, other.map(row)) ]) : '');
		}

		/* ---------- logic ---------- */
		function setPaused(p) {
			S.paused = p;
			pauseBtn.textContent = p ? _('Продолжить') : _('Пауза');
			pill.classList.toggle('paused', p);
			pill.textContent = p ? _('приостановлено') : _('обновляется каждые %s с').format(INTERVAL);
		}

		const show = (el, v) => el.toggleAttribute('hidden', !v);

		function cpuDelta(a, b) {
			const sum = x => x[0] + x[1] + x[2] + x[3] + x[4] + x[5] + x[6] + x[7];
			const dt = sum(b) - sum(a);
			if (dt <= 0) return null;
			const idle = (b[3] + b[4]) - (a[3] + a[4]);
			return {
				pct: 100 * (1 - idle / dt),
				apps: 100 * ((b[0] + b[1]) - (a[0] + a[1])) / dt,
				sys: 100 * (b[2] - a[2]) / dt,
				irq: 100 * ((b[5] + b[6]) - (a[5] + a[6])) / dt,
				io: 100 * (b[4] - a[4]) / dt
			};
		}

		function pickTemps(list) {
			const wifi = [], cpu = [];
			for (const [ n, v ] of list || []) {
				const c = v / 1000;
				if (!isFinite(c) || c <= 0) continue;
				(/phy|mt76|mt79|wifi|wlan|ath|iwlwifi/i.test(n) ? wifi : cpu).push([ n, c ]);
			}
			const main = cpu.find(x => /cpu|soc|core|a53|a73|thermal/i.test(x[0])) || cpu[0] || wifi[0];
			return { main: main ? main[1] : null, wifi: wifi.map(x => x[1]) };
		}

		function ingest(d) {
			const now = Date.now() / 1000;
			const prev = S.last;
			S.last = d;

			/* temperature, memory */
			const tp = pickTemps(d.temps);
			S.temps = tp;
			const memUsed = d.mem.total - d.mem.avail;

			let cpuNow = null;
			if (prev) cpuNow = cpuDelta(prev.cpu[0], d.cpu[0]);
			const cores = [];
			if (prev) for (let i = 1; i < d.cpu.length; i++) cores.push(cpuDelta(prev.cpu[i], d.cpu[i]));
			S.cores = cores;
			if (cpuNow) S.cpuNow = cpuNow;

			/* network rates */
			const dtUp = prev ? d.up - prev.up : 0;
			const rates = {};
			if (prev && dtUp > 0) {
				const pm = {};
				for (const n of prev.net) pm[n[0]] = n;
				for (const n of d.net) {
					const p = pm[n[0]];
					if (!p) continue;
					rates[n[0]] = { rx: Math.max(0, (n[1] - p[1]) / dtUp), tx: Math.max(0, (n[5] - p[5]) / dtUp) };
				}
			}
			S.rates = rates;

			if (prev && cpuNow) {
				S.times.push(now);
				S.cpu.push(cpuNow.pct);
				S.mem.push(100 * memUsed / d.mem.total);
				S.temp.push(tp.main);
				for (const n of d.net) {
					const h = S.net[n[0]] || (S.net[n[0]] = { rx: [], tx: [] });
					while (h.rx.length < S.times.length - 1) { h.rx.unshift(null); h.tx.unshift(null); }
					h.rx.push(rates[n[0]] ? rates[n[0]].rx : null);
					h.tx.push(rates[n[0]] ? rates[n[0]].tx : null);
				}
				while (S.times.length && S.times[0] < now - WINDOW) {
					S.times.shift(); S.cpu.shift(); S.mem.shift(); S.temp.shift();
					for (const n in S.net) { S.net[n].rx.shift(); S.net[n].tx.shift(); }
				}
				try {
					window.sessionStorage.setItem(STORE_KEY, JSON.stringify({ times: S.times, cpu: S.cpu, mem: S.mem, temp: S.temp, net: S.net }));
				} catch (e) {}
			}

			if (d.procs) {
				const rate = {};
				if (S.prevProcs && S.prevProcs.up < d.up) {
					const dtp = d.up - S.prevProcs.up;
					for (const p of d.procs) {
						const o = S.prevProcs.t[p[0]];
						if (o != null) rate[p[0]] = Math.max(0, (p[3] - o) / 100 / dtp * 100);
					}
				}
				S.procRate = rate;
				S.prevProcs = { up: d.up, t: Object.fromEntries(d.procs.map(p => [ p[0], p[3] ])) };
				S.full = d;
			}
		}

		function seriesMax() {
			let m = 0;
			for (const v of S.temp) if (v != null && v > m) m = v;
			return { left: 100, right: m > 90 ? Math.ceil(m / 20) * 20 : 100 };
		}

		function netMaxOf(h) {
			let m = 0;
			for (const v of h.rx.concat(h.tx)) if (v != null && v > m) m = v;
			return niceCeil(Math.max(m, 12500));  /* at least 100 kbit/s */
		}

		function groupedProcs() {
			const full = S.full;
			if (!full) return [];
			const map = {};
			for (const p of full.procs) {
				const g = groupOf(p[1]);
				const e = map[g.label] || (map[g.label] = { label: g.label, cls: g.cls, n: 0, rss: 0, cpu: 0, names: {} });
				e.n++; e.rss += p[2]; e.cpu += S.procRate[p[0]] || 0; e.names[p[1]] = 1;
			}
			return Object.values(map).filter(e => e.rss > 0 || e.cpu > 0);
		}

		function pickIface(d) {
			const names = d.net.map(n => n[0]);
			if (S.iface && names.includes(S.iface)) return S.iface;
			if (wanDev && names.includes(wanDev)) return (S.iface = wanDev);
			const prefer = names.find(n => /^(wan|eth1|pppoe|usb|lte|wwan)/.test(n)) || names.find(n => /^eth/.test(n)) || names[0];
			return (S.iface = prefer);
		}

		function ifaceTitle(n) {
			const r = devRole[n];
			const kind = /^br-|^lan/.test(n) ? _('LAN-мост') : /^(wlan|phy)/.test(n) ? 'Wi-Fi' : null;
			return [ n, r ? r.toUpperCase() : kind ];
		}

		function renderLogTools() {
			const k = S.logK || 'all', q = logQ.value.trim().toLowerCase();
			for (const b of logChips.children) b.classList.toggle('on', b.getAttribute('data-k') === k);
			const items = [];
			const h = S.hist;
			if (h && h.events) for (const e of h.events) items.push({ t: e[0], k: 'ev', cls: e[1], txt: e[2] });
			const j = S.jrn;
			if (j && j.rows) for (const r of j.rows) items.push(r[1] === 'outage' ? { t: r[0], k: 'jr', cls: 'crit', txt: _('Обрыв связи: ') + trEv(r[3]) + (r[2] ? ' (' + fmtDur(r[2]) + ')' : '') } : { t: r[0], k: 'jr', cls: 'info', txt: _('Перезагрузка: ') + trEv(r[3]) });
			const bl = S.blog;
			if (bl && bl.log) for (const r of bl.log) items.push({ t: r[0], k: 'bl', cls: r[3] === 'on' ? 'warn' : 'info', txt: (r[2] || r[1]) + (r[3] === 'on' ? _(': доступ закрыт') : _(': доступ открыт')) + (r[4] ? ' · ' + r[4] : '') });
			if (!h && !j && !bl) { logBox.replaceChildren(E('div', { class: 'nfm-empty' }, _('Загружаю…'))); return; }
			const seen = new Set();
			const since = S.logP ? Date.now() / 1000 - S.logP : 0;
			const pins = pinLoad(), pid = x => x.t + '|' + x.txt;
			const list = items.filter(x => (k === 'all' || x.k === k || (k === 'pin' && pins.includes(pid(x)))) && (k === 'pin' || x.t >= since || pins.includes(pid(x))) && (!q || x.txt.toLowerCase().includes(q) || trEv(x.txt).toLowerCase().includes(q)))
				.sort((a, b) => (pins.includes(pid(b)) - pins.includes(pid(a))) || b.t - a.t).filter(x => { const id = x.t + '|' + x.txt; if (seen.has(id)) return false; seen.add(id); return true; })				.slice(0, 2000);
			logShown = list;
			logBox.replaceChildren(...(list.length ? list.slice(0, 200).map(x => E('div', { class: 'nfm-ev-i ' + x.cls }, [ E('i'), E('time', {}, fmtTs(x.t)), E('span', {}, [ trEv(x.txt), E('button', { type: 'button', class: 'nfm-pin' + (pins.includes(pid(x)) ? ' on' : ''), title: pins.includes(pid(x)) ? _('Открепить') : _('Закрепить: запись останется сверху'), click: () => pinToggle(pid(x)) }, pins.includes(pid(x)) ? '★' : '☆') ]) ]))
				: [ E('div', { class: 'nfm-empty' }, q || k !== 'all' ? _('Ничего не найдено. Измените фильтр или запрос.') : _('Записей пока нет.')) ]));
		}
		const SECBIN = '/usr/libexec/nightfall-sec';
		const isExternalIp = ip => !/^(10\.|127\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|(fe[89ab]|f[cd])[0-9a-f]*:|::1?$)/i.test(ip) && /^[0-9a-f:.]+$/i.test(ip);
		const secAct = (args, msg) => fs.exec(SECBIN, args).then(r => { let j = null; try { j = JSON.parse(r.stdout); } catch (e) { /* ignore */ } if (!j || !j.ok) window.alert(trSec((j && j.error) || '') || _('Не получилось.'));
			S.at.sec = 0; S.at.bans = 0; })
			.catch(() => window.alert(_('Не получилось выполнить команду на роутере.')));
		const banBtn = ip => isExternalIp(ip) ? E('button', { type: 'button', class: 'nfm-btn', title: _('Роутер перестанет принимать пакеты с этого адреса на 24 часа (до перезагрузки роутера)'),
			click: () => { if (window.confirm(_('Закрыть адрес ') + ip + _(' для роутера на 24 часа?'))) secAct([ 'ban', ip, '24' ]); } }, _('Закрыть на 24 ч')) : '';
		const RISKY = { 21: _('FTP без шифрования'), 23: _('Telnet без шифрования'), 445: 'SMB', 139: 'SMB', 3389: _('удалённый рабочий стол'), 5900: 'VNC' };
		const routerLogLevel = x => {
			/* BusyBox crond logs a normal job dispatch at cron.err; it does not mean the job failed. */
			if (String(x[2] || '').toLowerCase() === 'crond' && /^USER\s+\S+\s+pid\s+\d+\s+cmd\s+/.test(String(x[3] || ''))) return 'notice';
			const priority = String(x[1] || '').trim().toLowerCase().split('.').pop();
			const source = String(x[2] || '') + ' ' + String(x[3] || '');
			const tagged = (source.match(/(?:^|[^a-z0-9_-])(?:[a-z0-9_.-]+)?\[(emerg|panic|alert|crit(?:ical)?|err(?:or)?|warn(?:ing)?|notice|info|debug)\]/i) || [])[1];
			const value = String(tagged || priority || '').toLowerCase();
			if (/^(emerg|panic|alert|crit|critical|err|error)$/.test(value)) return 'err';
			if (/^(warn|warning)$/.test(value)) return 'warn';
			if (value === 'notice') return 'notice';
			if (value === 'debug') return 'debug';
			if (value === 'info') return 'info';
			return 'info';
		};
		const routerLogMeta = {
			err: { cls: 'crit', tag: 'ERR', title: _('Ошибка') },
			warn: { cls: 'warn', tag: 'WARN', title: _('Предупреждение') },
			notice: { cls: 'notice', tag: 'NOTICE', title: _('Уведомление') },
			info: { cls: 'info', tag: 'INFO', title: _('Информация') },
			debug: { cls: 'debug', tag: 'DEBUG', title: _('Отладка') }
		};
		const routerLogDiagMeta = {
			wan: { title: _('WAN / интернет'), hint: _('События потери или восстановления WAN-соединения'), cls: 'crit' },
			dns: { title: 'DNS', hint: _('Ошибки DNS-службы или её конфигурации'), cls: 'warn' },
			wifi: { title: 'Wi-Fi', hint: _('Частые отключения или ошибки аутентификации клиентов'), cls: 'warn' },
			vpn: { title: _('VPN и прокси'), hint: _('Ошибки подключения, маршрута или handshake'), cls: 'warn' },
			service: { title: _('Службы роутера'), hint: _('Перезапуски, аварийные завершения или нехватка памяти'), cls: 'crit' },
			security: { title: _('Безопасность'), hint: _('Повторяющиеся неудачные попытки входа'), cls: 'warn' }
		};
		function routerLogDiagnosis(x) {
			const svc = String(x[2] || '').toLowerCase(), msg = String(x[3] || '').toLowerCase();
			const level = routerLogLevel(x);
			if (/^(netifd|udhcpc|pppd|odhcp6c)$/.test(svc) &&
				/(wan|interface|carrier|link|lease|lcp)/.test(msg) &&
				/(now down|link is down|lost carrier|no lease|lease lost|lcp terminated|failed to bring up|network unreachable|no route to host|ifdown)/.test(msg))
				return 'wan';
			if (/dnsmasq|smartdns|unbound|https-dns|stubby/.test(svc) &&
				/(no servers found|failed to create listening socket|failed to bind|cannot assign requested address|no address range available|cannot read .*resolv)/.test(msg))
				return 'dns';
			if (/^(sing-box|xray|v2ray|openvpn|wg|wireguard|tailscale|zerotier|nikki|podkop|mihomo|clash)$/.test(svc) &&
				(level === 'err' || level === 'warn') &&
				/(handshake.*timed out|timeout|connection refused|failed|error|unreachable|no route)/.test(msg))
				return 'vpn';
			if (/^(procd|kernel)$/.test(svc) &&
				/(respawn|crash|segfault|out of memory|oom-kill|killed process|process .* exited)/.test(msg))
				return 'service';
			if (/^(hostapd|wpad|wpa_supplicant)$/.test(svc) &&
				(level === 'err' || level === 'warn') &&
				/(deauth|disassoc|disconnected|authentication failed|handshake failed)/.test(msg))
				return 'wifi';
			if (/^(dropbear|luci|uhttpd)$/.test(svc) &&
				/(bad password|failed login|login attempt for nonexistent|authentication failed)/.test(msg))
				return 'security';
			return '';
		}
		function routerLogFingerprint(x) {
			const svc = String(x[2] || 'unknown').toLowerCase();
			const level = routerLogLevel(x);
			const msg = String(x[3] || '').toLowerCase().replace(/\b(pid|port|id)[=: ]+\d+\b/g, '$1=#')
				.replace(/\s+/g, ' ').trim();
			return svc + '|' + level + '|' + msg;
		}
		function groupRouterLogRows(rows) {
			if (S.rlGrouped === false) return rows.slice().reverse().map((x, i) => ({ rows: [ x ], lastIndex: rows.length - i, key: routerLogFingerprint(x) + '|' + String(x[0] || '') + '|' + String(x[3] || '') }));
			const map = new Map();
			rows.forEach((x, i) => {
				const key = routerLogFingerprint(x);
				if (!map.has(key)) map.set(key, { key, rows: [], lastIndex: i });
				const group = map.get(key);
				group.rows.push(x); group.lastIndex = i;
			});
			return Array.from(map.values()).sort((a, b) => b.lastIndex - a.lastIndex);
		}
		function setRouterLogAutoLabel() {
			rlAutoBtn.textContent = S.rlAuto === false ? _('Автообновление: выкл') : _('Автообновление: вкл');
			rlAutoBtn.classList.toggle('on', S.rlAuto !== false);
		}
		function routerLogRowText(x) {
			return [ x[0], x[1], x[2], x[3] ].map(v => String(v == null ? '' : v)).join(' ');
		}
		function copyRouterLogRows(rows) {
			const value = rows.map(routerLogRowText).join('\n');
			if (!value) { rlStatus.textContent = _('Нет записей для копирования'); return; }
			const done = () => { rlStatus.textContent = _('Скопировано: ') + rows.length + _(' записей'); };
			const fallback = () => {
				const area = document.createElement('textarea');
				area.value = value; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
				document.body.appendChild(area); area.select();
				let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
				area.remove(); if (ok) done(); else rlStatus.textContent = _('Не удалось скопировать — используйте экспорт CSV');
			};
			if (window.navigator && window.navigator.clipboard && window.navigator.clipboard.writeText)
				window.navigator.clipboard.writeText(value).then(done).catch(fallback);
			else fallback();
		}
		function copyRouterLog() { copyRouterLogRows(rlVisible); }
		function exportRouterLog() {
			const quote = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
			const csv = _('\ufeffвремя;приоритет;служба;сообщение\n') + rlVisible.map(x => [ x[0], x[1], x[2], x[3] ].map(quote).join(';')).join('\n');
			const url = URL.createObjectURL(new Blob([ csv ], { type: 'text/csv;charset=utf-8' }));
			const a = E('a', { href: url, download: 'nightfall-router-log.csv' });
			document.body.appendChild(a); a.click(); a.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 30000);
			rlStatus.textContent = _('Экспортировано: ') + rlVisible.length + _(' записей');
		}
		function refreshRouterLog() {
			rlStatus.textContent = _('Обновляю журнал…');
			S.at.rlog = Date.now();
			fs.exec('/usr/libexec/nightfall-log', [ 'read', '800' ]).then(r => {
				const data = JSON.parse(r.stdout);
				if (!data || !data.ok || !Array.isArray(data.rows)) throw new Error(_('Некорректный ответ'));
				S.rlog = data; S.rlogUpdated = Date.now();
			}).catch(() => { S.rlog = null; })
				.then(() => renderRouterLog());
		}
		function renderRouterLog() {
			const R = S.rlog;
			for (const key of Object.keys(rlChipRefs))
				rlChipRefs[key].button.classList.toggle('on', key === (S.rlK || 'all'));
			setRouterLogAutoLabel();
			rlGroupBtn.textContent = S.rlGrouped === false ? _('Повторы: отдельно') : _('Повторы: сгруппированы');
			rlGroupBtn.classList.toggle('on', S.rlGrouped !== false);
			if (R === undefined) { rlBox.replaceChildren(E('div', { class: 'nfm-empty' }, _('Загружаю журнал роутера…'))); return; }
			if (!R || !R.ok || !Array.isArray(R.rows)) {
				rlVisible = []; rlSummary.replaceChildren(); rlDiag.replaceChildren();
				rlBox.replaceChildren(E('div', { class: 'nfm-empty' }, _('Не удалось получить журнал. Выйдите из LuCI и войдите снова после обновления.')));
				rlStatus.textContent = _('Нет данных'); rlMore.hidden = true; return;
			}
			const rows = R.rows.filter(x => Array.isArray(x) && x.length >= 4);
			const levels = rows.map(x => routerLogLevel(x));
			const counts = { all: rows.length, err: 0, warn: 0, info: 0, debug: 0 };
			rows.forEach((x, i) => { const l = levels[i]; if (l === 'err') counts.err++; else if (l === 'warn') counts.warn++; else if (l === 'debug') counts.debug++; else counts.info++; });
			const tabCounts = { all: counts.all, warn: counts.err + counts.warn, err: counts.err, info: counts.info, debug: counts.debug };
			for (const key of Object.keys(rlChipRefs)) rlChipRefs[key].count.textContent = String(tabCounts[key] || 0);
			const svcs = Array.from(new Set(rows.map(x => String(x[2] || _('неизвестно'))))).sort((a, b) => a.localeCompare(b, 'ru'));
			const currentServices = Array.from(rlSvc.options).slice(1).map(o => o.value);
			if (currentServices.join('\u0000') !== svcs.join('\u0000')) {
				const cur = rlSvc.value;
				rlSvc.replaceChildren(E('option', { value: '' }, _('Все службы')), ...svcs.map(v => E('option', { value: v }, v)));
				rlSvc.value = svcs.includes(cur) ? cur : '';
			}
			const diagnostics = {};
			rows.forEach(x => {
				const cat = routerLogDiagnosis(x);
				if (cat) {
					if (!diagnostics[cat]) diagnostics[cat] = [];
					diagnostics[cat].push(x);
				}
			});
			/* Wi-Fi disconnects and failed logins are noisy individually; only surface repeated bursts. */
			if (diagnostics.wifi && diagnostics.wifi.length < 5) delete diagnostics.wifi;
			if (diagnostics.security && diagnostics.security.length < 3) delete diagnostics.security;
			const diagKeys = Object.keys(diagnostics);
			rlDiag.replaceChildren(...(diagKeys.length ? [
				E('div', { class: 'nfm-log-diagnostics-head' }, [
					E('b', {}, _('Возможные проблемы')),
					E('span', {}, _('Подсказки по шаблонам журнала, не окончательный диагноз'))
				]),
				E('div', { class: 'nfm-log-diagnostic-list' }, diagKeys.map(cat => {
					const meta = routerLogDiagMeta[cat], items = diagnostics[cat];
					const button = E('button', { type: 'button', class: 'nfm-log-diagnostic ' + meta.cls + (S.rlDiag === cat ? ' on' : ''), click: () => { S.rlDiag = S.rlDiag === cat ? '' : cat; S.rlLimit = 300; renderRouterLog(); } }, [
						E('span', { class: 'nfm-log-diagnostic-title' }, meta.title),
						E('b', {}, String(items.length)),
						E('small', {}, meta.hint)
					]);
					return button;
				}))
			] : [ E('div', { class: 'nfm-log-diagnostics-empty' }, _('По текущим записям явных повторяющихся проблем не обнаружено.')) ]));
			const q = rlQ.value.trim().toLowerCase(), key = S.rlK || 'all', service = rlSvc.value;
			const filtered = rows.filter((x, i) => {
				const l = levels[i], searchable = (String(x[1]) + ' ' + String(x[2]) + ' ' + String(x[3])).toLowerCase();
				const typeMatch = key === 'all' || (key === 'err' && l === 'err') ||
					(key === 'warn' && (l === 'err' || l === 'warn')) ||
					(key === 'info' && (l === 'notice' || l === 'info')) || (key === 'debug' && l === 'debug');
				const diagMatch = !S.rlDiag || routerLogDiagnosis(x) === S.rlDiag;
				return typeMatch && diagMatch && (!service || String(x[2] || _('неизвестно')) === service) && (!q || searchable.includes(q));
			});
			rlVisible = filtered.slice().reverse();
			const groups = groupRouterLogRows(filtered);
			const limit = Math.max(1, S.rlLimit || 300), visible = groups.slice(0, limit);
			rlSummary.replaceChildren(
				E('span', { class: 'nfm-log-count' }, [ _('В памяти: '), E('b', {}, String(rows.length)) ]),
				E('span', { class: 'nfm-log-count crit' }, [ _('Ошибки: '), E('b', {}, String(counts.err)) ]),
				E('span', { class: 'nfm-log-count warn' }, [ _('Предупреждения: '), E('b', {}, String(counts.warn)) ]),
				E('span', { class: 'nfm-log-count info' }, [ _('Информация: '), E('b', {}, String(counts.info)) ]),
				S.rlDiag ? E('button', { type: 'button', class: 'nfm-btn', click: () => { S.rlDiag = ''; renderRouterLog(); } }, _('Сбросить диагностику')) : ''
			);
			const logScrollTop = rlBox.scrollTop;
			rlBox.replaceChildren(...(visible.length ? visible.map(group => {
				const x = group.rows[group.rows.length - 1], l = routerLogLevel(x);
				const meta = routerLogMeta[l] || routerLogMeta.info, serviceName = String(x[2] || _('неизвестно'));
				const time = String(x[0] || '').replace(/^([A-Z][a-z]{2}) (\d+) /, (m, a, d) => d + ' ' + (MONRU[a] || a) + ', ');
				const repeats = group.rows.length;
				const occurrences = repeats > 1 ? E('div', { class: 'nfm-log-occurrences' }, group.rows.slice().reverse().map(row =>
					E('div', {}, [ E('time', {}, String(row[0] || '')), E('span', {}, String(row[1] || '')), E('span', {}, String(row[3] || '')) ])
				)) : '';
				const groupKey = group.key || routerLogFingerprint(x);
				const item = E('details', { class: 'nfm-rlog-item', 'data-log-key': groupKey }, [
					E('summary', { class: 'nfm-ev-i ' + meta.cls, title: _('Раскрыть подробности записи') }, [
						E('i', { 'aria-hidden': 'true' }), E('time', {}, time),
						E('span', { class: 'nfm-log-line' }, [
							E('b', { class: 'nfm-log-service' }, serviceName),
							E('span', { class: 'nfm-log-level ' + meta.cls, title: meta.title }, meta.tag),
							E('span', { class: 'nfm-log-text' }, String(x[3] || '')),
							repeats > 1 ? E('span', { class: 'nfm-log-repeat' }, '× ' + repeats) : ''
						])
					]),
					E('div', { class: 'nfm-log-detail' }, [
						E('div', { class: 'nfm-log-detail-head' }, [
							E('div', { class: 'nfm-log-detail-meta' }, [
								E('span', {}, [ _('Служба: '), E('b', {}, serviceName) ]),
								E('span', {}, [ _('Приоритет syslog: '), E('b', {}, String(x[1] || _('не указан'))) ]),
								E('span', {}, [ _('Класс: '), E('b', {}, meta.title) ]),
								E('span', {}, [ _('Повторов в буфере: '), E('b', {}, String(repeats)) ]),
								E('span', {}, [ _('Первое событие: '), E('b', {}, String(group.rows[0][0] || _('не указано'))) ]),
								E('span', {}, [ _('Последнее событие: '), E('b', {}, String(x[0] || _('не указано'))) ])
							]),
							E('button', { type: 'button', class: 'nfm-btn', click: ev => { ev.preventDefault(); copyRouterLogRows(group.rows); } }, repeats > 1 ? _('Копировать группу') : _('Копировать запись'))
						]),
						occurrences,
						E('pre', { class: 'nfm-log-full' }, String(x[3] || ''))
					])
				]);
				item.open = !!(S.rlExpanded && S.rlExpanded[groupKey]);
				item.addEventListener('toggle', () => {
					if (!item.isConnected) return;
					if (!S.rlExpanded) S.rlExpanded = {};
					if (item.open) S.rlExpanded[groupKey] = true;
					else delete S.rlExpanded[groupKey];
				});
				return item;
			}) : [ E('div', { class: 'nfm-empty' }, _('Ничего не найдено по выбранным условиям.')) ]));
			rlBox.scrollTop = logScrollTop;
			rlMore.hidden = groups.length <= visible.length;
			rlMore.firstChild.textContent = _('Показать ещё (') + Math.min(300, groups.length - visible.length) + _(' из ') + groups.length + ')';
			const updated = S.rlogUpdated ? new Date(S.rlogUpdated).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : _('ещё не обновлялся');
			rlStatus.textContent = _('Показано ') + visible.length + _(' групп из ') + groups.length + _(' · записей ') + filtered.length + _(' · обновлено ') + updated;
		}
		function renderSec() {
			const R = S.sec;
			if (R === undefined) return;
			if (!R || !R.ok) {
				secVerdict.className = 'nfm-hint'; secVerdict.textContent = R === false ? MISSING : _('Не удалось получить данные') + (S.secErr ? ' (' + S.secErr + ')' : '') + _('. Если там «Permission denied» или «Access denied», выйдите из LuCI и войдите снова (нужны новые права).');
				return;
			}
			const lg = R.logins || {}, fw = R.fw || {}, ports = R.ports || [], nd = R.newdev || [];
			const fails = (lg.failed_ssh || 0) + (lg.failed_luci || 0);
			const open = ports.filter(p => p[2] === 'all');
			const week = nd.filter(d => R.now - d[2] <= 604800);
			const reds = fw.redirects || [];
			T.sFail.textContent = String(fails); T.sNew.textContent = String(week.length);
			T.sOpen.textContent = String(open.length); T.sFw.textContent = String(reds.length);
			const wanClosed = fw.wan_input === 'REJECT' || fw.wan_input === 'DROP';
			const risky = open.filter(p => RISKY[p[1]]);
			let msg, cls = 'ok';
			if (risky.length) { msg = _('Внимание: открыт порт ') + risky.map(p => p[1] + ' (' + RISKY[p[1]] + ')').join(', ') + _('. Если он не нужен, выключите службу.'); cls = 'bad'; }
			else if (fails >= 20) { msg = _('В журнале много неудачных входов (') + fails + _('). Если SSH или LuCI доступны из интернета, закройте их или смените пароль.'); cls = 'warn'; }
			else if (!wanClosed && fw.wan_input) { msg = _('Входящие соединения из интернета на роутер разрешены (политика «') + fw.wan_input + _('»). Обычно здесь должно быть «REJECT».'); cls = 'warn'; }
			else if (reds.length) { msg = _('Из интернета проброшено портов: ') + reds.length + _('. Проверьте, что они нужны.'); cls = 'warn'; }
			else msg = _('Явных проблем не видно: входящие из интернета закрыты') + (fw.wan_input ? ' (' + fw.wan_input + ')' : '') + _(', проброшенных портов нет.');
			const chk = R.checks || [], badChk = chk.filter(c => c[0] === 'bad');
			if (badChk.length && cls === 'ok') { msg = _('Есть что исправить: ') + trSec(badChk[0][1]); cls = 'bad'; }
			secVerdict.className = 'nfm-hint sec-' + cls; secVerdict.textContent = msg;
			secChecks.replaceChildren(...(chk.length ? chk.map(c => E('div', { class: 'nfm-ev-i nt ' + ({ bad: 'crit', warn: 'warn', ok: 'info' })[c[0]] }, [ E('i'), E('span', {}, trSec(c[1])) ])) : [ E('div', { class: 'nfm-empty' }, _('Нет данных: обновите тему на роутере.')) ]));

			const ago = fmtSyslogDay;
			secLogins.replaceChildren(
				E('div', { class: 'nfm-s' }, _('Неудачных попыток в журнале: SSH ') + (lg.failed_ssh || 0) + ', LuCI ' + (lg.failed_luci || 0) + _('. Журнал роутера хранит только последние события с момента загрузки.')),
				(lg.top || []).length ? E('div', { style: 'margin:10px 0' }, [ E('div', { class: 'nfm-k' }, _('Чаще всего ломятся с адресов')), ...(lg.top || []).map(x => E('div', { class: 'nfm-host' }, [ E('span', {}, x[0]), E('span', { style: 'display:flex;gap:10px;align-items:center' }, [ E('b', {}, String(x[1])), banBtn(x[0]) ]) ])) ]) : '',
				E('div', { class: 'nfm-evlist', style: 'margin-top:8px' }, (lg.recent || []).length ? (lg.recent || []).map(x => E('div', { class: 'nfm-ev-i ' + (x[2] ? 'info' : 'warn') }, [ E('i'), E('time', {}, ago(x[0])),
					E('span', {}, (x[1] === 'ssh' ? 'SSH' : 'LuCI') + (x[2] ? _(': вход ') : _(': неудачная попытка ')) + x[3] + _(' с ') + x[4]) ])) : [ E('div', { class: 'nfm-empty' }, _('Попыток входа в журнале нет.')) ]));
			secPorts.replaceChildren(
				E('div', { class: 'nfm-note-s', style: 'margin-bottom:8px' }, _('Порты, которые слушает сам роутер. «Для сети» — доступен с других устройств; из интернета его закрывает межсетевой экран') + (fw.wan_input ? _(' (входящее на WAN: ') + fw.wan_input + ')' : '') + '.'),
				E('table', { class: 'nfm-table' }, [ E('thead', {}, E('tr', {}, [ E('th', {}, _('Порт')), E('th', {}, _('Программа')), E('th', {}, _('Кто может подключиться')) ])),
					E('tbody', {}, ports.map(p => E('tr', {}, [ E('td', {}, p[0].toUpperCase() + ' ' + p[1]), E('td', {}, p[3] === '-' ? E('i', {}, _('не определена')) : p[3]),
						E('td', {}, [ p[2] === 'all' ? _('для сети') : _('только сам роутер'), RISKY[p[1]] ? E('span', { class: 'nfm-chip', style: 'margin-left:6px' }, RISKY[p[1]]) : '' ]) ]))) ]),
				reds.length ? E('div', { style: 'margin-top:12px' }, [ E('div', { class: 'nfm-k' }, _('Проброс портов из интернета')), ...reds.map(x => E('div', { class: 'nfm-host' }, [ E('span', {}, (x[0] || _('без имени')) + ': ' + (x[1] || 'tcp').toUpperCase() + ' ' + x[2] + ' → ' + x[3] + ':' + (x[4] || x[2])) ])) ]) : '');
			secDev.replaceChildren(...(nd.length ? nd.map(d => E('div', { class: 'nfm-host' }, [ E('span', {}, [ d[1] || _('без имени'), E('small', {}, d[0]) ]), E('b', {}, d[2] ? fmtTs(d[2]) : '') ])) : [ E('div', { class: 'nfm-empty' }, _('Сборщик ещё не видел новых устройств.')) ]));
			const BN = S.bans;
			secBans.replaceChildren(...(BN && BN.ok && (BN.bans || []).length ? [ E('div', { class: 'nfm-note-s', style: 'margin-bottom:8px' }, _('Эти адреса не могут обращаться к самому роутеру. Закрытие снимается само по сроку или после перезагрузки роутера.')),
				...BN.bans.map(b => E('div', { class: 'nfm-host' }, [ E('span', {}, b[0]), E('span', { style: 'display:flex;gap:10px;align-items:center' }, [ E('small', {}, b[1] ? _('осталось ') + b[1] : ''), E('button', { type: 'button', class: 'nfm-btn', click: () => secAct([ 'unban', b[0] ]) }, _('Открыть')) ]) ])) ]
				: [ E('div', { class: 'nfm-empty' }, BN === undefined ? _('Проверяю…') : _('Закрытых адресов нет. Закрыть адрес можно кнопкой рядом с нарушителем в «Попытках входа».')) ]));
			const U = S.secu;
			if (U && U.ok) {
				const th = U.theme || {};
				secUpd.replaceChildren(
					E('div', { class: 'nfm-host' }, [ E('span', {}, 'Nightfall'), E('b', {}, th.installed ? 'v' + th.installed : '–') ]),
					th.latest ? E('div', { class: 'nfm-s' }, th.new ? [ _('Вышла новая версия v') + th.latest + _('. Обновить: команда /update в Telegram-боте или установщик в терминале роутера (install-update.sh --list покажет версии).') ] : _('Установлена последняя версия.')) : E('div', { class: 'nfm-s' }, _('Не удалось проверить новую версию (нет связи с GitHub).')),
					E('div', { class: 'nfm-host' }, [ E('span', {}, 'OpenWrt'), E('b', {}, U.openwrt || '–') ]),
					E('div', { class: 'nfm-host' }, [ E('span', {}, _('Ядро')), E('b', {}, U.kernel || '–') ]),
					E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, _('Обновления пакетов и прошивки проверяйте в «Система → Программное обеспечение» и «Система → Резервное копирование / обновление».')));
			} else secUpd.replaceChildren(E('div', { class: 'nfm-empty' }, U === undefined ? _('Проверяю…') : _('Не удалось получить данные.')));
		}
		/* «Устройства»: карточка «Доступ в интернет» (блокировка, лимиты, расписание, группы) — та же, что на «Обзоре» */
		let blk = null, blkTried = false;
		function renderDevBlock() {
			if (blk || blkTried) return;
			blkTried = true;
			const holder = E('div', { class: 'nfm-grid' });
			devsTab.insertBefore(holder, devsTab.firstChild);
			L.require('nightfall-overview').then(m => {
				if (!m || typeof m.blockCard !== 'function') throw new Error(_('нет'));
				blk = m.blockCard(); holder.appendChild(blk.el); blk.start();
			}).catch(() => { holder.appendChild(card(_('Доступ в интернет'), E('div', { class: 'nfm-empty' }, _('Блокировка и расписание доступны на странице «Обзор» (Статус → Обзор), карточка «Доступ в интернет».')))); });
		}

		function refresh() {
			const d = S.last;
			for (const k in tabBtns) {
				tabBtns[k].classList.toggle('on', S.tab === k);
				tabBtns[k].setAttribute('aria-selected', S.tab === k);
			}
			show(overview, S.tab === 'overview'); show(net, S.tab === 'net'); show(procs, S.tab === 'procs'); show(svcs, S.tab === 'svcs'); show(hist, S.tab === 'hist');
			show(wifiTab, S.tab === 'wifi'); show(devsTab, S.tab === 'devs'); show(appsTab, S.tab === 'apps'); show(diagTab, S.tab === 'diag'); show(secTab, S.tab === 'sec'); show(logTab, S.tab === 'log'); show(tgTab, S.tab === 'tg');
			if (!d) return;

			T.uptime.textContent = fmtUptime(d.up);

			/* cards */
			const cn = d.cpu.length - 1;
			const c = S.cpuNow;
			rCpu.set(c ? c.pct : 0, c ? nf0.format(c.pct) + '%' : '–');
			T.cpuCores.textContent = _('%s %s').format(cn, cn === 1 ? _('ядро') : (cn < 5 ? _('ядра') : _('ядер')));
			T.cpuLoad.textContent = _('нагрузка ') + d.load.map(v => nf2.format(v)).join(' · ');

			const tp = S.temps;
			if (tp.main != null) {
				const cls = tp.main >= 85 ? 'hot' : tp.main >= 70 ? 'warn' : '';
				rTemp.set(tp.main, nf0.format(tp.main) + '°');
				rTemp.el.querySelector('.nfm-ring-fg').setAttribute('class', 'nfm-ring-fg c-temp ' + cls);
				T.tempMain.textContent = _('процессор ') + fmtTemp(tp.main);
				T.tempSub.textContent = tp.wifi.length ? 'Wi-Fi ' + tp.wifi.map(v => nf0.format(v) + '°').join(' / ') : _('датчики Wi-Fi не найдены');
			} else {
				rTemp.set(0, '–');
				T.tempMain.textContent = _('нет датчика');
				T.tempSub.textContent = _('система не сообщает температуру');
			}

			const m = d.mem, used = m.total - m.avail;
			rMem.set(100 * used / m.total, nf0.format(100 * used / m.total) + '%');
			T.memMain.textContent = _('%s из %s').format(fmtMB(used), fmtMB(m.total));
			T.memSub.textContent = _('кеш %s · /tmp %s').format(fmtMB(m.cached + m.buffers), d.tmp ? fmtMB(d.tmp[1]) : '–');

			if (d.flash) {
				rFlash.set(100 * d.flash[1] / d.flash[0], nf0.format(100 * d.flash[1] / d.flash[0]) + '%');
				T.flashMain.textContent = _('%s из %s').format(fmtMB(d.flash[1]), fmtMB(d.flash[0]));
				T.flashSub.textContent = _('Свободно: %s').format(fmtMB(d.flash[0] - d.flash[1]));
				T.flashTotal.textContent = fmtMB(d.flash[0]);
				T.flashFree.textContent = fmtMB(d.flash[0] - d.flash[1]);
			}

			/* charts */
			const dataMain = { cpu: S.cpu, mem: S.mem, temp: S.temp };
			mainChart.update(S.times, dataMain, seriesMax());

			/* cores */
			while (coreRefs.length < S.cores.length) {
				const i = coreRefs.length;
				const fill = E('div', { class: 'nfm-bar-fill c-cpu' }), val = E('b', {}, '–');
				coresBox.appendChild(E('div', { class: 'nfm-core' }, [
					E('div', { class: 'nfm-core-h' }, [ E('span', {}, _('Ядро %s').format(i + 1)), val ]), E('div', { class: 'nfm-bar' }, fill) ]));
				coreRefs.push({ fill, val });
			}
			S.cores.forEach((v, i) => {
				if (!v) return;
				coreRefs[i].fill.style.width = Math.max(0, Math.min(100, v.pct)) + '%';
				coreRefs[i].val.textContent = nf0.format(v.pct) + '%';
			});
			if (c) {
				tileRefs.apps.textContent = nf0.format(c.apps) + '%';
				tileRefs.sys.textContent = nf0.format(c.sys) + '%';
				tileRefs.irq.textContent = nf1.format(c.irq) + '%';
				tileRefs.io.textContent = nf1.format(c.io) + '%';
			}

			/* network */
			const ifn = pickIface(d);
			T.netIface.textContent = ifn || '–';
			const rt = (S.rates || {})[ifn] || { rx: 0, tx: 0 };
			const cur = d.net.find(n => n[0] === ifn);
			const h = S.net[ifn] || { rx: [], tx: [] };
			const hm = netMaxOf(h);
			netMini.update(S.times, h, { left: hm });
			sparkDown.update(S.times, h.rx, hm); sparkUp.update(S.times, h.tx, hm);
			const dr = fmtRate(rt.rx), ur = fmtRate(rt.tx);
			T.dlN.textContent = dr[0]; T.dlU.textContent = dr[1]; T.ulN.textContent = ur[0]; T.ulU.textContent = ur[1];
			T.ctMini.textContent = _('%s%s').format(nf0.format(d.ct[0]), d.ct[1] ? _(' из ') + nf0.format(d.ct[1]) : '');
			if (S.tab === 'overview') renderTop3();
			updVerdict();

			if (S.tab === 'net') {
				T.nDlN.textContent = dr[0]; T.nDlU.textContent = dr[1]; T.nUlN.textContent = ur[0]; T.nUlU.textContent = ur[1];
				T.nDlTot.textContent = cur ? fmtBytes(cur[1]) : '–'; T.nUlTot.textContent = cur ? fmtBytes(cur[5]) : '–';
				T.ctN.textContent = nf0.format(d.ct[0]); T.ctMax.textContent = d.ct[1] ? _('из ') + nf0.format(d.ct[1]) : '';
				T.ctBar.style.width = d.ct[1] ? Math.min(100, 100 * d.ct[0] / d.ct[1]) + '%' : '0';
				const pr = S.full ? S.full.ctp : null;
				T.ctProto.textContent = pr ? _('TCP %s · UDP %s · прочие %s').format(nf0.format(pr[0]), nf0.format(pr[1]), nf0.format(pr[2])) : _('подробности недоступны');

				if (netSel.options.length !== d.net.length)
					netSel.replaceChildren(...d.net.map(n => { const o = ifaceTitle(n[0]); return E('option', { value: n[0] }, o[1] ? `${o[0]} (${o[1]})` : o[0]); }));
				netSel.value = ifn;
				netBig.update(S.times, h, { left: hm });

				ifBody.replaceChildren(...d.net.map(n => {
					const r = (S.rates || {})[n[0]] || { rx: 0, tx: 0 }, o = ifaceTitle(n[0]);
					return E('tr', {}, [ E('td', {}, [ n[0], o[1] ? E('span', { class: 'nfm-chip' }, o[1]) : '' ]),
						E('td', { class: 'r' }, rateText(r.rx)), E('td', { class: 'r' }, rateText(r.tx)),
						E('td', { class: 'r' }, fmtBytes(n[1])), E('td', { class: 'r' }, fmtBytes(n[5])),
						E('td', { class: 'r' }, nf0.format(n[3] + n[4] + n[7] + n[8])) ]);
				}));

				if (S.full && S.full.cth) {
					const top = S.full.cth, mx = top.length ? top[0][1] : 1;
					hostsBox.replaceChildren(...(top.length ? top.map(([ ip, n ]) => E('div', { class: 'nfm-host' }, [
						E('span', {}, [ names[ip] || ip, names[ip] ? E('small', {}, ip) : '' ]), E('b', {}, nf0.format(n)),
						E('div', { class: 'nfm-bar' }, E('div', { class: 'nfm-bar-fill c-cpu', style: `width:${100 * n / mx}%` })) ]))
						: [ E('div', { class: 'nfm-empty' }, _('Активных соединений нет')) ]));
				} else {
					hostsBox.replaceChildren(E('div', { class: 'nfm-empty' }, S.full ? _('Таблица соединений недоступна (нужен nf_conntrack).') : _('Собираю данные…')));
				}
			}

			renderAlerts();
			if (onTab('net', 'devs')) renderDevices();
			if (S.tab === 'devs') renderDevExtra();
			if (S.tab === 'procs') renderProcMem();
			if (S.tab === 'apps') renderAppTraffic();
			if (S.tab === 'net') { renderChannel(); renderDns(); renderExtIp(); }
			if (S.tab === 'svcs') renderServices();
			if (S.tab === 'hist') { renderHist(); renderDay(); renderHeat(); renderWeek(); renderCmp(); renderMon(); renderWq(); renderWHeat(); renderAir(); renderJournal(); renderSpeed(); renderFlash(); }
			if (S.tab === 'wifi') { renderWq(); renderWHeat(); renderAir(); renderWifiExtra(); }
			if (S.tab === 'log') { renderHist(); renderJournal(); renderLogTools(); renderRouterLog(); }
			if (S.tab === 'diag') renderSpeed();
			if (S.tab === 'sec') renderSec();
			if (S.tab === 'tg') { renderTelegram(); if (!S.tgInfo || Date.now() - (S.tgInfoAt || 0) > 30000) loadTelegram(false); }
			if (S.tab === 'devs') renderDevBlock();

			/* overheating banner */
			const hot = hotInfo();
			hotBox.toggleAttribute('hidden', !hot || tempAlertOn());
			if (hot) {
				hotBox.classList.toggle('danger', hot.crit);
				hotBox.classList.toggle('warning', !hot.crit);
				hotBox.firstChild.textContent = hot.crit ? _('Критический перегрев процессора') : _('Процессор перегрет');
				hotBox.lastChild.textContent = _('Температура %s держится выше %s °C уже более %s мин. Проверьте вентиляцию и не накрывайте роутер.').format(fmtTemp(hot.temp), HOT_WARN, Math.max(1, Math.round(hot.dur / 60)));
			}

			/* wifi clients */
			T.wifiMini.textContent = S.wifi ? nf0.format(wifiDisplayRows().length) : '–';
			if (onTab('net', 'wifi')) {
				const rows = wifiDisplayRows().slice().sort((a, b) => (b.signal || -999) - (a.signal || -999)).map(c => {
					const mac = (c.mac || '').toUpperCase(), h = hints[mac] || hints[mac.toLowerCase()] || {};
					const deviceName = c.displayName || (!c.proxyStation ? h.name : '') || (!c.proxyStation ? (h.ipaddrs || [])[0] : '') || (!c.proxyStation ? c.ip : '') || mac;
					const lvl = c.proxy ? 0 : c.signal >= -55 ? 4 : c.signal >= -65 ? 3 : c.signal >= -75 ? 2 : 1;
					const link = x => x && x.rate ? nf0.format(x.rate / 1000) + '\u00a0' + _('Мбит/с') : '–';
					return E('tr', { class: 'nfm-click', title: _('Показать сигнал в динамике'), click: () => { if (!c.proxy) wifiDialog(mac, deviceName, c); } }, [
						E('td', {}, [ deviceName, (c.displayName || (!c.proxyStation && h.name)) ? E('span', { class: 'nfm-chip' }, mac) : '' ]),
						E('td', {}, [ c.ssid, c.proxy ? E('span', { class: 'nfm-chip' }, _('за точкой доступа')) : c.proxyStation ? E('span', { class: 'nfm-chip' }, _('точка доступа / мост')) : c.band ? E('span', { class: 'nfm-chip' }, BANDS[c.band] || c.band) : '' ]),
						E('td', {}, c.proxy ? '—' : [ E('span', { class: 'nfm-sig' + (lvl <= 2 ? ' weak' : '') }, [ 1, 2, 3, 4 ].map(n => E('i', { class: n <= lvl ? 'on' : '' }))), c.signal + _(' дБм') ]),
						E('td', { class: 'r' }, c.proxy ? '—' : link(c.tx)), E('td', { class: 'r' }, c.proxy ? '—' : link(c.rx)),
						E('td', { class: 'r' }, c.proxy ? ((c.proxyState === 'REACHABLE' || c.proxyState === 'DELAY' || c.proxyState === 'PROBE') ? _('через ретранслятор · доступен') : _('через ретранслятор · не подтверждён')) : c.connected_time != null ? fmtDur(c.connected_time) : '–') ]);
				});
				wifiBody.replaceChildren(...(rows.length ? rows : [ E('tr', {}, E('td', { colspan: 6, class: 'nfm-empty' },
					S.wifi ? _('Подключённых Wi-Fi клиентов нет') : _('Данные о Wi-Fi недоступны') + (wifiErr ? ' (' + wifiErr + ')' : ''))) ]));
			}

			/* memory by program */
			if (S.full) {
				const f = S.full, g = groupedProcs().sort((a, b) => b.rss - a.rss);
				const top = g.slice(0, 6), rest = g.slice(6);
				const restRss = rest.reduce((s, e) => s + e.rss, 0);
				const sumRss = g.reduce((s, e) => s + e.rss, 0);
				const kernel = Math.max(0, f.mem.total - f.mem.free - sumRss);
				const items = top.map(e => ({ label: e.label, cls: e.cls, kb: e.rss }));
				if (restRss > 0) items.push({ label: _('Остальные программы'), cls: 'gx', kb: restRss });
				items.push({ label: _('Ядро, буферы и /tmp'), cls: 'hatch', kb: kernel });
				items.push({ label: _('Свободно'), cls: 'free', kb: f.mem.free });
				memStack.replaceChildren(...items.map(i => E('div', { class: 'nfm-seg ' + i.cls, title: `${i.label}: ${fmtMB(i.kb)}`, style: `flex:${i.kb} 1 0` })));
				memLegend.replaceChildren(...items.map(i => E('span', { class: 'nfm-leg' }, [
					E('i', { class: 'nfm-dot ' + (i.cls === 'hatch' || i.cls === 'free' ? '' : i.cls), style: i.cls === 'hatch' ? 'background:repeating-linear-gradient(135deg,var(--nfm-border) 0 2px,transparent 2px 4px);border:1px solid var(--nfm-border)'
						: i.cls === 'free' ? 'background:var(--nfm-card2);border:1px solid var(--nfm-border)' : '' }),
					`${i.label} · ${fmtMB(i.kb)}` ])));
			}

			if (S.tab === 'procs' && S.full) {
				let g = groupedProcs();
				if (S.filter) g = g.filter(e => e.label.toLowerCase().includes(S.filter) || Object.keys(e.names).some(n => n.toLowerCase().includes(S.filter)));
				g.sort((a, b) => S.sort === 'cpu' ? (b.cpu - a.cpu || b.rss - a.rss) : (b.rss - a.rss));
				procBody.replaceChildren(...g.map(e => E('tr', {}, [
					E('td', {}, [ E('i', { class: 'nfm-dot ' + e.cls, style: 'margin-right:8px;vertical-align:middle' }), e.label,
						Object.keys(e.names).length > 1 || Object.keys(e.names)[0] !== e.label ? E('span', { class: 'nfm-chip' }, Object.keys(e.names).slice(0, 3).join(', ') + (Object.keys(e.names).length > 3 ? '…' : '')) : '' ]),
					E('td', { class: 'r' }, String(e.n)), E('td', { class: 'r' }, nf1.format(e.cpu) + '%'), E('td', { class: 'r' }, fmtMB(e.rss)) ])));
			}
		}

		const self = this;
		function tick() {
			if (S.paused) return Promise.resolve();
			const wantFull = S.tick++ % FULL_EVERY === 0 || (S.tab !== 'overview' && !S.full);
			const extras = fetchExtras();
			return Promise.all([ fs.exec(STATS, wantFull ? [ 'full' ] : []), wantFull ? fetchWifi() : Promise.resolve(undefined), extras ]).then(([ res, wifi ]) => {
				if (wifi !== undefined) S.wifi = wifi;
				let d = null;
				try { d = JSON.parse(res.stdout); } catch (e) {}
				if (!d) throw new Error(res.stderr || _('нет данных'));
				ingest(d);
				if (!S.paused && pill.classList.contains('paused')) pill.classList.remove('paused');
				if (!S.paused) pill.textContent = _('обновляется каждые %s с').format(INTERVAL);
				refresh();
			}).catch(err => {
				pill.textContent = _('нет данных: ') + (err.message || err);
				pill.classList.add('paused');
			});
		}

		refresh();
		tick();
		poll.add(tick, INTERVAL);
		self._state = S;
		return root;
	}
});
