'use strict';
'require view';
'require rpc';
'require fs';
'require poll';
'require ui';
'require network';
'require nightfall-devid as DevId';

/*
 * Nightfall resource monitor: CPU, memory, temperature, flash and network
 * activity in a Windows 11 / Fluent style dashboard.
 * Data comes from /usr/libexec/nightfall-stats (one JSON object per call).
 */

const STATS = '/usr/libexec/nightfall-stats';
const HIST = '/usr/libexec/nightfall-history';
const CFG = '/usr/libexec/nightfall-config';
const WINDOW = 300;          /* seconds shown in charts */
const INTERVAL = 2;          /* poll interval, seconds */
const FULL_EVERY = 5;        /* full (process) sample every N ticks */
const ALERTS_EVERY = 8;      /* collector alerts / last ping every N ticks */
const DEVICES_EVERY = 4;     /* per-device traffic every N ticks (network tab) */
const HIST_EVERY = 8;        /* history charts every N ticks (history tab) */
const RANGES = { h: [ 'fine', 3600, '1 час' ], d: [ 'coarse', 86400, '24 часа' ], w: [ 'coarse', 604800, '7 дней' ], m: [ 'long', 2592000, '30 дней' ], q: [ 'long', 7776000, '90 дней' ] };
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
const BANDS = { '2g': '2,4 ГГц', '5g': '5 ГГц', '6g': '6 ГГц', '60g': '60 ГГц' };

const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

const PORTS = { 443: 'HTTPS', 80: 'HTTP', 53: 'DNS', 853: 'DNS-over-TLS', 22: 'SSH', 123: 'Время (NTP)', 5228: 'Google Play / push', 5223: 'Apple push',
	3478: 'Звонки (STUN)', 3479: 'Звонки (STUN)', 1194: 'OpenVPN', 51820: 'WireGuard', 25: 'Почта (SMTP)', 465: 'Почта (SMTP)', 587: 'Почта (SMTP)', 993: 'Почта (IMAP)',
	143: 'Почта (IMAP)', 110: 'Почта (POP3)', 995: 'Почта (POP3)', 8080: 'HTTP (альт.)', 8443: 'HTTPS (альт.)', 1935: 'Стриминг (RTMP)', 554: 'Видео (RTSP)',
	5353: 'mDNS', 1900: 'UPnP', 6881: 'Торренты', 3389: 'RDP', 445: 'SMB', 21: 'FTP', 5222: 'XMPP', 8000: 'HTTP (альт.)', 8883: 'MQTT', 1883: 'MQTT' };
function portLabel(proto, port) {
	if (port === '-' || port === '') return proto.toUpperCase();
	if (proto === 'udp' && port === '443') return 'QUIC / HTTP3 · UDP 443';
	return (PORTS[port] ? PORTS[port] + ' · ' : '') + proto.toUpperCase() + ' ' + port;
}
const SVC_INFO = { dnsmasq: 'DNS и DHCP', dropbear: 'SSH-доступ', uhttpd: 'Веб-сервер LuCI', rpcd: 'API панели', firewall: 'Файрвол', network: 'Сетевые интерфейсы',
	odhcpd: 'DHCPv6 и RA', sysntpd: 'Синхронизация времени', ttyd: 'Веб-терминал', 'https-dns-proxy': 'DNS поверх HTTPS', 'nightfall-collector': 'Сборщик истории монитора',
	log: 'Системный журнал', cron: 'Планировщик задач', ubus: 'Шина ubus', irqbalance: 'Распределение прерываний', wpad: 'Wi-Fi (hostapd/wpa_supplicant)', hostapd: 'Wi-Fi точка доступа' };
const SVC_PROTECTED = [ 'network', 'uhttpd', 'rpcd', 'dropbear', 'firewall', 'dnsmasq', 'odhcpd', 'log', 'ubus', 'boot', 'system', 'done', 'sysfixtime', 'wpad' ];

const GROUPS = [
	[ /^dnsmasq$/, 'DNS (dnsmasq)', 'g1' ],
	[ /^(uhttpd|rpcd|ucode|luci|nightfall)/, 'Панель и LuCI', 'g2' ],
	[ /^(hostapd|wpa_|wpad|iw|mt76|ath)/, 'Wi-Fi', 'g3' ],
	[ /^(ttyd|dropbear|sshd|login|getty)/, 'Терминал', 'g4' ],
	[ /^(sing-box|xray|v2ray|clash|mihomo|openvpn|wg|tailscale|zerotier|nikki|podkop)/, 'VPN и прокси', 'g5' ],
	[ /^(nginx|lighttpd|adguard|AdGuard|unbound|stubby|https-dns|smartdns|mosdns)/, 'Сетевые службы', 'g6' ],
	[ /^(procd|ubusd|netifd|logd|odhcp|crond|ntpd|busybox|sh$|ash$|init|syslog|dnsmasq-|fw4|nft|rngd|urngd|ubox|swconfig|hotplug|sleep|awk|cat)/, 'OpenWrt', 'g7' ]
];

function fmtMB(kb) {
	const mb = kb / 1024;
	if (mb >= 1024) return nf2.format(mb / 1024) + ' ГБ';
	return (mb >= 100 ? nf0 : nf1).format(mb) + ' МБ';
}

function fmtBytes(b) {
	const u = [ 'Б', 'КБ', 'МБ', 'ГБ', 'ТБ' ];
	let i = 0;
	while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
	return (i < 2 ? nf0 : nf2).format(b) + ' ' + u[i];
}

function fmtRate(bps) {
	const bits = bps * 8;
	if (bits >= 1e9) return [ nf2.format(bits / 1e9), 'Гбит/с' ];
	if (bits >= 1e6) return [ (bits >= 1e8 ? nf0 : nf1).format(bits / 1e6), 'Мбит/с' ];
	if (bits >= 1e3) return [ nf0.format(bits / 1e3), 'Кбит/с' ];
	return [ nf0.format(bits), 'бит/с' ];
}

function rateText(bps) {
	const r = fmtRate(bps);
	return r[0] + ' ' + r[1];
}

function fmtUptime(s) {
	const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
	return (d ? d + ' д ' : '') + h + ' ч ' + m + ' мин';
}

function fmtTemp(v) { return nf1.format(v) + ' °C'; }

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
@media (max-width: 640px) { .nfm-mini, .nfm-btn, .nfm-act, .nfm-tab { min-height: 40px; } .nfm-jr { grid-template-columns: 22px minmax(0, 1fr) auto; align-items: start; row-gap: 2px; } .nfm-jr .ic { grid-column: 1; grid-row: 1; } .nfm-jr time { grid-column: 2 / -1; grid-row: 1; } .nfm-jr > span:not(.ic) { grid-column: 2; grid-row: 2; min-width: 0; overflow-wrap: anywhere; } .nfm-jr b { grid-column: 3; grid-row: 2; } .nfm-svc { grid-template-columns: 12px minmax(0, 1fr); } .nfm-svc .ac { grid-column: 1 / -1; justify-content: flex-start; } }
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

/* ---------- widgets ---------- */

function ring(color) {
	const r = 31, c = 2 * Math.PI * r;
	const fg = SVG('circle', { cx: 40, cy: 40, r, fill: 'none', 'stroke-width': 9, 'stroke-linecap': 'round',
		'stroke-dasharray': `0 ${c}`, transform: 'rotate(-90 40 40)', class: 'nfm-ring-fg ' + color });
	const label = E('span', { class: 'nfm-ring-label' }, '–');
	const el = E('div', { class: 'nfm-ring' }, [
		SVG('svg', { viewBox: '0 0 80 80' }, [
			SVG('circle', { cx: 40, cy: 40, r, fill: 'none', 'stroke-width': 9, class: 'nfm-ring-bg' }), fg ]),
		label
	]);
	return {
		el,
		set(pct, text) {
			const p = Math.max(0, Math.min(100, pct || 0));
			fg.setAttribute('stroke-dasharray', `${c * p / 100} ${c}`);
			label.textContent = text;
		}
	};
}

let uid = 0;

/* time series chart: series = [{ key, cls, axis }], axes: left/right max */

/* стиль графиков из настроек темы (Персонализация → Графики): заливка, линия, столбики, ступени; сглаживание */
function nfPlot(segs, H) {
	const root = document.documentElement, kind = root.getAttribute('data-nf-chart') || 'area', smooth = root.getAttribute('data-nf-chart-smooth') !== 'off';
	const f = n => n.toFixed(1);
	let line = '', area = '';
	segs.forEach(p => {
		if (!p.length) return;
		let d = 'M' + f(p[0][0]) + ' ' + f(p[0][1]);
		if (kind === 'bars') {   /* столбики: вертикальные штрихи цвета ряда (без заливки) */
			p.forEach(q => { line += 'M' + f(q[0]) + ' ' + f(q[1]) + 'V' + H; });
			return;
		}
		if (kind === 'step') {
			for (let i = 1; i < p.length; i++) d += 'L' + f(p[i][0]) + ' ' + f(p[i - 1][1]) + 'L' + f(p[i][0]) + ' ' + f(p[i][1]);
		}
		else if (smooth && p.length > 2) {
			/* монотонная кубическая кривая: не выходит за пределы данных и не петляет там, где точки стоят неравномерно (пропуски в истории) */
			const n = p.length, dx = [], m = [], t = [];
			for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0]; m[i] = dx[i] > 0 ? (p[i + 1][1] - p[i][1]) / dx[i] : 0; }
			t[0] = m[0]; t[n - 1] = m[n - 2];
			for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
			for (let i = 0; i < n - 1; i++) {
				if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
				const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
				if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
			}
			for (let i = 0; i < n - 1; i++) {
				const h = dx[i] / 3, b = p[i], c = p[i + 1];
				d += 'C' + f(b[0] + h) + ' ' + f(Math.max(0, Math.min(H, b[1] + t[i] * h))) + ' ' + f(c[0] - h) + ' ' + f(Math.max(0, Math.min(H, c[1] - t[i + 1] * h))) + ' ' + f(c[0]) + ' ' + f(c[1]);
			}
		}
		else for (let i = 1; i < p.length; i++) d += 'L' + f(p[i][0]) + ' ' + f(p[i][1]);
		line += d;
		if (kind !== 'line') area += d + 'L' + f(p[p.length - 1][0]) + ' ' + H + 'L' + f(p[0][0]) + ' ' + H + 'Z';
	});
	return { line, area };
}

function chart(opts) {
	const id = 'nfm-g' + (++uid);
	const W = 300, H = 100;
	const defs = SVG('defs');
	const grid = SVG('g', { class: 'nfm-grid' });
	for (let i = 1; i < 5; i++)
		grid.appendChild(SVG('line', { x1: 0, x2: W, y1: H * i / 5, y2: H * i / 5, 'vector-effect': 'non-scaling-stroke' }));
	for (let i = 1; i < 5; i++)
		grid.appendChild(SVG('line', { x1: W * i / 5, x2: W * i / 5, y1: 0, y2: H, 'vector-effect': 'non-scaling-stroke' }));
	const layers = SVG('g');
	const parts = opts.series.map((s, i) => {
		const gid = `${id}-${i}`;
		defs.appendChild(SVG('linearGradient', { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 }, [
			SVG('stop', { offset: '0%', class: 'nfm-stop ' + s.cls, 'stop-opacity': s.fill ?? .28 }),
			SVG('stop', { offset: '100%', class: 'nfm-stop ' + s.cls, 'stop-opacity': 0 }) ]));
		const area = SVG('path', { fill: `url(#${gid})`, stroke: 'none' });
		const line = SVG('path', { fill: 'none', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke',
			'stroke-linejoin': 'round', class: 'nfm-line ' + s.cls });
		layers.appendChild(area); layers.appendChild(line);
		return { area, line, s };
	});

	const xh = SVG('line', { class: 'nfm-xh', x1: 0, x2: 0, y1: 0, y2: H, 'vector-effect': 'non-scaling-stroke', visibility: 'hidden' });
	const svg = SVG('svg', { class: 'nfm-plot', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' }, [ defs, grid, layers, xh ]);
	const tip = E('div', { class: 'nfm-tip', hidden: '' });
	const pts = opts.series.map(s => E('i', { class: 'nfm-pt ' + s.cls, hidden: '' }));
	const plotw = E('div', { class: 'nfm-plotw' }, [ svg ].concat(pts, [ tip ]));
	let cur = { times: [], data: {}, max: {}, now: 0, win: WINDOW }, hoverF = null;

	const yl = E('div', { class: 'nfm-yl' }), yr = E('div', { class: 'nfm-yr' });
	const xl = E('div', { class: 'nfm-xl' }, [ '−5 мин', '−4 мин', '−3 мин', '−2 мин', '−1 мин', 'сейчас' ].map(t => E('span', {}, t)));
	let xKey = '';
	const el = E('div', { class: 'nfm-chart' + (opts.right ? ' has-right' : '') , style: opts.height ? `--h:${opts.height}px` : '' }, [
		yl,
		plotw,
		opts.right ? yr : E('div'),
		E('div'), xl, E('div')
	]);

	function setLabels(node, max, fmt) {
		const labs = [];
		for (let i = 0; i <= 5; i++)
			labs.push(E('span', {}, fmt(max * (5 - i) / 5)));
		node.replaceChildren(...labs);
	}

	function hideTip() {
		hoverF = null;
		xh.setAttribute('visibility', 'hidden');
		tip.setAttribute('hidden', '');
		pts.forEach(p => p.setAttribute('hidden', ''));
	}

	function showTip(f) {
		const { times, data, max, now, win } = cur;
		if (!times.length) return hideTip();
		const t = now - win + f * win;
		let best = -1, bd = Infinity;
		for (let k = 0; k < times.length; k++) {
			const dd = Math.abs(times[k] - t);
			if (dd < bd) { bd = dd; best = k; }
		}
		if (best < 0 || now - times[best] > win) return hideTip();
		const x = Math.max(0, W - (now - times[best]) / win * W), pct = x / W * 100;
		xh.setAttribute('x1', x); xh.setAttribute('x2', x); xh.removeAttribute('visibility');
		const d = new Date(times[best] * 1000);
		const label = win <= 7200 ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
			: d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
		const rows = [ E('div', { class: 'nfm-tip-t' }, label) ];
		opts.series.forEach((s, i) => {
			const v = (data[s.key] || [])[best];
			const m = (s.axis === 'right' ? max.right : max.left) || 1;
			rows.push(E('div', { class: 'nfm-tip-r' }, [ E('i', { class: 'nfm-dot ' + s.cls }), (s.label || s.key) + ': ',
				E('b', {}, v == null ? '—' : (s.fmt ? s.fmt(v) : nf1.format(v))) ]));
			if (v == null) pts[i].setAttribute('hidden', '');
			else {
				pts[i].removeAttribute('hidden');
				pts[i].style.left = pct + '%';
				pts[i].style.top = (H - Math.min(1, v / m) * (H - 1) - .5) / H * 100 + '%';
			}
		});
		tip.replaceChildren(...rows);
		tip.removeAttribute('hidden');
		tip.classList.toggle('left', pct > 55);
		tip.style.left = pct + '%';
	}

	const onMove = ev => {
		const r = plotw.getBoundingClientRect();
		if (!r.width) return;
		hoverF = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
		showTip(hoverF);
	};
	plotw.addEventListener('pointermove', onMove);
	plotw.addEventListener('pointerdown', onMove);
	plotw.addEventListener('pointerleave', hideTip);
	plotw.addEventListener('pointercancel', hideTip);

	return {
		el,
		update(times, data, max, view) {
			/* max: { left, right }; view: { win, end, labels } for ranges other than the live 5 minutes */
			const win = view && view.win || WINDOW;
			const now = view && view.end || (times.length ? times[times.length - 1] : 0);
			if (view && view.labels && view.labels.join('|') !== xKey) {
				xKey = view.labels.join('|');
				xl.replaceChildren(...view.labels.map(t => E('span', {}, t)));
			}
			opts.series.forEach((s, i) => {
				const vals = data[s.key] || [];
				const m = (s.axis === 'right' ? max.right : max.left) || 1;
				const segs = [];
				let cur0 = null;
				for (let k = 0; k < times.length; k++) {
					if (vals[k] == null) { if (s.gaps) cur0 = null; continue; }
					if (now - times[k] > win) continue;
					const x = Math.max(0, W - (now - times[k]) / win * W);
					const y = H - Math.min(1, vals[k] / m) * (H - 1) - .5;
					if (!cur0) { cur0 = []; segs.push(cur0); }
					cur0.push([ x, y ]);
				}
				const pl = nfPlot(segs, H);
				parts[i].line.setAttribute('d', pl.line);
				parts[i].area.setAttribute('d', s.fill !== 0 ? pl.area : '');
			});
			setLabels(yl, max.left, opts.fmtLeft);
			if (opts.right) setLabels(yr, max.right, opts.fmtRight);
			cur = { times, data, max, now, win };
			if (hoverF != null) showTip(hoverF);
		}
	};
}

function sparkline(cls) {
	const W = 100, H = 30;
	const area = SVG('path', { class: 'nfm-spark-a ' + cls });
	const line = SVG('path', { fill: 'none', 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke', class: 'nfm-line ' + cls });
	return {
		el: SVG('svg', { class: 'nfm-spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' }, [ area, line ]),
		update(times, vals, max) {
			const now = times[times.length - 1] || 0, pts = [];
			for (let k = 0; k < times.length; k++) {
				if (vals[k] == null) continue;
				pts.push([ Math.max(0, W - (now - times[k]) / WINDOW * W), H - Math.min(1, vals[k] / max) * (H - 2) - 1 ]);
			}
			const pl = nfPlot([ pts ], H);
			line.setAttribute('d', pl.line);
			area.setAttribute('d', pl.area);
		}
	};
}

const CARD_ICONS = [
	[ /^Wi.Fi:|сигнал Wi.Fi/i, 'wifi' ], [ /журнал/i, 'events' ], [ /хранен|износ/i, 'disk' ], [ /канал/i, 'net' ], [ /служб/i, 'quick' ],
	[ /сводка/i, 'events' ], [ /процессор|программ|ядр/i, 'system' ], [ /памят/i, 'mem' ], [ /температур/i, 'temp' ], [ /хранилищ|флеш|flash/i, 'disk' ],
	[ /wi-?fi/i, 'wifi' ], [ /устройств|клиент|кто держит/i, 'top' ], [ /интерфейс|скорост|трафик|интернет|сеть|связ/i, 'net' ],
	[ /событ|предупрежд|истори/i, 'events' ], [ /настройк/i, 'quick' ]
];

const HEAT = {
	cpu: [ 'Процессор', r => r[1], v => Math.round(v) + '%' ],
	mem: [ 'Память', r => r[2], v => Math.round(v) + '%' ],
	ping: [ 'Пинг', r => r[7], v => Math.round(v) + ' мс' ],
	net: [ 'Трафик', r => (r[4] >= 0 && r[5] >= 0) ? r[4] + r[5] : null, v => (v * 8 / 1e6).toFixed(1) + ' Мбит/с' ]
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

const CSS = `
.nfm { --nfm-card: var(--nf-card, var(--background-color-medium, #fff)); --nfm-card2: var(--nf-card-alt, var(--background-color-low, #f4f4f4));
  --nfm-border: var(--nf-stroke, rgba(128,128,128,.22)); --nfm-text: var(--text-color-highest, inherit); --nfm-dim: var(--text-color-medium, #666);
  --nfm-accent: var(--nf-accent, var(--primary-color-high, #0067c0)); --nfm-r: var(--nf-radius, 8px);
  --c-cpu: var(--nf-accent, #0078d4); --c-mem: #7a5cc7; --c-temp: #e8710a; --c-flash: #00a0b0; --c-down: var(--nf-accent, #0078d4); --c-up: #13a10e;
  --g1:#00a3b5; --g2:#7a5cc7; --g3:#d6479b; --g4:#e8a30a; --g5:#0f8ee9; --g6:#2fa64a; --g7:#7d8aa0; --gx:#9aa5b4;
  color: var(--nfm-text); }
:root[data-darkmode="true"] .nfm { --c-cpu:var(--nf-accent, #4cc2ff); --c-mem:#b39bff; --c-temp:#ffa94d; --c-flash:#4fd8e6; --c-down:var(--nf-accent, #4cc2ff); --c-up:#6ccb5f;
  --g1:#3dd0e0; --g2:#b39bff; --g3:#ff7fbf; --g4:#ffc552; --g5:#5cb7ff; --g6:#6ccb5f; --g7:#9aa7bf; --gx:#7d8798; }
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
.nfm-cfg-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.nfm-cfg-g { border: 1px solid var(--nfm-border); border-radius: var(--nfm-r); background: var(--nfm-card2); padding: 12px 14px 14px; min-width: 0; }
.nfm-cfg-g h4 { margin: 0 0 10px; padding: 0; border: 0; font-size: 13px; font-weight: 600; color: var(--nfm-text); }
.nfm-cfg-g .nfm-cfg { grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); }
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
.nfm-ev-i:last-child { border-bottom: 0; }
.nfm-ev-i i { width: 8px; height: 8px; border-radius: 50%; background: var(--nfm-dim); }
.nfm-ev-i.warn i { background: #f7a21b; } .nfm-ev-i.crit i { background: #e5484d; } .nfm-ev-i.ok i { background: #13a10e; }
.nfm-ev-i time { color: var(--nfm-dim); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nfm-tiles.t4 { grid-template-columns: 1fr 1fr; }
.nfm-cfg { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px 18px; }
.nfm-cfg-i { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--nfm-dim); }
.nfm-cfg-f { display: flex; align-items: center; gap: 8px; }
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

		/* ip -> host name */
		const names = {};
		for (const mac in hints)
			for (const ip of (hints[mac].ipaddrs || []))
				names[ip] = hints[mac].name || ip;
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
		for (const i of ifdump) for (const a of (i['ipv4-address'] || [])) if (a.address) { routerIps.add(a.address); if (!names[a.address] || names[a.address] === a.address) names[a.address] = 'Роутер'; }

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
			paused: false, tick: 0, iface: null, tab: 'overview', sort: 'mem', filter: '',
				at: {}, alerts: undefined, devs: undefined, devDay: 'day', hist: undefined, range: 'h'
		};

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
		const rCpu = ring('c-cpu'), rTemp = ring('c-temp'), rMem = ring('c-mem'), rFlash = ring('c-flash');
		const T = {};  /* text refs */
		const t = (key, cls) => (T[key] = E('span', { class: cls || '' }, '–'));

		const metric = (r, k, ...lines) => E('section', { class: 'nfm-card nfm-metric' }, [
			r.el, E('div', { class: 'nfm-metric-info' }, [ E('div', { class: 'nfm-k' }, k) ].concat(lines)) ]);

		const hotBox = E('div', { class: 'alert-message warning', hidden: '', style: 'margin-bottom:12px' }, [ E('h4', {}, 'Процессор перегрет'), E('p') ]);
		const alertsBox = E('div', { class: 'nfm-alerts', hidden: '' });

		const act = (cls, path, label, fn) => {
			const icon = SVG('svg', { viewBox: '0 0 24 24' });
			icon.innerHTML = path;
			return E('button', { class: 'nfm-act ' + cls, click: fn }, [ icon, label ]);
		};

		const actions = E('div', { class: 'nfm-actions' }, [
			act('', '<path d="M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0"/><circle cx="12" cy="20" r=".8"/>', 'Перезапустить Wi-Fi', () => confirmRun(
				'Перезапустить Wi-Fi?', 'Беспроводные клиенты ненадолго отключатся.', () => fs.exec('/sbin/wifi', [ 'reload' ]), 'Wi-Fi перезапускается…')),
			act('', '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>', 'Перезапустить сеть', () => confirmRun(
				'Перезапустить сеть?', 'Все соединения, включая эту страницу, на время прервутся.', () => fs.exec('/etc/init.d/network', [ 'restart' ]), 'Сеть перезапускается…')),
			act('', '<path d="M12 3v8"/><path d="M6.5 6.5a8 8 0 1 0 11 0"/>', 'Разбудить устройство', () => wakeDialog()),
			act('', '<path d="M9 4h6v3H9z"/><path d="M7 5.5H5.5v14h13v-14H17"/><path d="M9 12h6M9 15.5h4"/>', 'Скопировать диагностику', () => copyDiag()),
			act('danger', '<path d="M12 3v9"/><path d="M7 7a7.5 7.5 0 1 0 10 0"/>', 'Перезагрузить роутер', () => confirmRun(
				'Перезагрузить роутер?', 'Роутер будет недоступен около минуты.', () => callReboot(), 'Роутер перезагружается… страница обновится сама.', true))
		]);

		const cardsRow = E('div', { class: 'nfm-grid nfm-g4' }, [
			metric(rCpu, 'Процессор', E('div', { class: 'nfm-v' }, [ t('cpuCores') ]), E('div', { class: 'nfm-s' }, [ t('cpuLoad') ])),
			metric(rTemp, 'Температура', E('div', { class: 'nfm-v' }, [ t('tempMain') ]), E('div', { class: 'nfm-s' }, [ t('tempSub') ])),
			metric(rMem, 'Память', E('div', { class: 'nfm-v' }, [ t('memMain') ]), E('div', { class: 'nfm-s' }, [ t('memSub') ])),
			metric(rFlash, 'Флеш', E('div', { class: 'nfm-v' }, [ t('flashMain') ]), E('div', { class: 'nfm-s' }, [ t('flashSub') ]))
		]);

		const mainChart = chart({
			right: true,
			series: [ { key: 'cpu', cls: 'c-cpu', label: 'Процессор', fmt: v => nf0.format(v) + '%' }, { key: 'mem', cls: 'c-mem', label: 'Память', fmt: v => nf0.format(v) + '%' },
				{ key: 'temp', cls: 'c-temp', axis: 'right', fill: .12, label: 'Температура', fmt: v => nf1.format(v) + ' °C' } ],
			fmtLeft: v => nf0.format(v) + '%', fmtRight: v => nf0.format(v) + '°'
		});

		const coresBox = E('div');
		const coreRefs = [];
		const tileRefs = {};
		const tiles = E('div', { class: 'nfm-tiles' }, [ [ 'apps', 'программы' ], [ 'sys', 'система' ], [ 'irq', 'прерывания' ], [ 'io', 'ожидание диска' ] ]
			.map(([ k, l ]) => E('div', { class: 'nfm-tile' }, [ l, tileRefs[k] = E('b', {}, '–') ])));

		const sparkDown = sparkline('c-down'), sparkUp = sparkline('c-up');
		const netMini = chart({
			height: 196,
			series: [ { key: 'rx', cls: 'c-down', label: 'Загрузка', fmt: rateText }, { key: 'tx', cls: 'c-up', fill: .18, label: 'Отдача', fmt: rateText } ],
			fmtLeft: v => rateText(v), fmtRight: () => ''
		});

		const memStack = E('div', { class: 'nfm-stack' });
		const memLegend = E('div', { class: 'nfm-legend nfm-legend-lg' });

		const overview = E('div', {}, [
			alertsBox, hotBox, cardsRow, actions,
			E('div', { class: 'nfm-grid nfm-g21' }, [
				card([ 'Последние 5 минут', E('span', { class: 'nfm-spacer' }),
					E('span', { class: 'nfm-legend' }, [ legendDot('c-cpu', 'Процессор'), legendDot('c-mem', 'Память'), legendDot('c-temp', 'Температура, °C') ]) ], mainChart.el),
				card('Ядра процессора', E('div', {}, [ coresBox, tiles ]))
			]),
			E('div', { class: 'nfm-grid nfm-g21' }, [
				card([ 'Сеть', E('span', { class: 'nfm-spacer' }), T.netIface = E('span', { class: 'nfm-chip' }, '–'),
					E('span', { class: 'nfm-legend' }, [ legendDot('c-down', 'Загрузка'), legendDot('c-up', 'Отдача') ]) ], netMini.el),
				card('Сейчас', E('div', {}, [
					E('div', { class: 'nfm-k' }, 'Загрузка'),
					E('div', { class: 'nfm-rate' }, [ T.dlN = E('b', {}, '–'), T.dlU = E('span', {}, '') ]), sparkDown.el,
					E('div', { class: 'nfm-k', style: 'margin-top:12px' }, 'Отдача'),
					E('div', { class: 'nfm-rate' }, [ T.ulN = E('b', {}, '–'), T.ulU = E('span', {}, '') ]), sparkUp.el,
					E('div', { class: 'nfm-s', style: 'margin-top:12px' }, [ 'Соединений: ', t('ctMini') ]),
					E('div', { class: 'nfm-s' }, [ 'Wi-Fi клиентов: ', t('wifiMini') ]),
					E('div', { class: 'nfm-s' }, [ 'Интернет: ', t('wanMini') ])
				]))
			]),
			card([ 'Кто сколько занимает', E('span', { class: 'nfm-note' }, 'память программ — примерно: общие библиотеки входят в каждую') ],
				E('div', {}, [ memStack, memLegend ]))
		]);

		/* network tab */
		const netSel = E('select', { class: 'nfm-sel', change: ev => { S.iface = ev.target.value; refresh(); } });
		const netBig = chart({ height: 260, series: [ { key: 'rx', cls: 'c-down', label: 'Загрузка', fmt: rateText }, { key: 'tx', cls: 'c-up', fill: .18, label: 'Отдача', fmt: rateText } ],
			fmtLeft: v => rateText(v), fmtRight: () => '' });
		const ifBody = E('tbody');
		const wifiBody = E('tbody');
		const hostsBox = E('div');
		const devBody = E('tbody');
		const devNote = E('div', { class: 'nfm-hint', hidden: '' });
		const devSel = E('select', { class: 'nfm-sel', change: ev => { S.devDay = ev.target.value; refresh(); } },
			[ E('option', { value: 'day' }, 'Сегодня'), E('option', { value: 'yday' }, 'Вчера') ]);
		const chanSel = E('select', { class: 'nfm-sel', change: ev => { S.chanDev = ev.target.value; renderChannel(); } });
		const chanBox = E('div', { class: 'nfm-two' });
		const chanNote = E('div', { class: 'nfm-note-s', style: 'margin:-4px 0 10px' }, 'Скорость за последние секунды по данным conntrack: по службам (портам) и по адресам в интернете.');
		/* ---- диагностика: ping / маршрут / DNS прямо из браузера ---- */
		const DIAG = '/usr/libexec/nightfall-diag';
		const diagOut = E('pre', { class: 'nfm-diag-out' }, 'Выберите узел и нажмите кнопку.');
		const diagHost = E('input', { type: 'text', class: 'nfm-diag-in', value: '1.1.1.1', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': 'Адрес узла' });
		let diagBusy = false;
		function runDiag(cmd) {
			const h = diagHost.value.trim();
			if (!/^[A-Za-z0-9._:-]{1,253}$/.test(h) || h[0] === '-') { diagOut.textContent = 'Введите адрес или имя узла: буквы, цифры, точка, дефис.'; return; }
			if (diagBusy) return;
			diagBusy = true; diagBox.classList.add('busy');
			diagOut.textContent = ({ ping: 'Пинг ' + h + '…', trace: 'Маршрут до ' + h + ' (до 30 секунд)…', dns: 'Запрос DNS ' + h + '…' })[cmd];
			fs.exec(DIAG, [ cmd, h ]).then(r => { diagOut.textContent = ((r.stdout || '') + (r.stderr || '')).trim() || 'Нет ответа.'; })
				.catch(() => { diagOut.textContent = 'Не удалось выполнить. Выйдите из LuCI и войдите снова после обновления (нужны новые права).'; })
				.then(() => { diagBusy = false; diagBox.classList.remove('busy'); });
		}
		const diagBox = E('div', { class: 'nfm-diag' }, [
			E('div', { class: 'nfm-diag-row' }, [ diagHost,
				E('button', { type: 'button', class: 'nfm-tab on', click: () => runDiag('ping') }, 'Пинг'),
				E('button', { type: 'button', class: 'nfm-tab', click: () => runDiag('trace') }, 'Маршрут'),
				E('button', { type: 'button', class: 'nfm-tab', click: () => runDiag('dns') }, 'DNS') ]),
			E('div', { class: 'nfm-diag-chips' }, [ '1.1.1.1', '8.8.8.8', '77.88.8.8', 'ya.ru', 'google.com' ].map(h =>
				E('button', { type: 'button', class: 'nfm-tab', click: () => { diagHost.value = h; } }, h))),
			diagOut ]);
		const diagBody = diagBox;
		diagHost.addEventListener('keydown', ev => { if (ev.key === 'Enter') runDiag('ping'); });

		const net = E('div', { hidden: true }, [
			E('div', { class: 'nfm-grid nfm-g3' }, [
				card('Загрузка', E('div', {}, [ E('div', { class: 'nfm-rate' }, [ T.nDlN = E('b', {}, '–'), T.nDlU = E('span') ]),
					E('div', { class: 'nfm-s' }, [ 'всего принято ', t('nDlTot') ]) ])),
				card('Отдача', E('div', {}, [ E('div', { class: 'nfm-rate' }, [ T.nUlN = E('b', {}, '–'), T.nUlU = E('span') ]),
					E('div', { class: 'nfm-s' }, [ 'всего отправлено ', t('nUlTot') ]) ])),
				card('Соединения', E('div', {}, [ E('div', { class: 'nfm-rate' }, [ T.ctN = E('b', {}, '–'), T.ctMax = E('span') ]),
					E('div', { class: 'nfm-bar', style: 'margin:8px 0 6px' }, [ T.ctBar = E('div', { class: 'nfm-bar-fill c-cpu' }) ]),
					E('div', { class: 'nfm-s' }, [ t('ctProto') ]) ]))
			]),
			E('div', { class: 'nfm-grid' }, [
				card([ 'Трафик по устройствам', E('span', { class: 'nfm-spacer' }), T.devTotal = E('span', { class: 'nfm-note-s' }), devSel ], E('div', {}, [
					devNote,
					E('table', { class: 'nfm-table' }, [
						E('thead', {}, E('tr', {}, [ E('th', {}, 'Устройство'), E('th', { class: 'r' }, '↓ сейчас'), E('th', { class: 'r' }, '↑ сейчас'),
							E('th', { class: 'r' }, '↓ за день'), E('th', { class: 'r' }, '↑ за день') ])), devBody ]) ]))
			]),
			E('div', { class: 'nfm-grid' }, [
				card([ 'Что грузит канал сейчас', E('span', { class: 'nfm-spacer' }), chanSel ], E('div', {}, [ chanNote, chanBox ]))
			]),
			E('div', { class: 'nfm-grid' }, [
				card([ 'Скорость по интерфейсу', E('span', { class: 'nfm-spacer' }), netSel,
					E('span', { class: 'nfm-legend' }, [ legendDot('c-down', 'Загрузка'), legendDot('c-up', 'Отдача') ]) ], netBig.el)
			]),
			E('div', { class: 'nfm-grid' }, [
				card([ 'Wi-Fi клиенты', E('span', { class: 'nfm-spacer' }), E('span', { class: 'nfm-note-s' }, 'нажмите на строку — график сигнала · скорость — согласованная, не текущий трафик') ],
					E('table', { class: 'nfm-table' }, [
						E('thead', {}, E('tr', {}, [ E('th', {}, 'Устройство'), E('th', {}, 'Сеть'), E('th', {}, 'Сигнал'),
							E('th', { class: 'r' }, '↓ линк'), E('th', { class: 'r' }, '↑ линк'), E('th', { class: 'r' }, 'В сети') ])), wifiBody ]))
			]),
			E('div', { class: 'nfm-grid nfm-g21' }, [
				card('Интерфейсы', E('table', { class: 'nfm-table' }, [
					E('thead', {}, E('tr', {}, [ E('th', {}, 'Интерфейс'), E('th', { class: 'r' }, '↓ сейчас'), E('th', { class: 'r' }, '↑ сейчас'),
						E('th', { class: 'r' }, '↓ всего'), E('th', { class: 'r' }, '↑ всего'), E('th', { class: 'r' }, 'Ошибки') ])), ifBody ])),
				card('Кто держит соединения', hostsBox)
			]),
			E('div', { class: 'nfm-grid' }, [ card('Диагностика сети', diagBody) ])
		]);

		/* processes tab */
		const procBody = E('tbody');
		const sortTh = (key, label, cls) => E('th', { class: 'sort ' + (cls || ''), click: () => { S.sort = key; refresh(); } }, label);
		const procs = E('div', { hidden: true }, [
			card([ 'Программы', E('span', { class: 'nfm-spacer' }),
				E('input', { class: 'nfm-search', type: 'search', placeholder: 'Поиск…', input: ev => { S.filter = ev.target.value.toLowerCase(); refresh(); } }) ],
				E('table', { class: 'nfm-table' }, [
					E('thead', {}, E('tr', {}, [ E('th', {}, 'Имя'), E('th', { class: 'r' }, 'Процессов'),
						sortTh('cpu', 'Процессор ↓', 'r'), sortTh('mem', 'Память ↓', 'r') ])), procBody ]))
		]);

		/* history tab */
		const rangeBtns = {};
		const rangeTabs = E('div', { class: 'nfm-tabs' }, Object.keys(RANGES).map(k =>
			rangeBtns[k] = E('button', { class: 'nfm-tab', click: () => { S.range = k; S.hist = undefined; S.at.hist = 0; refresh(); tick(); } }, RANGES[k][2])));
		const histNote = E('div', { class: 'nfm-hint', hidden: '' });
		const histMain = chart({ right: true, height: 240,
			series: [ { key: 'cpuB', cls: 'c-base', fill: 0, label: 'Процессор обычно', fmt: v => nf0.format(v) + '%' }, { key: 'cpu', cls: 'c-cpu', label: 'Процессор', fmt: v => nf0.format(v) + '%' }, { key: 'mem', cls: 'c-mem', label: 'Память', fmt: v => nf0.format(v) + '%' },
				{ key: 'temp', cls: 'c-temp', axis: 'right', fill: .12, label: 'Температура', fmt: v => nf1.format(v) + ' °C' } ],
			fmtLeft: v => nf0.format(v) + '%', fmtRight: v => nf0.format(v) + '°' });
		const histPing = chart({ height: 200,
			series: [ { key: 'netB', cls: 'c-base', fill: 0, label: 'Интернет обычно', fmt: v => nf1.format(v) + ' мс' }, { key: 'gw', cls: 'c-up', fill: 0, gaps: true, label: 'Шлюз', fmt: v => nf1.format(v) + ' мс' }, { key: 'net', cls: 'c-down', fill: 0, gaps: true, label: 'Интернет', fmt: v => nf1.format(v) + ' мс' } ],
			fmtLeft: v => nf0.format(v) + ' мс', fmtRight: () => '' });
		const histNet = chart({ height: 200, series: [ { key: 'rxB', cls: 'c-base', fill: 0, label: 'Загрузка обычно', fmt: rateText }, { key: 'rx', cls: 'c-down', label: 'Загрузка', fmt: rateText }, { key: 'tx', cls: 'c-up', fill: .18, label: 'Отдача', fmt: rateText } ],
			fmtLeft: v => rateText(v), fmtRight: () => '' });
		const evBox = E('div', { class: 'nfm-evlist' });
		const histInfo = E('div', { class: 'nfm-s', style: 'margin-top:10px' });
		const pingTiles = E('div', { class: 'nfm-tiles t4' }, [ [ 'pAvg', 'средняя задержка' ], [ 'pMax', 'максимум' ], [ 'pLoss', 'потери ответов' ], [ 'pCut', 'обрывов связи' ] ]
			.map(([ k, l ]) => E('div', { class: 'nfm-tile' }, [ l, T[k] = E('b', {}, '–') ])));
		const CFG_FIELDS = [
			[ 'TEMP_WARN', 'Предупреждение о перегреве', '°C' ], [ 'TEMP_CRIT', 'Критический перегрев', '°C' ],
			[ 'MEM_MIN_PCT', 'Свободной памяти меньше', '%' ], [ 'FLASH_MAX_PCT', 'Флеш занят больше', '%' ],
			[ 'CT_MAX_PCT', 'Таблица соединений заполнена', '%' ], [ 'CPU_MAX_PCT', 'Загрузка процессора', '%' ],
			[ 'CPU_MINUTES', '…и держится дольше', 'мин' ],
			[ 'PING_TARGET', 'Проверка интернета: адрес 1', '', 'text' ], [ 'PING_TARGET2', 'Проверка интернета: адрес 2', '', 'text' ],
			[ 'PERSIST_DIR', 'Папка для сохранения истории', '', 'text', '— только в памяти —' ],
			[ 'PERSIST_HOURS', 'Сохранять историю на накопитель', 'ч' ], [ 'HIST_DAYS', 'Длинная история (шаг 30 мин), суток 7–90', 'сут' ], [ 'PERSIST_ANY', 'Разрешить сохранение на встроенный накопитель (0/1)', '' ], [ 'JOURNAL', 'Журнал обрывов и перезагрузок (0/1)', '' ], [ 'WIFI_HIST', 'История сигнала Wi-Fi (0/1)', '' ],
			[ 'SPEED_URL', 'Файл для замера скорости', '', 'text' ], [ 'SPEED_STREAMS', 'Потоков при замере скорости (1–8)', '' ],
			[ 'NEWDEV', 'Сообщать о новых устройствах (0/1)', '' ],
			[ 'TG', 'Отправлять уведомления в Telegram (0/1)', '' ], [ 'TG_ALERTS', 'Слать предупреждения и перезагрузки (0/1)', '' ], [ 'TG_BOT', 'Бот с кнопками: меню, блокировка, перезагрузка (0/1)', '' ], [ 'TG_REPORT', 'Ежедневный отчёт в Telegram, время', '', 'text', 'например 21:00, пусто = выкл' ],
			[ 'TG_TOKEN', 'Токен бота (от @BotFather)', '', 'password', 'не задан' ], [ 'TG_CHAT', 'Chat id', '', 'text', 'число, определяется кнопкой' ],
			[ 'TG_PROXY', 'Прокси для Telegram (если он закрыт)', '', 'text', 'например socks5h://127.0.0.1:1080' ],
			[ 'TG_IFACE', 'Или интерфейс VPN для Telegram', '', 'text', 'например wg0' ]
		];
		const cfgInputs = {};
		const cfgMsg = E('span', { class: 'nfm-note-s' });
		/* Telegram: сначала сохраняем введённое, потом просим роутер определить chat id или отправить проверочное сообщение */
		const tgMsg = E('div', { class: 'nfm-note-s', style: 'margin-top:6px' });
		const tgRun = cmd => {
			tgMsg.textContent = 'Выполняю…';
			const save = [ 'set' ].concat([ 'TG_TOKEN', 'TG_CHAT', 'TG_PROXY', 'TG_IFACE' ].map(k => k + '=' + cfgInputs[k].value.trim()));
			return callCfg(save).then(r => {
				if (!(r && r.ok)) { tgMsg.textContent = 'Не сохранено: ' + ((r && r.error) || 'нет ответа'); return null; }
				return fs.exec(NOTIFYBIN, [ cmd ]).then(res => { try { return JSON.parse(res.stdout); } catch (e) { return { ok: false, error: 'нет ответа от роутера' }; } }).catch(() => ({ ok: false, error: 'нет прав на запуск (выйдите из LuCI и войдите снова; права обновляются при входе) или не найден /usr/libexec/nightfall-notify' }));
			});
		};
		const tgTools = E('div', { style: 'margin-top:10px' }, [
			E('div', { class: 'nfm-note-s' }, 'Как настроить: 1) в Telegram найдите @BotFather, создайте бота командой /newbot и вставьте токен выше; 2) откройте своего бота и нажмите Start; 3) нажмите «Определить chat id», затем «Отправить проверку»; 4) включите «Отправлять уведомления» (1) и сохраните. После этого боту можно писать команды: /status, /clients, /traffic, /apps, /speed, /help (отвечает только вам).'),
			E('div', { class: 'nfm-actions', style: 'margin:8px 0 0' }, [
				E('button', { class: 'nfm-act', click: () => tgRun('chatid').then(r => { if (!r) return; if (r.ok) { cfgInputs.TG_CHAT.value = r.chat; callCfg([ 'set', 'TG_CHAT=' + r.chat ]); tgMsg.textContent = 'Chat id найден: ' + r.chat; } else tgMsg.textContent = r.error; }) }, 'Определить chat id'),
				E('button', { class: 'nfm-act', click: () => tgRun('test').then(r => { if (r) tgMsg.textContent = r.ok ? 'Сообщение отправлено, проверьте Telegram.' : 'Не отправлено: ' + r.error; }) }, 'Отправить проверку'),
				E('button', { class: 'nfm-act', click: () => tgRun('backup').then(r => { if (r) tgMsg.textContent = r.ok ? 'Резервная копия отправлена в Telegram файлом (без токена бота).' : 'Не отправлено: ' + r.error; }) }, 'Резервная копия в Telegram') ]),
			tgMsg ]);
		/* ---- Накопители: найти флешку / SD-карту и одним нажатием хранить на ней историю ---- */
		const dskBody = E('div', {}, E('div', { class: 'nfm-empty' }, 'Ищу накопители…'));
		const dskMsg = E('div', { class: 'nfm-note-s', style: 'margin-top:8px' });
		function loadDisks() { return callCfg([ 'disks' ]).then(r => { S.dsk = r || null; renderDisks(); }).catch(() => { S.dsk = null; renderDisks(); }); }
		function setPersist(dir, hours, msg) {
			dskMsg.textContent = 'Применяю…';
			callCfg(dir ? [ 'set', 'PERSIST_DIR=' + dir, 'PERSIST_HOURS=' + hours ] : [ 'set', 'PERSIST_DIR=' ]).then(r => {
				if (!(r && r.ok)) { dskMsg.textContent = 'Не сохранено: ' + ((r && r.error) || 'нет ответа'); return; }
				dskMsg.textContent = msg; S.at.alerts = 0; S.at.hist = 0;
				callCfg([ 'get' ]).then(c => { S.cfg = c; if (c) fillCfg(c.values); renderDisks(); });
			});
		}
		function renderDisks() {
			const d = S.dsk, cur = ((S.cfg && S.cfg.values) || {}).PERSIST_DIR || '';
			if (d === undefined) return;
			if (!d || !Array.isArray(d.disks)) { dskBody.replaceChildren(E('div', { class: 'nfm-hint' }, 'Не удалось получить список накопителей: обновите тему на роутере до последней версии.')); return; }
			if (!d.disks.length) {
				const parts = (d.parts || []).filter(x => /^\/dev\/(sd|nvme|vd|mmcblk)/.test(x.dev)), fsl = d.fs || [], msg = [];
				const need = { vfat: 'kmod-fs-vfat', exfat: 'kmod-fs-exfat', ntfs: 'kmod-fs-ntfs3', ext4: 'kmod-fs-ext4', f2fs: 'kmod-fs-f2fs', btrfs: 'kmod-fs-btrfs' };
				if (parts.length) {
					msg.push('Роутер видит раздел: ' + parts.map(x => x.dev + ' (' + fmtBytes(x.size_kb * 1024) + (x.type ? ', ' + x.type : '') + ')').join(', ') + ', но он не смонтирован.');
					const bad = parts.filter(x => x.type && need[x.type] && !fsl.includes(x.type) && !(x.type === 'ntfs' && fsl.includes('ntfs3')));
					if (bad.length) msg.push('Не хватает драйвера файловой системы: установите ' + [ ...new Set(bad.map(x => need[x.type])) ].join(', ') + ' и перезагрузите роутер.');
					msg.push('Затем откройте «Система → Точки монтирования», нажмите «Добавить», выберите этот раздел, точка монтирования /mnt/sda1, включите и нажмите «Сохранить и применить». Если там уже есть запись с пометкой «не существует», удалите её и добавьте заново.');
				} else if (d.usb_storage === 0) {
					msg.push('Драйвер USB-накопителей не загружен. Установите kmod-usb-storage (для USB 3.0 ещё kmod-usb-storage-uas) и перезагрузите роутер.');
				} else {
					msg.push('Роутер не видит флешку как диск. Проверьте, что она вставлена до конца, попробуйте другой порт или другую флешку (некоторым не хватает питания). Запись в «Точках монтирования» с пометкой «не существует» значит то же самое: раздел с таким UUID сейчас не найден. Подробности на роутере: dmesg | grep -i usb.');
				}
				msg.push('Когда накопитель смонтируется, нажмите «Обновить»: он появится здесь.');
				dskBody.replaceChildren(...msg.map(t => E('div', { class: 'nfm-hint', style: 'margin-bottom:6px' }, t)));
				return;
			}
			dskBody.replaceChildren(...d.disks.map(k => {
				const dir = k.mount.replace(/\/$/, '') + '/nightfall', used = cur === dir || cur.indexOf(k.mount.replace(/\/$/, '') + '/') === 0;
				return E('div', { class: 'nfm-dsk' }, [
					E('div', { class: 'nfm-dsk-i' }, [ E('b', {}, k.mount), E('span', { class: 'nfm-note-s' }, k.dev + ' · ' + k.fs + ' · ' + fmtBytes(k.size_kb * 1024) + ', свободно ' + fmtBytes(k.free_kb * 1024)) ]),
					used ? E('button', { type: 'button', class: 'nfm-btn', click: () => setPersist('', 0, 'Сохранение истории на накопитель выключено, история снова только в памяти.') }, '✓ История здесь · отключить')
						: E('button', { type: 'button', class: 'nfm-btn', click: () => setPersist(dir, 1, 'Готово: история сохраняется в ' + dir + ' раз в час и переживёт перезагрузку роутера.') }, 'Хранить историю здесь') ]);
			}));
		}

		const cfgCard = card('Настройки предупреждений', E('div', {}, [
			E('div', { class: 'nfm-cfg-groups' }, [
				[ 'Температура и память', [ 'TEMP_WARN', 'TEMP_CRIT', 'MEM_MIN_PCT', 'FLASH_MAX_PCT' ] ],
				[ 'Процессор и соединения', [ 'CPU_MAX_PCT', 'CPU_MINUTES', 'CT_MAX_PCT' ] ],
				[ 'Проверка интернета', [ 'PING_TARGET', 'PING_TARGET2' ] ],
				[ 'Хранение истории', [ 'PERSIST_DIR', 'PERSIST_HOURS', 'HIST_DAYS', 'PERSIST_ANY', 'JOURNAL', 'WIFI_HIST' ] ],
				[ 'Замер скорости', [ 'SPEED_URL', 'SPEED_STREAMS' ] ],
				[ 'Новые устройства', [ 'NEWDEV' ] ],
				[ 'Уведомления в Telegram', [ 'TG', 'TG_ALERTS', 'TG_BOT', 'TG_REPORT', 'TG_TOKEN', 'TG_CHAT', 'TG_PROXY', 'TG_IFACE' ], tgTools ]
			].map(([ title, keys, extra ]) => E('section', { class: 'nfm-cfg-g' }, [ E('h4', {}, title),
				E('div', { class: 'nfm-cfg' }, keys.map(k => CFG_FIELDS.find(f => f[0] === k)).filter(Boolean).map(([ k, l, u, type, ph ]) => E('label', { class: 'nfm-cfg-i' }, [ l,
					E('span', { class: 'nfm-cfg-f' }, [ cfgInputs[k] = E('input', { class: 'nfm-in', type: type || 'number', placeholder: ph || '' }), u ? E('em', {}, u) : '' ]) ]))),
				extra || '' ]))),
			E('div', { class: 'nfm-actions', style: 'margin:14px 0 0;align-items:center' }, [
				E('button', { class: 'nfm-act', click: () => saveCfg() }, 'Сохранить и применить'),
				E('button', { class: 'nfm-act', click: () => (S.cfg ? Promise.resolve(S.cfg) : callCfg([ 'get' ]).then(c => (S.cfg = c))).then(c => fillCfg(c && c.defaults)) }, 'Значения по умолчанию'),
				E('button', { class: 'nfm-act', click: () => copyDiag() }, 'Скопировать диагностику'), cfgMsg ]),
			E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, 'Пустой адрес 1 отключает проверку интернета. Папка для истории — на USB/SD (не во внутренней флеш-памяти). После сохранения сборщик перезапускается, накопленная история не теряется.')
		]));
		const jrnTiles = E('div', { class: 'nfm-tiles t4', style: 'margin-bottom:10px' }, [ [ 'jCnt', 'обрывов за 7 дней' ], [ 'jSum', 'без связи суммарно' ], [ 'jAv', 'доступность' ], [ 'jBoot', 'последняя загрузка' ] ]
			.map(([ k, l ]) => E('div', { class: 'nfm-tile' }, [ l, T[k] = E('b', {}, '–') ])));
		const jrnBox = E('div');
		const spdTiles = E('div', { class: 'nfm-tiles t4', style: 'margin-bottom:10px' }, [ [ 'sLast', 'последний замер' ], [ 'sAvg', 'среднее за 7 дней' ], [ 'sMax', 'максимум' ], [ 'sMin', 'минимум' ] ]
			.map(([ k, l ]) => E('div', { class: 'nfm-tile' }, [ l, T[k] = E('b', {}, '–') ])));
		const spdChart = chart({ height: 180, series: [ { key: 'mbps', cls: 'c-down', fill: .16, label: 'Скорость', fmt: v => nf1.format(v) + ' Мбит/с' } ],
			fmtLeft: v => nf0.format(v) + ' Мбит/с', fmtRight: () => '' });
		const spdList = E('div', { class: 'nfm-lst', style: 'margin-top:12px' });
		const spdNote = E('div', { class: 'nfm-note-s', style: 'margin-top:8px' });
		const spdSel = E('select', { class: 'nfm-sel', title: 'Автоматический замер', change: ev => {
			callCfg([ 'set', 'SPEED_HOURS=' + ev.target.value ]).then(r => { if (!(r && r.ok)) ui.addNotification(null, E('p', {}, 'Не сохранено: ' + ((r && r.error) || 'нет ответа')), 'danger'); S.at.spd = 0; }); } },
			[ [ '0', 'Автозамер выключен' ], [ '1', 'Каждый час' ], [ '3', 'Каждые 3 часа' ], [ '6', 'Каждые 6 часов' ], [ '12', 'Каждые 12 часов' ], [ '24', 'Раз в сутки' ] ].map(([ v, l ]) => E('option', { value: v }, l)));
		const SPEED_PRESETS = [
			[ 'https://speed.cloudflare.com/__down?bytes=25000000', 'Cloudflare (25 МБ на поток)' ],
			[ 'https://mirror.yandex.ru/ubuntu/ls-lR.gz', 'Яндекс.Зеркало (Россия)' ],
			[ 'https://speed.hetzner.de/100MB.bin', 'Hetzner (Германия, 100 МБ на поток)' ],
			[ 'https://proof.ovh.net/files/100Mb.dat', 'OVH (Франция, 100 МБ на поток)' ] ];
		const spdSrc = E('select', { class: 'nfm-sel', title: 'Откуда качать тестовый файл', change: ev => {
			if (!ev.target.value) { ui.addNotification(null, E('p', {}, 'Свой адрес впишите в поле «Файл для замера скорости» в настройках ниже.'), 'info'); return; }
			callCfg([ 'set', 'SPEED_URL=' + ev.target.value ]).then(r => {
				if (r && r.ok) { if (S.cfg && S.cfg.values) S.cfg.values.SPEED_URL = ev.target.value; if (cfgInputs.SPEED_URL) cfgInputs.SPEED_URL.value = ev.target.value; }
				else ui.addNotification(null, E('p', {}, 'Не сохранено: ' + ((r && r.error) || 'нет ответа')), 'danger'); }); } },
			SPEED_PRESETS.map(([ v, l ]) => E('option', { value: v }, l)).concat([ E('option', { value: '' }, 'Свой адрес (в настройках)') ]));
		const spdBtn = E('button', { class: 'nfm-btn', click: () => startSpeed() }, 'Измерить сейчас');
		const flashBox = E('div');
		const dayBody = E('div', { class: 'nfm-day' }, E('div', { class: 'nfm-empty' }, 'Загружаю…'));
		const wqBody = E('div', { class: 'nfm-wq' });
		function wqVerdict(c) {
			if (!c || typeof c !== 'object') return 'Нет ответа от роутера. Обновите тему на роутере до последней версии.';
			const devs = c.devs || [], n = devs.reduce((a, d) => a + (+d[1] || 0), 0), ok = devs.reduce((a, d) => a + (+d[2] || 0), 0);
			if (c.hist === '0') return 'Запись истории Wi-Fi выключена: поставьте WIFI_HIST=1 в настройках сборщика (вкладка «История», внизу) и сохраните.';
			if (!c.iwinfo) return 'Роутер не отдаёт данные радиомодулей (нет ubus iwinfo). Проверьте, что Wi-Fi включён, и установите пакет rpcd-mod-iwinfo.';
			if (!devs.length) return 'Радиомодули не найдены: ни один Wi-Fi интерфейс сейчас не включён. Включите Wi-Fi в «Сеть → Беспроводная сеть».';
			if (!n) return 'Wi-Fi работает (' + devs.map(d => d[0]).join(', ') + '), но сейчас к нему никто не подключён. Подключите телефон, первые точки появятся примерно через минуту. Проводные устройства здесь не учитываются.';
			if (!ok) return 'Клиентов Wi-Fi: ' + n + ', но уровень сигнала разобрать не удалось. Пришлите это сообщение разработчику: ' + (c.sample || 'пример недоступен');
			if (c.collector === 0 && (c.age < 0 || c.age > 180)) return 'Клиенты Wi-Fi есть (' + n + '), но сборщик не работает. Перезапустите его: /etc/init.d/nightfall-collector restart, либо перезагрузите роутер.';
			if (!c.lines) return 'Клиенты Wi-Fi есть (' + n + '), сигнал читается (' + ok + '), сборщик работает' + (c.collector ? '' : ' (данные свежие)') + ', но записей в истории нет. Подождите 1–2 минуты и обновите страницу. Если не помогло: /etc/init.d/nightfall-collector restart.';
			return 'Записей в истории: ' + c.lines + '. Обновите страницу.';
		}

		function renderWq() {
			const R = S.wq;
			if (R === undefined) { wqBody.replaceChildren(E('div', { class: 'nfm-empty' }, 'Загружаю…')); return; }
			const rows = R && R.rows || [];
			if (!rows.length) {
				const verdict = E('div', { class: 'nfm-note-s' });
				const btn = E('button', { type: 'button', class: 'nfm-btn', click: () => {
					btn.disabled = true; verdict.textContent = 'Проверяю…';
					callHistory([ 'wifi-check' ]).then(c => { btn.disabled = false; verdict.textContent = wqVerdict(c); }).catch(() => { btn.disabled = false; verdict.textContent = 'Не удалось выполнить проверку: обновите тему на роутере до последней версии.'; });
				} }, 'Почему пусто? Проверить');
				wqBody.replaceChildren(E('div', { class: 'nfm-hint' }, 'Данных пока нет: история сигнала копится раз в минуту с запуска сборщика, только для клиентов Wi-Fi.' + ((R && R.info && R.info.wifi_hist === '0') ? ' Запись истории Wi-Fi выключена в настройках (WIFI_HIST=0).' : '')),
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
			const QL = { ok: 'хорошо', mid: 'терпимо', bad: 'плохо' };
			const nm = m => devName(m);
			wqBody.replaceChildren(
				E('table', { class: 'nfm-table' }, [
					E('thead', {}, E('tr', {}, [ E('th', {}, 'Устройство'), E('th', { class: 'r' }, 'Сейчас'), E('th', { class: 'r' }, 'В среднем'), E('th', { class: 'r' }, 'Слабый'), E('th', { class: 'r' }, 'Отключений'), E('th', {}, 'Оценка') ])),
					E('tbody', {}, list.map(c => E('tr', { class: 'nfm-click', title: 'Показать сигнал в динамике', click: () => wifiDialog(c.m, nm(c.m), {}) }, [
						E('td', {}, [ nm(c.m), c.live ? '' : E('span', { class: 'nfm-chip' }, 'не в сети') ]),
						E('td', { class: 'r' }, c.live ? c.last + ' дБм' : '–'), E('td', { class: 'r' }, nf0.format(c.avg) + ' дБм'),
						E('td', { class: 'r' }, nf0.format(c.weak) + '%'), E('td', { class: 'r' }, String(c.lv)),
						E('td', {}, E('span', { class: 'nfm-wq-b ' + c.q }, QL[c.q])) ]))) ]),
				E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, 'Слабый — доля времени с сигналом −75 дБм и ниже. «Плохо»: средний сигнал слабый или частые отключения; обычно помогает поднести устройство ближе или сменить канал. Нажмите строку, чтобы увидеть график.'));
		}
		/* ---- устройство по MAC: имя из DHCP, иначе вид и производитель по MAC ---- */
		const devId = (mac, host) => { try { return mac ? DevId.identify(mac, host || '') : null; } catch (e) { return null; } };
		const devIcon = id => { const i = E('i', { class: 'nfm-dv-i' + (id && id.priv ? ' priv' : '') }); i.innerHTML = DevId.icon(id.kind); return i; };
		const devName = mac => {
			const m = String(mac).toUpperCase(), h = hints[m] || hints[String(mac).toLowerCase()] || {}, id = devId(m, h.name);
			return h.name || (id && id.known ? [ id.label || 'Устройство', id.vendor && id.vendor !== id.label ? id.vendor : '' ].filter(Boolean).join(' ') : '') || (h.ipaddrs || [])[0] || m;
		};

		/* ---- Сигнал Wi‑Fi по часам: тепловая карта по клиентам ---- */
		const whBody = E('div', { class: 'nfm-wh' });
		const whTabs = E('div', { class: 'nfm-tabs' }, [ [ 'd', '24 часа' ], [ 'w', '7 дней' ] ].map(([ k, t ]) =>
			E('button', { class: 'nfm-tab' + (k === 'd' ? ' on' : ''), type: 'button', click: ev => { S.whR = k; for (const b of whTabs.children) b.classList.toggle('on', b === ev.currentTarget); renderWHeat(); } }, t)));
		const WHQ = [ [ -60, 'q0', 'отличный (−60 и выше)' ], [ -67, 'q1', 'хороший (−60…−67)' ], [ -75, 'q2', 'слабоват (−67…−75)' ], [ -200, 'q3', 'плохой (ниже −75)' ] ];
		const whQ = v => WHQ.find(q => v >= q[0]) || WHQ[3];
		function renderWHeat() {
			const R = S.whr;
			if (R === undefined) { whBody.replaceChildren(E('div', { class: 'nfm-empty' }, 'Загружаю…')); return; }
			const rows = R && R.rows || [];
			if (!rows.length) { whBody.replaceChildren(E('div', { class: 'nfm-hint' }, 'Данных пока нет: сборщик записывает средний сигнал каждого клиента раз в час (первые точки появятся через час после запуска) и хранит их на накопителе, если он подключён.' + (R === null ? ' Обновите тему на роутере до последней версии.' : ''))); return; }
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
			if (!list.length) { whBody.replaceChildren(E('div', { class: 'nfm-hint' }, 'За этот период записей нет.')); return; }
			const g = E('div', { class: 'nfm-wh-g', style: '--n:' + n });
			g.appendChild(E('span'));
			for (let c = 0; c < n; c++) {
				const t0 = new Date((end - (n - c) * step) * 1000);
				g.appendChild(E('span', { class: 'nfm-wh-h' }, week ? (t0.getHours() < 6 ? t0.toLocaleDateString('ru-RU', { weekday: 'short' }) : '') : (t0.getHours() % 3 === 0 ? String(t0.getHours()) : '')));
			}
			for (const e of list) {
				const id = devId(e.m, (hints[e.m.toUpperCase()] || {}).name);
				g.appendChild(E('span', { class: 'nfm-wh-n', title: 'Показать сигнал в динамике · ' + e.m.toUpperCase() + (id && id.hint ? '\n' + id.hint : ''), click: () => wifiDialog(e.m, devName(e.m), {}) }, [ id ? devIcon(id) : '', devName(e.m) ]));
				for (let c = 0; c < n; c++) {
					const t0 = new Date((end - (n - c) * step) * 1000), when = t0.toLocaleString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) + (week ? '–' + new Date((end - (n - c - 1) * step) * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');
					if (!e.c[c]) { g.appendChild(E('span', { class: 'nfm-wh-c', title: when + ' — не было в сети' })); continue; }
					const v = e.s[c] / e.c[c], q = whQ(v);
					g.appendChild(E('span', { class: 'nfm-wh-c ' + q[1], title: devName(e.m) + ', ' + when + ' — ' + nf0.format(v) + ' дБм' }));
				}
			}
			whBody.replaceChildren(g,
				E('div', { class: 'nfm-wh-leg' }, WHQ.map(q => E('span', {}, [ E('i', { class: 'nfm-wh-c ' + q[1] }), q[2] ])).concat([ E('span', {}, [ E('i', { class: 'nfm-wh-c' }), 'нет в сети' ]) ])),
				E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, 'Строки — клиенты Wi‑Fi, сверху самые слабые. Столбец — ' + (week ? 'шесть часов' : 'час') + ', цвет — средний сигнал. Если устройство стабильно красное, поднесите его ближе или добавьте повторитель; красное только в определённые часы — помеха от соседей или бытовой техники. Нажмите имя, чтобы увидеть минутный график.'));
		}

		/* ---- Wi‑Fi: загруженность каналов ---- */
		const airBody = E('div', { class: 'nfm-air' });
		const airBtn = E('button', { type: 'button', class: 'nfm-btn', click: () => scanAir() }, 'Сканировать эфир');
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
			airBtn.textContent = S.airBusy ? 'Сканирую…' : S.air ? 'Сканировать заново' : 'Сканировать эфир';
			if (S.airBusy) { airBody.replaceChildren(E('div', { class: 'nfm-empty' }, 'Сканирую эфир… это занимает 5–15 секунд.')); return; }
			if (S.air === undefined) { airBody.replaceChildren(E('div', { class: 'nfm-hint' }, 'Покажет, какие соседние сети мешают вашему Wi‑Fi и какой канал свободнее. Сканирование на несколько секунд отвлекает радиомодуль, поэтому запускается только по кнопке: лучше не во время видеозвонка.'), E('div', { style: 'margin-top:8px' }, airBtn)); return; }
			const R = S.air;
			if (!R || !(R.radios || []).length) { airBody.replaceChildren(E('div', { class: 'nfm-hint' }, R === false ? 'Не удалось выполнить сканирование: обновите тему на роутере до последней версии.' : 'Радиомодули не найдены: включите Wi‑Fi в «Сеть → Беспроводная сеть».'), E('div', { style: 'margin-top:8px' }, airBtn)); return; }
			const secs = R.radios.map(rd => {
				const m = airModel(rd, R.aps || []);
				const mx = Math.max(3, ...m.col.map(x => x.load));
				const bars = E('div', { class: 'nfm-air-bars' }, m.col.map(x => E('div', { class: 'nfm-air-b l' + airLv(x.load) + (x.ch === m.own ? ' own' : ''), title: 'Канал ' + x.ch + ': сетей на нём ' + x.k + ', нагрузка ' + nf1.format(x.load) + (x.ch === m.own ? ' (ваш)' : '') }, E('i', { style: '--h:' + Math.max(3, Math.round(100 * Math.min(x.load, mx) / mx)) + '%' }))));
				const xs = E('div', { class: 'nfm-air-x' }, m.col.map(x => E('span', { class: (x.ch === m.own ? 'own' : '') + (m.best && x.ch === m.best.ch && x.ch !== m.own ? ' best' : '') }, String(x.ch))));
				let verdict;
				if (!m.own) verdict = 'Канал роутера определить не удалось.';
				else if (!m.best) verdict = 'Не хватило данных для рекомендации.';
				else if (m.best.ch === m.own || !m.cur || m.cur.load - m.best.load < 0.4) verdict = [ 'Ваш канал ', E('b', {}, String(m.own)), m.cur && m.cur.load < 0.5 ? ' свободен: менять ничего не нужно.' : ' занят не сильнее других: менять канал нет смысла.' ];
				else verdict = [ 'Канал ', E('b', {}, String(m.own)), ' загружен (сетей на нём: ' + m.cur.k + ', нагрузка ' + nf1.format(m.cur.load) + '). Свободнее канал ', E('b', {}, String(m.best.ch)), ' (нагрузка ' + nf1.format(m.best.load) + '). Сменить: «Сеть → Беспроводная сеть → Изменить → Канал».' + (m.auto ? ' Сейчас стоит «auto»: роутер выбирает сам, но не всегда удачно.' : '') ];
				const top = m.nets.slice().sort((a, b) => b.sig - a.sig).slice(0, 8);
				return E('div', { class: 'nfm-air-r' }, [
					E('h4', {}, [ BANDS[m.band] || m.band, E('small', {}, rd.dev + (rd.ssid ? ' · ' + rd.ssid : '') + (m.own ? ' · канал ' + m.own : '') + (m.ht ? ' · ' + m.ht : '')) ]),
					bars, xs, E('div', { class: 'nfm-air-v' }, verdict),
					top.length ? E('table', { class: 'nfm-table' }, [ E('thead', {}, E('tr', {}, [ E('th', {}, 'Соседняя сеть'), E('th', { class: 'r' }, 'Канал'), E('th', { class: 'r' }, 'Сигнал') ])),
						E('tbody', {}, top.map(x => E('tr', {}, [ E('td', {}, x.ssid || E('i', {}, 'скрытая сеть')), E('td', { class: 'r' }, String(x.ch)), E('td', { class: 'r' }, x.sig + ' дБм') ]))) ]) : E('div', { class: 'nfm-note-s' }, 'Соседних сетей не найдено.') ]);
			});
			airBody.replaceChildren(...secs, E('div', { class: 'nfm-note-s' }, 'Нагрузка считается по числу соседних сетей и их силе; на 2,4 ГГц учитывается наложение соседних каналов, поэтому советуются только 1, 6 и 11. На 5 ГГц советуются каналы без радиолокационного режима (DFS). Измерено ' + new Date(S.airT).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + '. ' + 'Каналы выше 6 ГГц и ширина канала 80/160 МГц в расчёте упрощены.'), E('div', { style: 'margin-top:8px' }, airBtn));
		}
		const heatBody = E('div', { class: 'nfm-heat' });
		const heatTabs = E('div', { class: 'nfm-tabs' }, Object.keys(HEAT).map(k =>
			E('button', { class: 'nfm-tab' + (k === 'cpu' ? ' on' : ''), type: 'button', 'data-k': k, click: ev => { S.heat = k; for (const b of heatTabs.children) b.classList.toggle('on', b === ev.currentTarget); renderHeat(); } }, HEAT[k][0])));
		function renderHeat() {
			const D = S.day, key = S.heat || 'cpu', H = HEAT[key];
			if (!D || !D.h || !D.h.info || !D.h.info.started) { heatBody.replaceChildren(E('div', { class: 'nfm-empty' }, D ? 'Нет данных' : 'Загружаю…')); return; }
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
			const days = [ 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс' ];
			const grid = E('div', { class: 'nfm-heat-grid' });
			grid.appendChild(E('span'));
			for (let h = 0; h < 24; h++) grid.appendChild(E('span', { class: 'nfm-heat-h' }, h % 3 === 0 ? String(h) : ''));
			for (let d = 0; d < 7; d++) {
				grid.appendChild(E('span', { class: 'nfm-heat-d' + (d === (now.getDay() + 6) % 7 ? ' today' : '') }, days[d]));
				for (let h = 0; h < 24; h++) {
					const v = avg[d * 24 + h];
					grid.appendChild(E('span', { class: 'nfm-heat-c', style: v == null ? '' : `--hv:${Math.round(100 * v / mx)}%`, title: days[d] + ', ' + h + ':00 — ' + (v == null ? 'нет данных' : H[2](v)) }));
				}
			}
			heatBody.replaceChildren(grid, E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, 'Среднее по часам за ' + (span > 7 ? 'последние ' + span + ' дн.' : 'последние 7 дней') + '. Тёмнее — меньше, ярче — больше (максимум ' + H[2](mx) + ').' + (avg.some(v => v == null) ? ' Пустые клетки — время, за которое истории ещё нет: подробные данные хранятся 7 суток, а длинная история (до ' + ((D.h.info && D.h.info.hist_days) || 30) + ' суток) копится с момента обновления до v1.14.0 и со временем заполнит карту.' : '')));
		}
		/* ---- Сводка недели: пиковые часы, самое «тяжёлое» устройство, средний пинг ---- */
		const wkBody = E('div', { class: 'nfm-wk' });
		function renderWeek() {
			const D = S.day;
			if (!D || !D.h || !D.h.info || !D.h.info.started) { wkBody.replaceChildren(E('div', { class: 'nfm-empty' }, D ? 'Нет данных' : 'Загружаю…')); return; }
			const hs = new Array(24).fill(0), hc = new Array(24).fill(0), byDay = {};
			let ps = 0, pc = 0;
			for (const r of D.h.rows || []) {
				const d = new Date(r[0] * 1000), h = d.getHours();
				if (r[4] >= 0 && r[5] >= 0) { hs[h] += r[4] + r[5]; hc[h]++; }
				if (r[7] >= 0) { ps += r[7]; pc++; const k = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(), t = byDay[k] || (byDay[k] = [ 0, 0 ]); t[0] += r[7]; t[1]++; }
			}
			const av = hs.map((x, i) => hc[i] ? x / hc[i] : 0);
			let bi = -1, bv = 0;
			for (let i = 0; i < 24; i++) { const v = av[i] + av[(i + 1) % 24] + av[(i + 2) % 24]; if (v > bv) { bv = v; bi = i; } }
			const hh = h => String(h % 24).padStart(2, '0') + ':00';
			const peak = bi < 0 ? [ '—', 'нет данных о трафике' ] : [ hh(bi) + '–' + hh(bi + 3), 'в среднем ' + (bv / 3 * 8 / 1e6).toFixed(1) + ' Мбит/с' ];
			/* тяжёлое устройство */
			let heavy = [ '—', 'учёт по приложениям не включён или данных ещё нет' ];
			const A = S.wkA;
			if (A && (A.hist || A.day)) {
				const t = String(A.today || ''), base = /^\d{8}$/.test(t) ? new Date(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8)) : new Date();
				base.setDate(base.getDate() - 6);
				const from = base.getFullYear() * 10000 + (base.getMonth() + 1) * 100 + base.getDate(), tot = {};
				for (const [ ip, , d, u ] of A.day || []) tot[ip] = (tot[ip] || 0) + d + u;
				for (const [ dt, ip, , d, u ] of A.hist || []) if (+dt >= from) tot[ip] = (tot[ip] || 0) + d + u;
				const ips = Object.keys(tot).filter(ip => !routerIps.has(ip)).sort((x, y) => tot[y] - tot[x]);
				if (ips.length) {
					let nmv = ips[0];
					for (const mac in hints) if ((hints[mac].ipaddrs || []).indexOf(ips[0]) >= 0) nmv = hints[mac].name || ips[0];
					heavy = [ nmv, fmtBytes(tot[ips[0]]) + ' за неделю' + (ips[1] ? ' · дальше ' + fmtBytes(tot[ips[1]]) : '') ];
				}
			}
			/* пинг */
			let ping = [ '—', 'нет данных о задержке' ];
			if (pc) {
				const dk = Object.keys(byDay).sort(), worst = dk.reduce((w, k) => (!w || byDay[k][0] / byDay[k][1] > byDay[w][0] / byDay[w][1]) ? k : w, null);
				ping = [ Math.round(ps / pc) + ' мс', worst && dk.length > 1 ? 'хуже всего ' + worst.slice(6, 8) + '.' + worst.slice(4, 6) + ' · ' + Math.round(byDay[worst][0] / byDay[worst][1]) + ' мс' : 'до интернета' ];
			}
			const tile = (ic, t, v, sub) => E('div', { class: 'nfm-wk-t' }, [ E('span', { class: 'nfm-wk-l' }, t), E('b', {}, v), E('span', { class: 'nfm-note-s' }, sub) ]);
			wkBody.replaceChildren(tile('', 'Пик трафика', peak[0], peak[1]), tile('', 'Самое «тяжёлое» устройство', heavy[0], heavy[1]), tile('', 'Средний пинг', ping[0], ping[1]));
		}
		/* ---- Трафик по месяцам: календарь суточных итогов (счётчики WAN, а если они занижены, то сумма по устройствам) ---- */
		const monBody = E('div', { class: 'nfm-mon' });
		const lim = () => { try { return Math.max(0, parseFloat(localStorage.getItem('nfm-limit-gb')) || 0); } catch (e) { return 0; } };
		function renderMon() {
			const T = S.tr; if (!T) { monBody.replaceChildren(E('div', { class: 'nfm-empty' }, 'Загружаю…')); return; }
			const now = new Date(); if (!S.mon) S.mon = { y: now.getFullYear(), m: now.getMonth() };
			const { y, m } = S.mon, dim = new Date(y, m + 1, 0).getDate(), first = (new Date(y, m, 1).getDay() + 6) % 7;
			const pre = String(y) + String(m + 1).padStart(2, '0'), by = {};
			let rx = 0, tx = 0, mx = 1, days = 0, viaDev = 0;
			for (const r of T.rows || []) if (r[0].indexOf(pre) === 0) { const d = +r[0].slice(6, 8); by[d] = r; rx += r[1]; tx += r[2]; mx = Math.max(mx, r[1] + r[2]); days++; if (r[3] === 1) viaDev++; }
			const cur = y === now.getFullYear() && m === now.getMonth(), elapsed = cur ? now.getDate() : dim, total = rx + tx;
			const avg = days ? total / Math.max(1, Math.min(days, elapsed)) : 0, fc = cur ? total + avg * (dim - elapsed) : total;
			const step = k => { const d = new Date(y, m + k, 1); S.mon = { y: d.getFullYear(), m: d.getMonth() }; renderMon(); };
			const title = new Date(y, m, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(/\s*г\.?$/, '');
			const L = lim() * 1073741824;
			const limIn = E('input', { type: 'number', min: '0', step: '10', value: lim() || '', placeholder: 'ГБ', class: 'nfm-mon-lim', 'aria-label': 'Лимит в месяц, ГБ',
				change: ev => { try { localStorage.setItem('nfm-limit-gb', String(Math.max(0, +ev.target.value || 0))); } catch (e) {} renderMon(); } });
			const grid = E('div', { class: 'nfm-mon-grid' });
			[ 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс' ].forEach(d => grid.appendChild(E('span', { class: 'nfm-mon-w' }, d)));
			for (let i = 0; i < first; i++) grid.appendChild(E('span'));
			for (let d = 1; d <= dim; d++) {
				const r = by[d], v = r ? r[1] + r[2] : 0;
				grid.appendChild(E('span', Object.assign({ class: 'nfm-mon-d' + (cur && d === now.getDate() ? ' today' : '') + (r ? ' has' : ''), style: r ? `--hv:${Math.max(8, Math.round(100 * v / mx))}%` : '',
					title: r ? `${d}: ↓ ${fmtBytes(r[1])}, ↑ ${fmtBytes(r[2])}${r[3] === 1 ? ' (по данным устройств)' : ''}. Нажмите, чтобы увидеть, кто сколько скачал` : `${d}: нет данных` },
					r ? { role: 'button', tabindex: '0', click: () => dayReport(r[0]), keydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); dayReport(r[0]); } } } : {}), [ E('b', {}, String(d)), E('i', {}, r ? fmtBytes(v) : '') ]));
			}
			const kids = [
				E('div', { class: 'nfm-mon-h' }, [
					E('button', { type: 'button', class: 'nfm-tab', 'aria-label': 'Предыдущий месяц', click: () => step(-1) }, '‹'),
					E('b', { class: 'nfm-mon-t' }, title),
					E('button', { type: 'button', class: 'nfm-tab', 'aria-label': 'Следующий месяц', click: () => step(1) }, '›'),
					E('span', { class: 'nfm-spacer' }), E('label', { class: 'nfm-note-s' }, [ 'Лимит, ГБ ', limIn ]) ]),
				E('div', { class: 'nfm-mon-sum' }, [
					E('div', {}, [ E('span', {}, 'Всего'), E('b', {}, fmtBytes(total)) ]),
					E('div', {}, [ E('span', {}, '↓ принято'), E('b', {}, fmtBytes(rx)) ]),
					E('div', {}, [ E('span', {}, '↑ отправлено'), E('b', {}, fmtBytes(tx)) ]),
					E('div', {}, [ E('span', {}, 'В день'), E('b', {}, days ? fmtBytes(avg) : '—') ]),
					cur ? E('div', {}, [ E('span', {}, 'Прогноз на месяц'), E('b', {}, days ? '≈ ' + fmtBytes(fc) : '—') ]) : '' ]) ];
			if (L > 0) {
				const pc = Math.min(100, 100 * total / L), pf = 100 * fc / L;
				kids.push(E('div', { class: 'nfm-mon-bar', 'data-lvl': pc >= 100 ? 'bad' : pc >= 80 ? 'mid' : 'ok' }, [ E('i', { style: `width:${pc}%` }) ]),
					E('div', { class: 'nfm-note-s' }, `Использовано ${Math.round(pc)}% лимита` + (cur && days ? `; по прогнозу к концу месяца ≈ ${Math.round(pf)}%` + (pf > 100 ? ' — лимит будет превышен' : '') : '')));
			}
			kids.push(grid);
			if (viaDev) kids.push(E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, 'За ' + viaDev + ' ' + (viaDev === 1 ? 'день' : viaDev < 5 ? 'дня' : 'дней') + ' счётчики порта WAN показывали заметно меньше, чем прошло через устройства (аппаратное ускорение пакетов скрывает трафик от порта), поэтому итог взят по данным устройств, без трафика самого роутера. Они совпадают с отчётом по дню (нажмите на день).'));
			if (!T.persist) kids.push(E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, 'Итоги хранятся в памяти и обнулятся при перезагрузке роутера. Чтобы копить месяцы, укажите папку на флешке в настройках сборщика (PERSIST_DIR).'));
			monBody.replaceChildren(...kids);
		}
		/* ---- отчёт за день: кто сколько скачал и отдал (по нажатию на день в календаре) ---- */
		function dayReport(ymd) {
			const dt = new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
			const title = 'Трафик за ' + dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
			const body = E('div', { class: 'nfm nfm-dr' }, E('div', { class: 'nfm-empty' }, 'Собираю отчёт…'));
			ui.showModal(title, [ body, E('div', { class: 'button-row' }, [ E('button', { class: 'btn', click: ui.hideModal }, 'Закрыть') ]) ]);
			const J = a => callHistory(a).catch(() => null);
			Promise.all([ J([ 'devdaily' ]), J([ 'devices' ]), J([ 'devhr' ]) ]).then(([ dd, dv, hr ]) => {
				const norm = ip => String(ip).toLowerCase(), ipMac = {};
				for (const mac in hints) for (const ip of (hints[mac].ipaddrs || []).concat(hints[mac].ip6addrs || [])) ipMac[norm(ip)] = mac;
				for (const [ ip, mac ] of (dv && dv.neigh) || []) if (!ipMac[norm(ip)]) ipMac[norm(ip)] = String(mac).toUpperCase();
				routerIps.learn(dv && dv.info);
				const ymdOf = d => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
				const nowD = new Date(), today = ymdOf(nowD), yest = ymdOf(new Date(nowD.getTime() - 86400000));
				let src = [], how = '';
				const arch = ((dd && dd.rows) || []).filter(r => r[0] === ymd);
				if (arch.length) { src = arch.map(r => [ r[1], r[2], r[3], r[4] !== '-' ? r[4].toUpperCase() : '' ]); how = 'Итоги за сутки, сохранённые сборщиком.'; }
				else if (ymd === today && dv && dv.day && dv.day.length) { src = dv.day.map(r => [ r[0], r[1], r[2], '' ]); how = 'Сегодняшний день ещё не закончен: цифры растут.'; }
				else if (ymd === yest && dv && dv.yday && dv.yday.length) { src = dv.yday.map(r => [ r[0], r[1], r[2], '' ]); how = 'Итоги за сутки по данным сборщика.'; }
				else {
					const by = {};
					for (const r of (hr && hr.rows) || []) if (ymdOf(new Date(r[0] * 1000)) === ymd) { const e = by[r[1]] || (by[r[1]] = [ r[1], 0, 0, '' ]); e[1] += +r[2]; e[2] += +r[3]; }
					src = Object.values(by);
					if (src.length) how = 'Собрано из почасовых итогов: точность до часа.';
				}
				const acc = {};
				for (const [ ip, rx, tx, mac0 ] of src) {
					const mac = mac0 || ipMac[norm(ip)] || '', k = routerIps.has(ip) ? 'router' : mac || (String(ip).indexOf(':') >= 0 ? 'v6' : ip);
					const e = acc[k] || (acc[k] = { k, mac, ip, rx: 0, tx: 0 });
					e.rx += +rx; e.tx += +tx;
				}
				const list = Object.values(acc).sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx));
				const wan = ((S.tr && S.tr.rows) || []).find(r => r[0] === ymd);
				const sumRx = list.reduce((a, e) => a + e.rx, 0), sumTx = list.reduce((a, e) => a + e.tx, 0), mx = Math.max(1, ...list.map(e => e.rx + e.tx));
				const kids = [];
				if (wan) kids.push(E('div', { class: 'nfm-mon-sum' }, [
					E('div', {}, [ E('span', {}, wan[3] === 1 ? 'Всего (по устройствам)' : 'Всего через WAN'), E('b', {}, fmtBytes(wan[1] + wan[2])) ]),
					E('div', {}, [ E('span', {}, '↓ принято'), E('b', {}, fmtBytes(wan[1])) ]),
					E('div', {}, [ E('span', {}, '↑ отправлено'), E('b', {}, fmtBytes(wan[2])) ]) ]));
				if (!list.length) kids.push(E('div', { class: 'nfm-hint' }, 'По устройствам за этот день данных нет. Подробные итоги по устройствам копятся с версии 1.15 (в архив уходят сутки, закончившиеся после обновления), а почасовых данных хватает примерно на две недели. Чтобы они переживали перезагрузку, подключите накопитель (История → «Накопители»).'));
				else {
					kids.push(E('table', { class: 'nfm-table' }, [
						E('thead', {}, E('tr', {}, [ E('th', {}, 'Устройство'), E('th', { class: 'r' }, '↓ скачано'), E('th', { class: 'r' }, '↑ отдано'), E('th', { class: 'r' }, 'Всего') ])),
						E('tbody', {}, list.slice(0, 40).map(e => {
							const h = e.mac ? (hints[e.mac] || {}) : {}, id = e.mac ? devId(e.mac, h.name) : null;
							const label = e.k === 'router' ? 'Сам роутер (VPN, DNS, обновления)' : e.k === 'v6' ? 'Другие адреса IPv6' : (h.name || (id && id.known ? [ id.label || 'Устройство', id.vendor && id.vendor !== id.label ? id.vendor : '' ].filter(Boolean).join(' ') : '') || e.ip);
							return E('tr', {}, [
								E('td', {}, [ id ? devIcon(id) : '', label, e.k !== 'router' && e.k !== 'v6' && label !== e.ip ? E('span', { class: 'nfm-chip' }, e.ip) : '',
									E('div', { class: 'nfm-mon-bar', 'data-lvl': 'ok', style: 'margin-top:4px;height:4px' }, E('i', { style: 'width:' + Math.max(2, Math.round(100 * (e.rx + e.tx) / mx)) + '%' })) ]),
								E('td', { class: 'r' }, fmtBytes(e.rx)), E('td', { class: 'r' }, fmtBytes(e.tx)), E('td', { class: 'r' }, E('b', {}, fmtBytes(e.rx + e.tx))) ]);
						})) ]));
					if (list.length > 40) kids.push(E('div', { class: 'nfm-note-s' }, 'Показаны 40 самых активных из ' + list.length + '.'));
					if (list.some(e => e.k === 'router')) kids.push(E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, 'Строка «Сам роутер» (адрес вашего роутера у провайдера) — это трафик самого роутера: прокси или VPN на нём, обновления, DNS. Трафик устройств через такой прокси считается дважды: у устройства и у роутера. Поэтому в «Всего» и в календаре строка не входит.'));
					if (wan && (wan[1] + wan[2]) > (sumRx + sumTx) * 1.15) kids.push(E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, 'Сумма по устройствам (' + fmtBytes(sumRx + sumTx) + ') меньше счётчика WAN: часть трафика не приписывается устройствам (аппаратное ускорение пакетов, служебный трафик, устройства вне первой сотни записей).'));
				}
				if (how) kids.push(E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, how));
				body.replaceChildren(...kids);
			});
		}
		/* ---- Сравнение периодов: недели и месяцы по суточным итогам WAN ---- */
		const cmpBody = E('div', { class: 'nfm-cmp' });
		const CMP = { w: 'Неделя к прошлой', m: 'Месяц к прошлому' };
		const cmpTabs = E('div', { class: 'nfm-tabs' }, Object.keys(CMP).map(k =>
			E('button', { class: 'nfm-tab' + (k === 'w' ? ' on' : ''), type: 'button', click: ev => { S.cmp = k; for (const b of cmpTabs.children) b.classList.toggle('on', b === ev.currentTarget); renderCmp(); } }, CMP[k])));
		function renderCmp() {
			const T = S.tr; if (!T) { cmpBody.replaceChildren(E('div', { class: 'nfm-empty' }, 'Загружаю…')); return; }
			const mode = S.cmp || 'w', by = {};
			for (const r of T.rows || []) by[r[0]] = r;
			const key = d => String(d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate());
			const shift = (d, k) => { const x = new Date(d); x.setDate(x.getDate() + k); return x; };
			const ddmm = d => String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');
			const now = new Date(); now.setHours(12, 0, 0, 0);
			let cur = [], prev = [], hc, hp;
			if (mode === 'w') {
				for (let i = 6; i >= 0; i--) { cur.push(shift(now, -i)); prev.push(shift(now, -i - 7)); }
				hc = [ 'Последние 7 дней', ddmm(cur[0]) + '–' + ddmm(cur[6]) ]; hp = [ 'Предыдущие 7 дней', ddmm(prev[0]) + '–' + ddmm(prev[6]) ];
			} else {
				const y = now.getFullYear(), m = now.getMonth(), n = now.getDate(), pm = new Date(y, m - 1, 1, 12), pdim = new Date(y, m, 0).getDate();
				for (let d = 1; d <= n; d++) cur.push(new Date(y, m, d, 12));
				for (let d = 1; d <= Math.min(n, pdim); d++) prev.push(new Date(pm.getFullYear(), pm.getMonth(), d, 12));
				const mn = d => d.toLocaleDateString('ru-RU', { month: 'long' }), cap = x => x.charAt(0).toUpperCase() + x.slice(1);
				hc = [ cap(mn(cur[0])), '1–' + n + ' число' ]; hp = [ cap(mn(pm)), '1–' + Math.min(n, pdim) + ' число' ];
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
			const rows = [ [ 'Всего', a.tot, b.tot ], [ 'Принято', a.rx, b.rx ], [ 'Отправлено', a.tx, b.tx ], [ 'В среднем за день', a.avg, b.avg ] ];
			const cells = [ E('div', { class: 'h' }, ''), E('div', { class: 'h n' }, [ hc[0], E('small', {}, hc[1]) ]), E('div', { class: 'h n' }, [ hp[0], E('small', {}, hp[1]) ]), E('div', { class: 'h n' }, 'Разница') ];
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
				cells.push(E('div', { class: 'sec' }, 'Качество связи'), E('div', { class: 'sec' }), E('div', { class: 'sec' }), E('div', { class: 'sec' }));
				line('Пинг в среднем', avg(qa.ping), avg(qb.ping), v => nf0.format(v) + ' мс');
				line('Потери пакетов', avg(qa.loss), avg(qb.loss), v => nf1.format(v) + '%');
				line('Пик загрузки', qa.pk || null, qb.pk || null, v => rateText(v));
				line('Процессор в среднем', avg(qa.cpu), avg(qb.cpu), v => nf0.format(v) + '%');
				line('Температура в среднем', avg(qa.temp), avg(qb.temp), v => nf1.format(v) + ' °C');
			}
			const hv = o => o.mx ? ddmm(o.mx[0]) + ' · ' + fmtBytes(o.mx[1]) : '—';
			cells.splice(cells.findIndex(c => c.classList && c.classList.contains('sec')) < 0 ? cells.length : cells.findIndex(c => c.classList && c.classList.contains('sec')), 0, E('div', {}, 'Самый тяжёлый день'), E('div', { class: 'n' }, hv(a)), E('div', { class: 'n' }, hv(b)), E('div', { class: 'n eq' }, ''));
			const note = !a.n ? 'За этот период суточных итогов ещё нет.' : !b.n ? 'За прошлый период данных нет: сборщик ведёт суточные итоги с момента установки, сравнение появится позже.'
				: (a.n < cur.length || b.n < prev.length) ? 'Дней с данными: ' + a.n + ' из ' + cur.length + ' и ' + b.n + ' из ' + prev.length + '. Итоги считаются только по ним.' : 'Трафик через WAN: принято и отправлено провайдеру. ↑ больше, чем раньше, ↓ меньше.';
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
		const nonneg = v => (v == null || v < 0) ? '' : v;
		const stamp = () => isoD(new Date().getFullYear() * 10000 + (new Date().getMonth() + 1) * 100 + new Date().getDate());
		const EXPORTS = [
			[ 'Трафик по дням', () => {
				const r = S.tr && S.tr.rows; if (!r || !r.length) return null;
				return [ 'nightfall-traffic-' + stamp() + '.csv', [ [ 'Дата', 'Принято, байт', 'Отправлено, байт', 'Всего, байт' ] ].concat(r.map(x => [ isoD(x[0]), x[1], x[2], x[1] + x[2] ])) ];
			} ],
			[ 'Приложения', () => {
				const A = S.wkA; if (!A || !(A.hist || A.day || []).length) return null;
				const nm = {}; for (const mac in hints) for (const ip of (hints[mac].ipaddrs || [])) nm[ip] = hints[mac].name || '';
				const t = /^\d{8}$/.test(String(A.today || '')) ? isoD(A.today) : stamp();
				const out = [ [ 'Дата', 'Устройство (IP)', 'Имя', 'Приложение', 'Принято, байт', 'Отправлено, байт' ] ];
				for (const [ dt, ip, app, d, u ] of A.hist || []) out.push([ isoD(dt), ip, nm[ip] || '', app, d, u ]);
				for (const [ ip, app, d, u ] of A.day || []) out.push([ t, ip, nm[ip] || '', app, d, u ]);
				return [ 'nightfall-apps-' + stamp() + '.csv', out ];
			} ],
			[ 'Графики (выбранный период)', () => {
				const r = S.hist && S.hist.rows; if (!r || !r.length) return null;
				return [ 'nightfall-metrics-' + stamp() + '.csv', [ [ 'Время', 'Процессор, %', 'Память, %', 'Температура, °C', 'Загрузка, байт/с', 'Отдача, байт/с', 'Пинг до шлюза, мс', 'Пинг до интернета, мс' ] ]
					.concat(r.map(x => [ isoT(x[0]), nonneg(x[1]), nonneg(x[2]), nonneg(x[3]), nonneg(x[4]), nonneg(x[5]), nonneg(x[6]), nonneg(x[7]) ])) ];
			} ],
			[ 'Журнал обрывов и перезагрузок', () => {
				const r = S.jrn && S.jrn.rows; if (!r || !r.length) return null;
				return [ 'nightfall-journal-' + stamp() + '.csv', [ [ 'Время', 'Событие', 'Длительность, с' ] ].concat(r.slice().sort((a, b) => a[0] - b[0]).map(x => [ isoT(x[0]), x[1] === 'outage' ? 'обрыв интернета' : x[1] === 'boot' ? 'перезагрузка' : x[1], x[2] == null ? '' : x[2] ])) ];
			} ]
		];
		const expBtns = EXPORTS.map(([ label, make ]) => E('button', { type: 'button', class: 'nfm-btn', click: () => {
			let r = null; try { r = make(); } catch (e) { r = null; }
			if (!r) { expNote.textContent = '«' + label + '»: данных пока нет.'; return; }
			saveCsv(r[0], r[1]); expNote.textContent = 'Сохранён файл ' + r[0] + ' (записей: ' + (r[1].length - 1) + ').';
		} }, '⬇ ' + label));

		const hist = E('div', { hidden: true }, [
			histNote,
			E('div', { class: 'nfm-grid' }, [ card([ 'Сводка за день', E('span', { class: 'nfm-spacer' }), E('span', { class: 'nfm-note-s' }, 'с 00:00 по данным сборщика') ], dayBody) ]),
			E('div', { class: 'nfm-grid' }, [ card('Качество Wi‑Fi по клиентам', wqBody) ]),
			E('div', { class: 'nfm-grid' }, [ card([ 'Сигнал Wi‑Fi по часам', E('span', { class: 'nfm-spacer' }), whTabs ], whBody) ]),
			E('div', { class: 'nfm-grid' }, [ card([ 'Wi‑Fi: загруженность каналов', E('span', { class: 'nfm-spacer' }) ], airBody) ]),
			E('div', { class: 'nfm-grid' }, [ card([ 'Сводка недели', E('span', { class: 'nfm-spacer' }), E('span', { class: 'nfm-note-s' }, 'последние 7 дней') ], wkBody) ]),
			E('div', { class: 'nfm-grid' }, [ card('Трафик по месяцам', monBody) ]),
			E('div', { class: 'nfm-grid' }, [ card([ 'Сравнение периодов', E('span', { class: 'nfm-spacer' }), cmpTabs ], cmpBody) ]),
			E('div', { class: 'nfm-grid' }, [ card([ 'Тепловая карта по часам', E('span', { class: 'nfm-spacer' }), heatTabs ], heatBody) ]),
			E('div', { class: 'nfm-grid' }, [
				card([ 'Процессор, память, температура', E('span', { class: 'nfm-spacer' }),
					E('span', { class: 'nfm-legend' }, [ legendDot('c-cpu', 'Процессор'), legendDot('c-mem', 'Память'), legendDot('c-temp', 'Температура, °C'), legendDot('c-base', 'как обычно') ]), rangeTabs ], histMain.el)
			]),
			E('div', { class: 'nfm-grid nfm-g21' }, [
				card([ 'Интернет: задержка', E('span', { class: 'nfm-spacer' }),
					E('span', { class: 'nfm-legend' }, [ legendDot('c-up', 'до шлюза'), legendDot('c-down', 'до интернета') ]) ], histPing.el),
				card('Качество связи', E('div', {}, [ pingTiles, E('div', { class: 'nfm-note-s', style: 'margin-top:10px' }, 'Пропуски на графике — моменты, когда ответа не было.') ]))
			]),
			E('div', { class: 'nfm-grid' }, [
				card([ 'Скорость интернета (WAN)', E('span', { class: 'nfm-spacer' }),
					E('span', { class: 'nfm-legend' }, [ legendDot('c-down', 'Загрузка'), legendDot('c-up', 'Отдача') ]) ], histNet.el)
			]),
			E('div', { class: 'nfm-grid' }, [
				card('События и предупреждения', E('div', {}, [ evBox, histInfo ]))
			]),
			E('div', { class: 'nfm-grid' }, [ card('Журнал перезагрузок и обрывов связи', E('div', {}, [ jrnTiles, jrnBox ])) ]),
			E('div', { class: 'nfm-grid nfm-g21' }, [
				card([ 'Скорость интернета (замеры роутера)', E('span', { class: 'nfm-spacer' }), spdSrc, spdSel, spdBtn ], E('div', {}, [ spdTiles, spdChart.el, spdList, spdNote ])),
				card('Хранение истории и износ флеш-памяти', flashBox)
			]),
			E('div', { class: 'nfm-grid' }, [ card([ 'Экспорт данных в CSV', E('span', { class: 'nfm-spacer' }), E('span', { class: 'nfm-note-s' }, 'открывается в Excel и Google Таблицах') ], E('div', {}, [ E('div', { class: 'nfm-exp' }, expBtns), E('div', { style: 'margin-top:8px' }, expNote) ])) ]),
			E('div', { class: 'nfm-grid' }, [ card([ 'Накопители', E('span', { class: 'nfm-spacer' }), E('button', { type: 'button', class: 'nfm-btn', click: () => { dskBody.replaceChildren(E('div', { class: 'nfm-empty' }, 'Ищу накопители…')); loadDisks(); } }, 'Обновить') ], E('div', {}, [ dskBody, dskMsg, E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, 'История (графики, трафик по дням и приложениям, журнал) сохраняется на накопитель раз в час и не пропадает при перезагрузке. Флешка не изнашивает память роутера.') ])) ]),
			E('div', { class: 'nfm-grid' }, [ cfgCard ])
		]);

		const pill = E('span', { class: 'nfm-pill' }, `обновляется каждые ${INTERVAL} с`);
		const pauseBtn = E('button', { class: 'nfm-btn', click: () => setPaused(!S.paused) }, 'Пауза');
		const tabBtns = {};
		const tabs = E('div', { class: 'nfm-tabs', role: 'tablist' }, [ [ 'overview', 'Обзор' ], [ 'net', 'Сеть' ], [ 'procs', 'Программы' ], [ 'svcs', 'Службы' ], [ 'hist', 'История' ] ]
			.map(([ k, l ]) => tabBtns[k] = E('button', { class: 'nfm-tab nfm-ti', 'data-ic': k, role: 'tab', click: () => { S.tab = k; refresh(); } }, l)));

		const svcFilter = E('input', { class: 'nfm-in', type: 'search', placeholder: 'Найти службу…', input: () => renderServices() });
		const svcBox = E('div');
		const svcMore = E('div');
		const svcs = E('div', { hidden: true }, [
			E('div', { class: 'nfm-grid' }, [ card([ 'Состояние служб', E('span', { class: 'nfm-spacer' }), svcFilter ], E('div', {}, [ svcBox,
				E('div', { class: 'nfm-note-s', style: 'margin-top:10px' }, 'Красным отмечены службы, которые включены в автозапуск, но сейчас не работают. Ключевые службы (сеть, веб-сервер, SSH, файрвол) нельзя остановить отсюда, чтобы не потерять доступ.') ])) ]),
			E('div', { class: 'nfm-grid' }, [ svcMore ])
		]);
		{ const hv = (window.location.hash || '').replace('#', ''); if ([ 'overview', 'net', 'procs', 'svcs', 'hist' ].includes(hv)) S.tab = hv; }
		const root = E('div', { class: 'nfm' }, [
			E('style', {}, CSS + XCSS),
			E('div', { class: 'nfm-top' }, [
				E('div', {}, [ E('h2', {}, 'Монитор ресурсов'),
					E('div', { class: 'nfm-sub' }, [ (board.model || board.hostname || 'OpenWrt') + ' · работает ', t('uptime') ]) ]),
				E('span', { class: 'nfm-spacer' }), pill, pauseBtn, tabs ]),
			overview, net, procs, svcs, hist
		]);

		/* ---------- quick actions ---------- */
		function runChecked(fn) {
			return Promise.resolve().then(fn).then(res => {
				if (res && typeof res.code === 'number' && res.code !== 0)
					throw new Error((res.stderr || '').trim() || `код возврата ${res.code}`);
				return res;
			});
		}

		function confirmRun(title, text, fn, busy, reboot) {
			ui.showModal(title, [
				E('p', {}, text),
				E('div', { class: 'button-row' }, [
					E('button', { class: 'btn', click: ui.hideModal }, 'Отмена'),
					E('button', { class: 'btn cbi-button-negative important', click: () => {
						ui.showModal(null, [ E('p', { class: 'spinning' }, busy) ]);
						runChecked(fn).then(() => {
							if (reboot) window.setTimeout(() => window.location.reload(), 60000);
							else window.setTimeout(ui.hideModal, 2500);
						}).catch(err => {
							ui.hideModal();
							ui.addNotification(null, E('p', {}, 'Не удалось выполнить: ' + (err.message || err)), 'danger');
						});
					} }, 'Выполнить')
				])
			]);
		}

		function wakeDialog() {
			const hosts = [];
			for (const mac in hints)
				hosts.push({ mac: mac.toUpperCase(), name: hints[mac].name || (hints[mac].ipaddrs || [])[0] || mac });
			hosts.sort((a, b) => a.name.localeCompare(b.name));

			const sel = E('select', { class: 'nfm-sel', style: 'width:100%' }, [ E('option', { value: '' }, '— выберите устройство —') ]
				.concat(hosts.map(h => E('option', { value: h.mac }, `${h.name} (${h.mac})`))));
			const man = E('input', { type: 'text', placeholder: 'или введите MAC-адрес: AA:BB:CC:DD:EE:FF', style: 'width:100%;margin-top:8px' });

			ui.showModal('Разбудить устройство', [
				E('p', {}, `Магический пакет будет отправлен в сеть ${lanDev}. Устройство должно поддерживать Wake-on-LAN.`),
				sel, man,
				E('div', { class: 'button-row' }, [
					E('button', { class: 'btn', click: ui.hideModal }, 'Отмена'),
					E('button', { class: 'btn cbi-button-positive important', click: () => {
						const mac = (man.value.trim() || sel.value).toUpperCase();
						if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
							ui.addNotification(null, E('p', {}, 'Укажите корректный MAC-адрес.'), 'warning');
							return;
						}
						ui.hideModal();
						runChecked(() => fs.exec('/usr/bin/etherwake', [ '-b', '-i', lanDev, mac ])).then(() => {
							ui.addNotification(null, E('p', {}, `Пакет пробуждения отправлен: ${mac}`), 'success');
						}).catch(err => {
							ui.addNotification(null, E('p', {}, 'Не удалось отправить пакет: ' + (err.message || err) + '. Нужен пакет etherwake (apk add etherwake).'), 'danger');
						});
					} }, 'Разбудить')
				])
			]);
		}

		/* Primary path: LuCI's own network model (same data the Overview page uses).
		   Fallback: raw ubus calls. Errors are kept in wifiErr for the empty-state hint. */
		let wifiErr = '';
		function fetchWifiModel() {
			return network.getWifiNetworks().then(nets => Promise.all((nets || []).map(n => {
				const ifname = n.getIfname && n.getIfname();
				if (!ifname) return [];
				const dev = n.getWifiDevice ? n.getWifiDevice() : null;
				const band = dev && dev.get ? dev.get('band') : null;
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
							ifs.push({ ifname: i.ifname, ssid: (i.config || {}).ssid || i.ifname, band: (st[r].config || {}).band });
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
			return h ? `${h} ч ${m} мин` : (m ? `${m} мин` : `${Math.floor(sec)} с`);
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
			if (S.tab === 'net' && due('devs', DEVICES_EVERY * INTERVAL)) jobs.push(callHistory([ 'devices' ]).then(r => { S.devs = r; }));
			if (S.tab === 'hist' && due('hist', HIST_EVERY * INTERVAL)) jobs.push(callHistory([ 'series', RANGES[S.range][0] ]).then(r => { S.hist = r; }));
			if (S.tab === 'hist' && due('tr', 300)) jobs.push(callHistory([ 'traffic' ]).then(r => { S.tr = r; }));
			if (S.tab === 'hist' && due('day', 60)) jobs.push(Promise.all([ callHistory([ 'series', 'coarse' ]), callHistory([ 'devices' ]) ]).then(r => { S.day = { h: r[0], d: r[1] }; }));
			if (S.tab === 'hist' && due('wkA', 300)) jobs.push(callHistory([ 'apps' ]).then(r => { S.wkA = r || null; }));
			if (S.tab === 'hist' && due('wq', 60)) jobs.push(callHistory([ 'wifi' ]).then(r => { S.wq = r || null; }));
			if (S.tab === 'hist' && due('whr', 120)) jobs.push(callHistory([ 'wifi-hr' ]).then(r => { S.whr = r || null; }));
			if (S.tab === 'hist' && due('lg', 300)) jobs.push(callHistory([ 'series', 'long' ]).then(r => { S.lg = r || null; }));
			if (S.tab === 'net' && due('chan', DEVICES_EVERY * INTERVAL)) jobs.push(callHistory([ 'channel' ]).then(r => { S.chan = r; }));
			if (S.tab === 'hist' && due('jrn', 30)) jobs.push(callHistory([ 'journal' ]).then(r => { S.jrn = r; }));
			if (S.tab === 'hist' && due('spd', S.spdRun ? 3 : 30)) jobs.push(callHistory([ 'speed' ]).then(r => { S.spd = r; if (S.spdRun && Date.now() - (S.spdT || 0) > 4000 && (!r || !r.running)) { S.spdRun = false; if (r === false) ui.addNotification(null, E('p', {}, 'Замер завершён, но результат не прочитан: ' + MISSING), 'danger'); } }));
			if (S.tab === 'svcs' && due('svc', 6)) jobs.push(Promise.all([ L.resolveDefault(callInitList(), null), L.resolveDefault(callServiceList(), null) ]).then(r => { S.svc = { init: r[0], run: r[1] }; }));
			if (S.tab === 'hist' && S.cfg === undefined) { S.cfg = null; jobs.push(callCfg([ 'get' ]).then(r => { S.cfg = r; fillCfg(r && r.values); renderDisks(); })); }
			if (S.tab === 'hist' && S.dsk === undefined) { S.dsk = null; jobs.push(loadDisks()); }
			return Promise.all(jobs);
		}

		const MISSING = 'Сборщик истории не запущен. На роутере выполните: /etc/init.d/nightfall-collector enable && /etc/init.d/nightfall-collector start';

		function callCfg(args) {
			return fs.exec(CFG, args).then(res => {
				try { return JSON.parse(res.stdout); } catch (e) { return false; }
			}).catch(() => false);
		}

		function fillCfg(v) {
			if (!v) { cfgMsg.textContent = 'Настройки недоступны: нужна служба сборщика и обновлённый пакет.'; return; }
			cfgMsg.textContent = '';
			for (const k in cfgInputs) cfgInputs[k].value = v[k] != null ? v[k] : '';
		}

		function saveCfg() {
			const args = [ 'set' ].concat(Object.keys(cfgInputs).map(k => k + '=' + cfgInputs[k].value.trim()));
			callCfg(args).then(r => {
				if (r && r.ok) {
					cfgMsg.textContent = 'Сохранено, сборщик перезапущен.';
					S.at.alerts = 0; S.at.hist = 0;
					callCfg([ 'get' ]).then(c => { S.cfg = c; if (c) fillCfg(c.values); cfgMsg.textContent = 'Сохранено, сборщик перезапущен.'; });
					window.setTimeout(() => { cfgMsg.textContent = ''; }, 5000);
				}
				else ui.addNotification(null, E('p', {}, 'Не сохранено: ' + ((r && r.error) || 'нет ответа от nightfall-config')), 'danger');
			});
		}

		function buildDiag(hd, cfg) {
			const d = S.last || {}, out = [], h = hd || {}, info = h.info || {};
			const rel = board.release || {};
			const fm = kb => fmtMB(kb);
			out.push('Nightfall monitor — диагностика, ' + new Date().toLocaleString('ru-RU'));
			out.push(`Модель: ${board.model || '?'} · ${rel.description || rel.version || 'OpenWrt'} · ядро ${board.kernel || '?'}`);
			if (d.up != null) out.push(`Аптайм: ${fmtUptime(d.up)} · нагрузка ${(d.load || []).map(v => nf2.format(v)).join(' / ')}`);
			if (S.cpuNow) out.push(`Процессор: ${(d.cpu || []).length - 1} яд., ${nf0.format(S.cpuNow.pct)}% (программы ${nf0.format(S.cpuNow.apps)}%, система ${nf0.format(S.cpuNow.sys)}%, прерывания ${nf1.format(S.cpuNow.irq)}%, ожидание диска ${nf1.format(S.cpuNow.io)}%)`);
			if (d.temps) out.push('Температуры (как отдаёт система): ' + (d.temps.length ? d.temps.map(t => `${t[0]}=${nf1.format(t[1] / 1000)}°C`).join(', ') : 'датчиков нет'));
			if (d.mem) out.push(`Память: занято ${fm(d.mem.total - d.mem.avail)} из ${fm(d.mem.total)}, кеш ${fm(d.mem.cached + d.mem.buffers)}, swap ${fm(d.mem.swap - d.mem.swapfree)} из ${fm(d.mem.swap)}`);
			if (d.flash) out.push(`Флеш: ${fm(d.flash[1])} из ${fm(d.flash[0])} · /tmp ${d.tmp ? fm(d.tmp[1]) : '–'}`);
			if (d.ct) out.push(`Соединения: ${d.ct[0]} из ${d.ct[1]}`);
			out.push(`Интерфейсы (сейчас): ` + (d.net || []).map(n => { const r = (S.rates || {})[n[0]] || { rx: 0, tx: 0 }; return `${n[0]} ↓${rateText(r.rx)} ↑${rateText(r.tx)}`; }).join('; '));
			out.push(`Wi-Fi клиентов: ${S.wifi ? S.wifi.length : '–'}`);
			out.push(`Сборщик: ${info.started ? 'работает' : 'НЕ ЗАПУЩЕН (данных нет)'} · WAN ${info.wan_dev || '–'} · шлюз ${info.gateway || '–'} · проверка ${info.targets || '–'} · conntrack_acct=${info.acct || '–'} · flow offloading=${info.offload || '–'} · история сохраняется: ${info.persist === '1' ? 'да' : 'нет'}`);
			const last = (h.rows || []).slice(-1)[0];
			if (last) out.push(`Последний замер: CPU ${last[1]}%, память ${last[2]}%, температура ${last[3] < 0 ? 'н/д' : last[3] + '°C'}, задержка шлюз ${last[6] < 0 ? 'нет' : last[6] + ' мс'} / интернет ${last[7] < 0 ? 'нет' : last[7] + ' мс'}`);
			if (cfg && cfg.values) out.push('Настройки: ' + Object.keys(cfg.values).map(k => `${k}=${cfg.values[k]}`).join(' '));
			const act = h.active || [];
			out.push('Активные предупреждения: ' + (act.length ? act.map(a => a[3]).join('; ') : 'нет'));
			const evs = (h.events || []).slice(-10);
			if (evs.length) out.push('Последние события:\n' + evs.map(e => `  ${fmtTs(e[0])} [${e[1]}] ${e[2]}`).join('\n'));
			if (S.full) out.push('Программы по памяти: ' + groupedProcs().sort((a, b) => b.rss - a.rss).slice(0, 6).map(e => `${e.label} ${fmtMB(e.rss)}`).join(', '));
			return out.join('\n');
		}

		function copyDiag() {
			Promise.all([ callHistory([ 'series', 'fine' ]), callCfg([ 'get' ]) ]).then(([ hd, cfg ]) => {
				const text = buildDiag(hd || {}, cfg);
				const ta = E('textarea', { class: 'nfm-diag', readonly: '' }, text);
				const fallback = () => {
					ui.showModal('Диагностика', [
						E('p', {}, 'Автоматически скопировать не удалось. Выделите текст и скопируйте вручную (Ctrl+C).'), ta,
						E('div', { class: 'button-row' }, [ E('button', { class: 'btn', click: ui.hideModal }, 'Закрыть') ]) ]);
					ta.select();
				};
				const ok = () => ui.addNotification(null, E('p', {}, 'Диагностика скопирована в буфер обмена. IP- и MAC-адреса устройств в неё не входят.'), 'success');
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
			return new Date(ts * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
		}

		function xLabels(end, win) {
			const out = [];
			for (let i = 0; i <= 5; i++) {
				const d = new Date((end - win * (5 - i) / 5) * 1000);
				out.push(i === 5 ? 'сейчас' : win > 2 * 86400
					? d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
					: d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
			}
			return out;
		}

		function tempAlertOn() {
			return !!(S.alerts && (S.alerts.active || []).some(a => a[0] === 'temp' || a[0] === 'tempc'));
		}

		function renderAlerts() {
			const a = S.alerts && S.alerts.active || [];
			alertsBox.toggleAttribute('hidden', !a.length);
			alertsBox.replaceChildren(...a.map(x => E('div', { class: 'nfm-alert' + (x[2] === 'crit' ? ' crit' : '') },
				[ E('b', {}, x[3]), E('small', {}, 'с ' + fmtTs(x[1])) ])));

			const last = S.alerts && S.alerts.last && S.alerts.last[0];
			if (!S.alerts) T.wanMini.textContent = S.alerts === false ? 'история не собирается' : '–';
			else if (!last || S.alerts.now - last[0] > 90) T.wanMini.textContent = 'нет данных';
			else T.wanMini.textContent = (last[7] >= 0 ? nf0.format(last[7]) + ' мс' : 'нет ответа') + (last[6] >= 0 ? ' · шлюз ' + nf0.format(last[6]) + ' мс' : '');
		}

		function renderDevices() {
			const dv = S.devs;
			devNote.toggleAttribute('hidden', true);
			if (!dv) {
				devBody.replaceChildren(E('tr', {}, E('td', { colspan: 5, class: 'nfm-empty' }, dv === false ? MISSING : 'Собираю данные…')));
				T.devTotal.textContent = '';
				return;
			}
			const notes = [];
			if (dv.info && dv.info.acct === '0') notes.push('Учёт байтов в conntrack выключен, цифр не будет. Включите: sysctl -w net.netfilter.nf_conntrack_acct=1 (и добавьте net.netfilter.nf_conntrack_acct=1 в /etc/sysctl.conf).');
			if (dv.info && dv.info.offload === '1') notes.push('Включён flow offloading: ускоренные соединения не попадают в conntrack-учёт, поэтому цифры по устройствам могут быть занижены. Это ограничение способа подсчёта, настройки файрвола менять не нужно.');
			if (notes.length) { devNote.textContent = notes.join(' '); devNote.removeAttribute('hidden'); }

			/* conntrack prints IPv6 in full form, DHCP/NDP hints in short form: compare in one form */
			const norm = ip => {
				if (ip.indexOf(':') < 0) return ip;
				const halves = ip.toLowerCase().split('::');
				const a = halves[0] ? halves[0].split(':') : [], b = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
				const mid = halves.length > 1 ? new Array(Math.max(0, 8 - a.length - b.length)).fill('0') : [];
				return a.concat(mid, b).map(g => g.padStart(4, '0')).join(':');
			};
			const ipMac = {};
			for (const mac in hints)
				for (const ip of (hints[mac].ipaddrs || []).concat(hints[mac].ip6addrs || []))
					ipMac[norm(ip)] = mac;
			/* таблица соседей роутера (ip neigh): узнаём устройства без имени в DHCP и с временными адресами IPv6 */
			for (const [ ip, mac ] of dv.neigh || []) {
				const u = String(mac).toUpperCase();
				if (!ipMac[norm(ip)]) ipMac[norm(ip)] = u;
			}
			routerIps.learn(dv.info);

			const rows = {};
			const row = ip => {
				const mac = ipMac[norm(ip)], k = routerIps.has(ip) ? 'router' : mac || (ip.indexOf(':') >= 0 ? 'v6' : ip);
				return rows[k] || (rows[k] = { k, mac, ip, rd: 0, ru: 0, dd: 0, du: 0 });
			};
			const fresh = dv.now - dv.ts <= 60;
			if (fresh) for (const [ ip, d, u ] of dv.rate) { const r = row(ip); r.rd += d; r.ru += u; }
			for (const [ ip, d, u ] of dv[S.devDay] || []) { const r = row(ip); r.dd += d; r.du += u; if (!r.ip || r.ip.indexOf(':') >= 0) r.ip = ip; }

			const list = Object.values(rows).filter(r => r.rd + r.ru + r.dd + r.du > 0)
				.sort((a, b) => (b.dd + b.du) - (a.dd + a.du) || (b.rd + b.ru) - (a.rd + a.ru)).slice(0, 25);
			const mx = list.length ? Math.max(1, list[0].dd + list[0].du) : 1;
			let td = 0, tu = 0;
			for (const r of Object.values(rows)) { td += r.dd; tu += r.du; }
			T.devTotal.textContent = list.length ? `всего ↓ ${fmtBytes(td)} · ↑ ${fmtBytes(tu)}` : '';

			devBody.replaceChildren(...(list.length ? list.map(r => {
				const h = r.mac ? hints[r.mac] || {} : {};
				const id = r.mac && r.k !== 'router' && r.k !== 'v6' ? devId(r.mac, h.name) : null;
				const label = r.k === 'v6' ? 'Другие адреса IPv6' : r.k === 'router' ? 'Сам роутер (VPN, DNS, обновления)' : (h.name || names[r.ip] || (id && id.known ? (id.label || 'Устройство') : '') || r.ip);
				const sub = r.k === 'v6' || r.k === 'router' ? '' : ((h.ipaddrs || [])[0] || r.ip);
				return E('tr', {}, [
					E('td', { title: id ? (id.hint ? id.hint + '\n' : '') + r.mac : '' }, [ id ? devIcon(id) : '', label, sub && sub !== label ? E('span', { class: 'nfm-chip' }, sub) : '',
						id && id.vendor ? E('span', { class: 'nfm-chip' }, id.vendor) : '', id && id.priv ? E('span', { class: 'nfm-chip priv' }, 'частный MAC') : '',
						E('div', { class: 'nfm-bar nfm-bar-sm' }, E('div', { class: 'nfm-bar-fill c-down', style: `width:${100 * (r.dd + r.du) / mx}%` })) ]),
					E('td', { class: 'r' }, rateText(r.rd)), E('td', { class: 'r' }, rateText(r.ru)),
					E('td', { class: 'r' }, fmtBytes(r.dd)), E('td', { class: 'r' }, fmtBytes(r.du)) ]);
			}) : [ E('tr', {}, E('td', { colspan: 5, class: 'nfm-empty' }, 'Пока нет данных: учёт начинается после запуска сборщика, цифры накапливаются в течение дня.')) ]));
		}

		function renderDay() {
			const D = S.day;
			if (!D || !D.h || !D.h.info || !D.h.info.started) {
				dayBody.replaceChildren(E('div', { class: 'nfm-empty' }, D ? 'Сборщик истории не запущен — сводки нет.' : 'Загружаю…'));
				return;
			}
			const hwFlow = !!(D.h && D.h.info && D.h.info.flow_hw === '1');
			const mid = new Date().setHours(0, 0, 0, 0) / 1000;
			const rows = (D.h.rows || []).filter(r => r[0] >= mid);
			const col = i => rows.map(r => r[i]).filter(v => v != null && v >= 0);
			const max = a => a.length ? Math.max(...a) : null, avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
			const sum = (list, k) => (list || []).reduce((s, x) => s + (x[k] || 0), 0);
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
			for (const [ ip, d, u ] of (D.d && D.d.day) || []) { if (routerIps.has(ip)) selfB += d + u; else { cliD += d; cliU += u; } }
			let srcNote = 'Скачано и отдано: по счётчикам порта WAN.', swDev = false;
			const rtd = ((S.tr && S.tr.rows) || []).find(r => r[0] === (new Date().getFullYear() * 10000 + (new Date().getMonth() + 1) * 100 + new Date().getDate()) + '');
			if (rtd && rtd[3] === 1) {
				swDev = true;
				srcNote = 'Счётчики порта WAN показывают заметно меньше, чем прошло через устройства, поэтому все итоги по трафику (здесь, в календаре и в сравнении периодов) берутся по данным устройств.' + (hwFlow ? ' Причина: на роутере включено аппаратное ускорение пакетов (Сеть → Межсетевой экран), оно скрывает часть трафика от счётчиков порта.' : ' Вероятная причина: аппаратное ускорение пакетов (Сеть → Межсетевой экран) скрывает трафик от счётчиков порта.');
			}
			if (cliD + cliU > 1.5 * (dd + du) && cliD + cliU > 50e6) {
				dd = cliD; du = cliU; swDev = true;
				srcNote = 'Счётчики порта WAN показывают заметно меньше, чем прошло через устройства, поэтому «Скачано» и «Отдано» взяты по данным устройств.' + (hwFlow ? ' Причина: на роутере включено аппаратное ускорение пакетов (Сеть → Межсетевой экран), оно скрывает часть трафика от счётчиков порта.' : ' Вероятная причина: аппаратное ускорение пакетов (Сеть → Межсетевой экран) скрывает трафик от счётчиков порта.');
			}

			let drops = 0, down = 0;
			for (const e of D.h.events || []) {
				if (e[0] < mid) continue;
				const tx = String(e[2] || '');
				if (/Нет доступа в интернет/.test(tx) && !/Снова/.test(tx)) drops++;
				const m = /Снова в норме: Нет доступа в интернет.*длилось (?:(\d+) ч )?(?:(\d+) мин )?(?:(\d+) с)?/.exec(tx);
				if (m) down += (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
			}
			const dur = s => s >= 3600 ? Math.floor(s / 3600) + ' ч ' + Math.floor(s % 3600 / 60) + ' мин' : s >= 60 ? Math.floor(s / 60) + ' мин' : s + ' с';
			const pk = (a, f) => a == null ? '–' : f(a);
			const tile = (k, v, s) => E('div', { class: 'nfm-tile' }, [ k, E('b', {}, v), s ? E('span', { class: 'nfm-note-s' }, s) : '' ]);

			const top = {};
			for (const [ ip, d, u ] of (D.d && D.d.day) || []) if (!routerIps.has(ip)) top[ip] = (top[ip] || 0) + d + u;
			const list = Object.keys(top).map(ip => [ ip, top[ip] ]).sort((a, b) => b[1] - a[1]).slice(0, 3);
			const mx = list.length ? list[0][1] : 1;

			dayBody.replaceChildren(
				E('div', { class: 'nfm-tiles d4' }, [
					tile('Скачано', fmtBytes(dd), 'отдано ' + fmtBytes(du)),
					tile('Вчера всего', yd ? fmtBytes(yd) : '–', yd ? (ryDev ? 'по данным устройств' : swDev ? 'по счётчикам порта WAN' : 'сегодня ' + nf0.format(100 * (dd + du) / yd) + '% от вчера') : ''),
					tile('Обрывов интернета', String(drops), drops ? 'без связи ' + dur(down) : 'всё стабильно'),
					tile('Средний пинг', pk(avg(col(7)), v => nf0.format(v) + ' мс'), pk(max(col(7)), v => 'пик ' + nf0.format(v) + ' мс')),
					tile('Пик процессора', pk(max(col(1)), v => nf0.format(v) + '%'), pk(avg(col(1)), v => 'в среднем ' + nf0.format(v) + '%')),
					tile('Пик температуры', pk(max(col(3)), v => nf1.format(v) + ' °C'), pk(avg(col(3)), v => 'в среднем ' + nf1.format(v) + ' °C')),
					tile('Пик памяти', pk(max(col(2)), v => nf0.format(v) + '%'), pk(avg(col(2)), v => 'в среднем ' + nf0.format(v) + '%'))
				]),
				list.length ? E('div', { class: 'nfm-day-top' }, [ E('div', { class: 'nfm-k' }, 'Больше всего трафика сегодня') ].concat(list.map(([ ip, b ]) =>
					E('div', { class: 'nfm-host' }, [ E('span', {}, [ names[ip] || ip, names[ip] ? E('small', {}, ip) : '' ]), E('b', {}, fmtBytes(b)),
						E('div', { class: 'nfm-bar' }, E('div', { class: 'nfm-bar-fill c-down', style: `width:${100 * b / mx}%` })) ])))) : '',
				E('div', { class: 'nfm-note-s', style: 'margin-top:8px' }, srcNote + (selfB > 0 ? ' Собственный трафик роутера: ' + fmtBytes(selfB) + ' (обновления, DNS, замер скорости, прокси или VPN на роутере). В список устройств он не входит.' : '')));
		}

		function renderHist() {
			for (const k in rangeBtns) rangeBtns[k].classList.toggle('on', S.range === k);
			const h = S.hist, R = RANGES[S.range], win = R[1];
			const alive = !!(h && h.info && h.info.started);
			histNote.toggleAttribute('hidden', alive);
			if (!alive) histNote.textContent = h === false ? MISSING : 'Сборщик истории не запущен или ещё ничего не записал. Проверьте на роутере: /etc/init.d/nightfall-collector status; ls /tmp/nightfall';
			if (!h) { evBox.replaceChildren(E('div', { class: 'nfm-empty' }, h === false ? '' : 'Загружаю…')); return; }

			const end = h.now;
			const rows = (h.rows || []).filter(r => end - r[0] <= win);
			const col = i => rows.map(r => r[i] < 0 ? null : r[i]);
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
			T.pAvg.textContent = ok.length ? nf0.format(ok.reduce((a, b) => a + b, 0) / ok.length) + ' мс' : '–';
			T.pMax.textContent = ok.length ? nf0.format(vmax(ok)) + ' мс' : '–';
			const lossRows = rows.filter(r => r[8] >= 0);
			T.pLoss.textContent = lossRows.length ? nf1.format(lossRows.reduce((a, r) => a + r[8], 0) / lossRows.length) + '%' : '–';
			const evs = (h.events || []).filter(e => end - e[0] <= win);
			T.pCut.textContent = String(evs.filter(e => e[1] === 'crit' && /^Нет /.test(e[2])).length);

			const list = (h.events || []).slice().reverse().slice(0, 40);
			evBox.replaceChildren(...(list.length ? list.map(e => E('div', { class: 'nfm-ev-i ' + e[1] }, [ E('i'), E('time', {}, fmtTs(e[0])), E('span', {}, e[2]) ]))
				: [ E('div', { class: 'nfm-empty' }, 'Событий пока нет — это хорошо.') ]));

			const i = h.info || {};
			histInfo.textContent = rows.length < 3 ? 'Данных пока мало: сборщик накапливает точки, график заполнится через несколько минут. ' : '';
			histInfo.textContent += `Запись каждые ${i.step || 15} с, недельная история — по 5 минут, длинная (30 и 90 дней) — по 30 минут` + (+i.long_n > 0 ? ` (накоплено ${nf1.format(+i.long_n / 48)} сут из ${i.hist_days || 30})` : '') + '. ' +
				(i.persist === '1' ? 'История сохраняется между перезагрузками. ' : 'История хранится в памяти и обнуляется при перезагрузке роутера. ') +
				(i.limits ? 'Пороги: ' + i.limits + '. ' : '') + 'Настройки: /etc/nightfall-monitor.conf.';
		}


		/* ---------- что грузит канал ---------- */
		function ipLabel(ip) {
			for (const mac in hints) if ((hints[mac].ipaddrs || []).includes(ip) || (hints[mac].ip6addrs || []).includes(ip)) return hints[mac].name || ip;
			return names[ip] || ip;
		}

		function renderChannel() {
			const c = S.chan;
			if (!c) { chanBox.replaceChildren(E('div', { class: 'nfm-empty' }, c === false ? MISSING : 'Собираю данные…')); return; }
			const fresh = c.now - c.ts <= 60;
			const srcs = Array.from(new Set((c.svc || []).map(r => r[0])));
			const want = S.chanDev || '';
			chanSel.replaceChildren(E('option', { value: '' }, 'Все устройства'), ...srcs.map(ip => E('option', { value: ip }, ipLabel(ip))));
			chanSel.value = srcs.includes(want) ? want : '';
			if (!srcs.includes(want)) S.chanDev = '';
			if (!fresh) { chanBox.replaceChildren(E('div', { class: 'nfm-empty' }, 'Нет свежих данных. Нужен включённый учёт байтов в conntrack (см. подсказку выше) и работающий сборщик.')); return; }

			const sel = S.chanDev || '';
			const svc = {}, dst = {};
			for (const [ ip, proto, port, d, u ] of c.svc || []) {
				if (sel && ip !== sel) continue;
				const k = portLabel(proto, port), e = svc[k] || (svc[k] = { k, d: 0, u: 0 });
				e.d += +d; e.u += +u;
			}
			for (const [ ip, host, d, u ] of c.dst || []) {
				if (sel && ip !== sel) continue;
				const e = dst[host] || (dst[host] = { k: host, d: 0, u: 0 });
				e.d += +d; e.u += +u;
			}
			const list = (obj, what) => {
				const rows = Object.values(obj).filter(r => r.d + r.u > 0).sort((a, b) => (b.d + b.u) - (a.d + a.u)).slice(0, 8);
				const mx = rows.length ? rows[0].d + rows[0].u : 1;
				return E('div', {}, [ E('h4', {}, what), E('div', { class: 'nfm-lst' }, rows.length ? rows.map(r => E('div', { class: 'nfm-li' }, [
					E('span', { class: 'nm' }, r.k), E('span', { class: 'v' }, '↓ ' + rateText(r.d)), E('span', { class: 'v' }, '↑ ' + rateText(r.u)),
					E('div', { class: 'nfm-bar nfm-bar-sm bar' }, E('div', { class: 'nfm-bar-fill c-down', style: `width:${100 * (r.d + r.u) / mx}%` })) ]))
					: [ E('div', { class: 'nfm-empty' }, 'Сейчас нет заметного трафика') ]) ]);
			};
			chanBox.replaceChildren(list(svc, 'По службам и портам'), list(dst, 'По адресам в интернете'));
		}

		/* ---------- Wi-Fi клиент: сигнал в динамике ---------- */
		function wifiDialog(mac, label, c) {
			const body = E('div', { class: 'nfm nfm-wd' }, E('div', { class: 'nfm-empty' }, 'Загружаю историю сигнала…'));
			ui.showModal(label, [ body, E('div', { class: 'button-row' }, [ E('button', { class: 'btn', click: ui.hideModal }, 'Закрыть') ]) ]);
			callHistory([ 'wifi', mac.toLowerCase() ]).then(r => {
				if (!r) { body.replaceChildren(E('div', { class: 'nfm-hint' }, MISSING)); return; }
				const rows = (r.rows || []).filter(x => +x[0] > 0).sort((a, b) => a[0] - b[0]);
				if (rows.length < 2) {
					body.replaceChildren(E('div', { class: 'nfm-hint' }, 'История сигнала копится раз в минуту с момента запуска сборщика (она хранится только в памяти). Загляните сюда через несколько минут.' +
						((r.info && r.info.wifi_hist === '0') ? ' Сейчас запись истории Wi-Fi выключена в настройках (WIFI_HIST=0).' : '')));
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
				const tm = ts => new Date(ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
				const evs = (r.events || []).slice().reverse().slice(0, 12);
				const weak = vals.filter(v => v <= -75).length / vals.length * 100;
				body.replaceChildren(
					E('div', { class: 'nfm-note-s', style: 'margin-bottom:6px' }, `${mac.toUpperCase()}${c && c.ssid ? ' · ' + c.ssid : ''} · период ${tm(t0)} — ${tm(t1)} (${fmtDur(t1 - t0)})`),
					svg,
					E('div', { class: 'nfm-note-s', style: 'display:flex;justify-content:space-between;margin:2px 0 4px' }, [ E('span', {}, tm(t0)), E('span', {}, 'сейчас') ]),
					E('div', { class: 'nfm-note-s', style: 'margin-bottom:10px' }, 'Линии сетки: −40, −50 … −90 дБм сверху вниз. Выше −65 — хороший сигнал, ниже −75 — слабый.'),
					E('div', { class: 'nfm-tiles t4' }, [ [ 'сейчас', vals[vals.length - 1] + ' дБм' ], [ 'в среднем', nf0.format(avg) + ' дБм' ], [ 'лучший', Math.max(...vals) + ' дБм' ], [ 'худший', Math.min(...vals) + ' дБм' ] ]
						.map(([ l, v ]) => E('div', { class: 'nfm-tile' }, [ l, E('b', {}, v) ]))),
					E('div', { class: 'nfm-note-s', style: 'margin:10px 0' }, weak >= 20
						? `Слабый сигнал (−75 дБм и ниже) около ${nf0.format(weak)}% времени: поднесите устройство ближе к роутеру или подумайте о повторителе.`
						: 'Сигнал в основном уверенный.'),
					E('h4', { style: 'margin:10px 0 4px;font-size:12px;color:var(--nfm-dim)' }, 'Подключения и отключения'),
					E('div', { class: 'nfm-evlist', style: 'max-height:150px' }, evs.length ? evs.map(e => E('div', { class: 'nfm-ev-i ' + (e[2] === 'join' ? 'ok' : 'warn') }, [ E('i'), E('time', {}, fmtTs(e[0])), E('span', {}, e[2] === 'join' ? 'Подключилось' : 'Отключилось') ]))
						: [ E('div', { class: 'nfm-empty' }, 'Переподключений не было с момента запуска сборщика.') ]));
			});
		}

		/* ---------- журнал перезагрузок и обрывов ---------- */
		function renderJournal() {
			const j = S.jrn;
			if (!j) { jrnBox.replaceChildren(E('div', { class: 'nfm-empty' }, j === false ? MISSING : 'Загружаю…')); return; }
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
				E('span', {}, r[1] === 'outage' ? 'Обрыв связи: ' + r[3] : r[3]), E('b', {}, r[1] === 'outage' ? fmtDur(r[2]) : '') ]))
				: [ E('div', { class: 'nfm-empty' }, disabled ? 'Журнал выключен (JOURNAL=0 в настройках).' : 'Записей пока нет: журнал пополняется при обрывах связи (от двух неудачных проверок подряд) и перезагрузках роутера.') ]));
		}

		/* ---------- замер скорости ---------- */
		function startSpeed() {
			spdBtn.disabled = true; spdBtn.textContent = 'Идёт замер…';
			S.spdRun = true; S.spdT = Date.now(); S.at.spd = 0;
			fs.exec(SPEEDBIN, [ 'start' ]).catch(err => {
				S.spdRun = false;
				ui.addNotification(null, E('p', {}, 'Не удалось запустить замер: ' + (err.message || err)), 'danger');
			});
		}

		function renderSpeed() {
			const sp = S.spd;
			if (S.spdRun && Date.now() - (S.spdT || 0) > 60000) S.spdRun = false;   /* замер идёт не дольше ~15 с: дальше не ждём */
			const running = !!(sp && sp.running) || !!S.spdRun;
			spdBtn.disabled = running; spdBtn.textContent = running ? 'Идёт замер…' : 'Измерить сейчас';
			if (!sp) { spdList.replaceChildren(E('div', { class: 'nfm-empty' }, sp === false ? MISSING : 'Загружаю…')); return; }
			if (sp.info && sp.info.speed_hours != null && document.activeElement !== spdSel) spdSel.value = sp.info.speed_hours;
			if (S.cfg && S.cfg.values && document.activeElement !== spdSrc) { const u = S.cfg.values.SPEED_URL || SPEED_PRESETS[0][0]; spdSrc.value = SPEED_PRESETS.some(p => p[0] === u) ? u : ''; }
			const WEEK = 604800, all = (sp.rows || []).filter(r => r[5] === 'ok' && sp.now - r[0] <= WEEK);
			const ok = all.map(r => +r[1]);
			T.sLast.textContent = ok.length ? nf1.format(ok[ok.length - 1]) + ' Мбит/с' : '–';
			T.sAvg.textContent = ok.length ? nf1.format(ok.reduce((a, b) => a + b, 0) / ok.length) + ' Мбит/с' : '–';
			T.sMax.textContent = ok.length ? nf1.format(Math.max(...ok)) + ' Мбит/с' : '–';
			T.sMin.textContent = ok.length ? nf1.format(Math.min(...ok)) + ' Мбит/с' : '–';
			const mx = ok.length ? Math.max(...ok) : 10;
			spdChart.update(all.map(r => r[0]), { mbps: ok }, { left: niceCeil(Math.max(mx, 10)) }, { win: WEEK, end: sp.now, labels: xLabels(sp.now, WEEK) });
			const last = (sp.rows || []).slice(-8).reverse();
			spdList.replaceChildren(...(last.length ? last.map(r => E('div', { class: 'nfm-li' }, [
				E('span', { class: 'nm' }, [ fmtTs(r[0]), r[5] !== 'ok' ? E('small', {}, 'не удалось скачать файл') : (+r[4] > 300 ? E('small', {}, 'в это время шёл другой трафик') : '') ]),
				E('span', { class: 'v' }, r[5] === 'ok' ? nf1.format(+r[1]) + ' Мбит/с' : '–'), E('span', { class: 'v' }, r[5] === 'ok' ? fmtBytes(+r[2]) : '') ]))
				: [ E('div', { class: 'nfm-empty' }, 'Замеров ещё не было. Нажмите «Измерить сейчас».') ]));
			spdNote.textContent = 'Роутер скачивает тестовый файл в несколько потоков (каждый поток качает весь файл; по умолчанию 4, число меняется параметром SPEED_STREAMS в /etc/nightfall-monitor.conf) и считает скорость сам, без браузера. Это скорость загрузки до выбранного сервера; адрес меняется в настройках ниже. Если в это время идёт другой трафик, результат занижен.';
		}

		/* ---------- хранение истории и износ флеш-памяти ---------- */
		function renderFlash() {
			const i = (S.hist && S.hist.info) || (S.jrn && S.jrn.info) || (S.spd && S.spd.info) || null;
			if (!i) { flashBox.replaceChildren(E('div', { class: 'nfm-empty' }, 'Загружаю…')); return; }
			const hrs = +i.persist_hours || 6, kb = +i.persist_kb || 0;
			const rows = [
				[ 'Графики и события', 'в памяти роутера (/tmp), на флеш-память не пишутся' ],
				[ 'Журнал обрывов и перезагрузок', i.journal === '1' ? 'на флеш, одна короткая запись на событие, не больше 200 строк' : 'выключен' ],
				[ 'Сохранение между перезагрузками', i.persist === '1' ? `в ${i.persist_dir} раз в ${hrs} ч` + (kb ? `, до ${nf0.format(kb)} КБ за раз` : '') + ', неизменённые файлы пропускаются' : 'выключено, история обнуляется при перезагрузке' ]
			];
			const est = i.persist === '1' && kb ? kb * 24 / hrs : 0;
			flashBox.replaceChildren(
				...(i.persist_blocked === '1' ? [ E('div', { class: 'nfm-hint', style: 'border-color:#e5484d' }, [ E('b', { class: 'nfm-warn' }, 'Запись заблокирована. '),
					`Папка ${i.persist_dir} находится на встроенной флеш-памяти роутера, её нельзя изнашивать. Укажите папку на USB или SD-карте. Если это eMMC, SSD или SD-карта, которую можно писать, поставьте «Разрешить сохранение на встроенный накопитель» в 1.` ]) ] : []),
				E('div', { class: 'nfm-lst' }, rows.map(([ a, b ]) => E('div', {}, [ E('b', {}, a), E('div', { class: 'nfm-note-s' }, b) ]))),
				E('div', { class: 'nfm-note-s', style: 'margin-top:10px' }, est
					? `Оценка записи на накопитель: около ${nf0.format(est / 1024 > 1 ? est / 1024 : est)} ${est / 1024 > 1 ? 'МБ' : 'КБ'} в сутки.`
					: 'Запись на накопитель не ведётся, износ флеш-памяти минимален. Чтобы переживать перезагрузки, укажите папку на USB/SD в настройках ниже.'));
		}

		/* ---------- состояние служб ---------- */
		function svcAction(name, action, label, danger) {
			const run = () => {
				ui.showModal(null, [ E('p', { class: 'spinning' }, label + '…') ]);
				callInitAction(name, action).then(() => window.setTimeout(() => { ui.hideModal(); S.at.svc = 0; tick(); }, 1500))
					.catch(err => { ui.hideModal(); ui.addNotification(null, E('p', {}, `Не удалось (${name}: ${action}): ` + (err.message || err)), 'danger'); });
			};
			if (!danger) return run();
			ui.showModal(`${label}?`, [ E('p', {}, `Служба «${name}» важна для работы роутера. Соединение с панелью может прерваться на несколько секунд.`),
				E('div', { class: 'button-row' }, [ E('button', { class: 'btn', click: ui.hideModal }, 'Отмена'), E('button', { class: 'btn cbi-button-negative important', click: () => { ui.hideModal(); run(); } }, 'Выполнить') ]) ]);
		}

		function renderServices() {
			const sv = S.svc;
			if (!sv || !sv.init) { svcBox.replaceChildren(E('div', { class: 'nfm-empty' }, sv ? 'Список служб недоступен: нет прав или не поддерживается этой версией LuCI.' : 'Загружаю…')); svcMore.replaceChildren(); return; }
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
				const state = x.known ? (x.up ? 'работает' : (x.en ? 'не работает, хотя включена' : 'остановлена')) : (x.en ? 'включена при загрузке' : 'выключена');
				return E('div', { class: 'nfm-svc ' + st }, [ E('i', { class: 'st' }),
					E('div', {}, [ E('div', { class: 'nm' }, x.n), E('div', { class: 'ds' }, [ SVC_INFO[x.n] ? SVC_INFO[x.n] + ' · ' : '', state, x.known && x.en ? ' · автозапуск включён' : (x.known ? ' · автозапуск выключен' : '') ]) ]),
					E('div', { class: 'ac' }, [
						E('button', { class: 'nfm-mini', click: () => svcAction(x.n, 'restart', 'Перезапустить ' + x.n, prot) }, 'Перезапустить'),
						x.up ? E('button', { class: 'nfm-mini', disabled: prot, title: prot ? 'Ключевая служба: остановка отсюда отключена' : '', click: () => svcAction(x.n, 'stop', 'Остановить ' + x.n) }, 'Остановить')
							: E('button', { class: 'nfm-mini', click: () => svcAction(x.n, 'start', 'Запустить ' + x.n) }, 'Запустить'),
						E('button', { class: 'nfm-mini', disabled: prot && x.en, title: prot && x.en ? 'Ключевая служба: автозапуск менять нельзя' : '', click: () => svcAction(x.n, x.en ? 'disable' : 'enable', (x.en ? 'Отключить автозапуск ' : 'Включить автозапуск ') + x.n) }, x.en ? 'Автозапуск: вкл' : 'Автозапуск: выкл') ]) ]);
			};
			svcBox.replaceChildren(...(proc.length ? proc.map(row) : [ E('div', { class: 'nfm-empty' }, q ? 'Ничего не найдено' : 'Работающих служб не найдено') ]));
			svcMore.replaceChildren(other.length ? E('details', { class: 'nfm-card' }, [ E('summary', { style: 'cursor:pointer;font-weight:600;font-size:14px' }, `Скрипты без отдельного процесса (${other.length})`),
				E('div', { style: 'margin-top:8px' }, other.map(row)) ]) : '');
		}

		/* ---------- logic ---------- */
		function setPaused(p) {
			S.paused = p;
			pauseBtn.textContent = p ? 'Продолжить' : 'Пауза';
			pill.classList.toggle('paused', p);
			pill.textContent = p ? 'приостановлено' : `обновляется каждые ${INTERVAL} с`;
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
			const kind = /^br-|^lan/.test(n) ? 'LAN-мост' : /^(wlan|phy)/.test(n) ? 'Wi-Fi' : null;
			return [ n, r ? r.toUpperCase() : kind ];
		}

		function refresh() {
			const d = S.last;
			for (const k in tabBtns) {
				tabBtns[k].classList.toggle('on', S.tab === k);
				tabBtns[k].setAttribute('aria-selected', S.tab === k);
			}
			show(overview, S.tab === 'overview'); show(net, S.tab === 'net'); show(procs, S.tab === 'procs'); show(svcs, S.tab === 'svcs'); show(hist, S.tab === 'hist');
			if (!d) return;

			T.uptime.textContent = fmtUptime(d.up);

			/* cards */
			const cn = d.cpu.length - 1;
			const c = S.cpuNow;
			rCpu.set(c ? c.pct : 0, c ? nf0.format(c.pct) + '%' : '–');
			T.cpuCores.textContent = `${cn} ${cn === 1 ? 'ядро' : (cn < 5 ? 'ядра' : 'ядер')}`;
			T.cpuLoad.textContent = 'нагрузка ' + d.load.map(v => nf2.format(v)).join(' · ');

			const tp = S.temps;
			if (tp.main != null) {
				const cls = tp.main >= 85 ? 'hot' : tp.main >= 70 ? 'warn' : '';
				rTemp.set(tp.main, nf0.format(tp.main) + '°');
				rTemp.el.querySelector('.nfm-ring-fg').setAttribute('class', 'nfm-ring-fg c-temp ' + cls);
				T.tempMain.textContent = 'процессор ' + fmtTemp(tp.main);
				T.tempSub.textContent = tp.wifi.length ? 'Wi-Fi ' + tp.wifi.map(v => nf0.format(v) + '°').join(' / ') : 'датчики Wi-Fi не найдены';
			} else {
				rTemp.set(0, '–');
				T.tempMain.textContent = 'нет датчика';
				T.tempSub.textContent = 'система не сообщает температуру';
			}

			const m = d.mem, used = m.total - m.avail;
			rMem.set(100 * used / m.total, nf0.format(100 * used / m.total) + '%');
			T.memMain.textContent = `${fmtMB(used)} из ${fmtMB(m.total)}`;
			T.memSub.textContent = `кеш ${fmtMB(m.cached + m.buffers)} · /tmp ${d.tmp ? fmtMB(d.tmp[1]) : '–'}`;

			if (d.flash) {
				rFlash.set(100 * d.flash[1] / d.flash[0], nf0.format(100 * d.flash[1] / d.flash[0]) + '%');
				T.flashMain.textContent = `${fmtMB(d.flash[1])} из ${fmtMB(d.flash[0])}`;
				T.flashSub.textContent = `свободно ${fmtMB(d.flash[0] - d.flash[1])}`;
			}

			/* charts */
			const dataMain = { cpu: S.cpu, mem: S.mem, temp: S.temp };
			mainChart.update(S.times, dataMain, seriesMax());

			/* cores */
			while (coreRefs.length < S.cores.length) {
				const i = coreRefs.length;
				const fill = E('div', { class: 'nfm-bar-fill c-cpu' }), val = E('b', {}, '–');
				coresBox.appendChild(E('div', { class: 'nfm-core' }, [
					E('div', { class: 'nfm-core-h' }, [ E('span', {}, `Ядро ${i + 1}`), val ]), E('div', { class: 'nfm-bar' }, fill) ]));
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
			T.ctMini.textContent = `${nf0.format(d.ct[0])}${d.ct[1] ? ' из ' + nf0.format(d.ct[1]) : ''}`;

			if (S.tab === 'net') {
				T.nDlN.textContent = dr[0]; T.nDlU.textContent = dr[1]; T.nUlN.textContent = ur[0]; T.nUlU.textContent = ur[1];
				T.nDlTot.textContent = cur ? fmtBytes(cur[1]) : '–'; T.nUlTot.textContent = cur ? fmtBytes(cur[5]) : '–';
				T.ctN.textContent = nf0.format(d.ct[0]); T.ctMax.textContent = d.ct[1] ? 'из ' + nf0.format(d.ct[1]) : '';
				T.ctBar.style.width = d.ct[1] ? Math.min(100, 100 * d.ct[0] / d.ct[1]) + '%' : '0';
				const pr = S.full ? S.full.ctp : null;
				T.ctProto.textContent = pr ? `TCP ${nf0.format(pr[0])} · UDP ${nf0.format(pr[1])} · прочие ${nf0.format(pr[2])}` : 'подробности недоступны';

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
						: [ E('div', { class: 'nfm-empty' }, 'Активных соединений нет') ]));
				} else {
					hostsBox.replaceChildren(E('div', { class: 'nfm-empty' }, S.full ? 'Таблица соединений недоступна (нужен nf_conntrack).' : 'Собираю данные…'));
				}
			}

			renderAlerts();
			if (S.tab === 'net') { renderDevices(); renderChannel(); }
			if (S.tab === 'svcs') renderServices();
			if (S.tab === 'hist') { renderHist(); renderDay(); renderHeat(); renderWeek(); renderCmp(); renderMon(); renderWq(); renderWHeat(); renderAir(); renderJournal(); renderSpeed(); renderFlash(); }

			/* overheating banner */
			const hot = hotInfo();
			hotBox.toggleAttribute('hidden', !hot || tempAlertOn());
			if (hot) {
				hotBox.classList.toggle('danger', hot.crit);
				hotBox.classList.toggle('warning', !hot.crit);
				hotBox.firstChild.textContent = hot.crit ? 'Критический перегрев процессора' : 'Процессор перегрет';
				hotBox.lastChild.textContent = `Температура ${fmtTemp(hot.temp)} держится выше ${HOT_WARN} °C уже более ${Math.max(1, Math.round(hot.dur / 60))} мин. Проверьте вентиляцию и не накрывайте роутер.`;
			}

			/* wifi clients */
			T.wifiMini.textContent = S.wifi ? nf0.format(S.wifi.length) : '–';
			if (S.tab === 'net') {
				const rows = (S.wifi || []).slice().sort((a, b) => (b.signal || -999) - (a.signal || -999)).map(c => {
					const mac = (c.mac || '').toUpperCase(), h = hints[mac] || hints[mac.toLowerCase()] || {};
					const lvl = c.signal >= -55 ? 4 : c.signal >= -65 ? 3 : c.signal >= -75 ? 2 : 1;
					const link = x => x && x.rate ? nf0.format(x.rate / 1000) + '\u00a0Мбит/с' : '–';
					return E('tr', { class: 'nfm-click', title: 'Показать сигнал в динамике', click: () => wifiDialog(mac, h.name || (h.ipaddrs || [])[0] || mac, c) }, [
						E('td', {}, [ h.name || (h.ipaddrs || [])[0] || mac, h.name ? E('span', { class: 'nfm-chip' }, mac) : '' ]),
						E('td', {}, [ c.ssid, c.band ? E('span', { class: 'nfm-chip' }, BANDS[c.band] || c.band) : '' ]),
						E('td', {}, [ E('span', { class: 'nfm-sig' + (lvl <= 2 ? ' weak' : '') }, [ 1, 2, 3, 4 ].map(n => E('i', { class: n <= lvl ? 'on' : '' }))), `${c.signal} дБм` ]),
						E('td', { class: 'r' }, link(c.tx)), E('td', { class: 'r' }, link(c.rx)),
						E('td', { class: 'r' }, c.connected_time != null ? fmtDur(c.connected_time) : '–') ]);
				});
				wifiBody.replaceChildren(...(rows.length ? rows : [ E('tr', {}, E('td', { colspan: 6, class: 'nfm-empty' },
					S.wifi ? 'Подключённых Wi-Fi клиентов нет' : 'Данные о Wi-Fi недоступны' + (wifiErr ? ' (' + wifiErr + ')' : ''))) ]));
			}

			/* memory by program */
			if (S.full) {
				const f = S.full, g = groupedProcs().sort((a, b) => b.rss - a.rss);
				const top = g.slice(0, 6), rest = g.slice(6);
				const restRss = rest.reduce((s, e) => s + e.rss, 0);
				const sumRss = g.reduce((s, e) => s + e.rss, 0);
				const kernel = Math.max(0, f.mem.total - f.mem.free - sumRss);
				const items = top.map(e => ({ label: e.label, cls: e.cls, kb: e.rss }));
				if (restRss > 0) items.push({ label: 'Остальные программы', cls: 'gx', kb: restRss });
				items.push({ label: 'Ядро, буферы и /tmp', cls: 'hatch', kb: kernel });
				items.push({ label: 'Свободно', cls: 'free', kb: f.mem.free });
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
				if (!d) throw new Error(res.stderr || 'нет данных');
				ingest(d);
				if (!S.paused && pill.classList.contains('paused')) pill.classList.remove('paused');
				if (!S.paused) pill.textContent = `обновляется каждые ${INTERVAL} с`;
				refresh();
			}).catch(err => {
				pill.textContent = 'нет данных: ' + (err.message || err);
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
