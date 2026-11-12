'use strict';
'require baseclass';
'require fs';
'require rpc';
'require nightfall-qr as NfQr';

/*
 * Nightfall: Status → Overview extras.
 *  - a strip of live tiles with mini graphs (internet, WAN speed, CPU, temperature, memory);
 *  - cards sorted by priority, can be dragged (or moved with ↑ ↓ on the grip) and remembered per browser;
 *  - coloured status badges for Wi-Fi signal and port link state.
 * Data comes from /usr/libexec/nightfall-stats and /usr/libexec/nightfall-history (Nightfall monitor package).
 */

const STATS = '/usr/libexec/nightfall-stats';
const HIST = '/usr/libexec/nightfall-history';
const APPSBIN = '/usr/libexec/nightfall-apps';
const ORDER_KEY = 'nightfall-overview-order-v1';
const SIZE_KEY = 'nightfall-overview-size-v1';
const HEIGHT_KEY = 'nightfall-overview-h-v1';
const WIN = 600;            /* seconds shown in mini graphs */
const EVERY = 3000;         /* ms between samples */
const ALERTS_EVERY = 5;     /* ping / alerts every N samples */

const callIfaces = rpc.declare({ object: 'network.interface', method: 'dump' });
const callHints = rpc.declare({ object: 'luci-rpc', method: 'getHostHints', expect: { '': {} } });
const callWireless = rpc.declare({ object: 'network.wireless', method: 'status', expect: { '': {} } });
const callIwDevs = rpc.declare({ object: 'iwinfo', method: 'devices', expect: { devices: [] } });
const callIwInfo = rpc.declare({ object: 'iwinfo', method: 'info', params: [ 'device' ] });
const callAssoc = rpc.declare({ object: 'iwinfo', method: 'assoclist', params: [ 'device' ], expect: { results: [] } });
const callUci = rpc.declare({ object: 'uci', method: 'get', params: [ 'config' ], expect: { values: {} } });
const callReboot = rpc.declare({ object: 'system', method: 'reboot' });

/* shared live numbers (filled by the live strip, read by the health card) */
const SHARED = { t: null, cpu: null, mem: null, temp: null, online: null, ping: null, loss: null };
let DRAG = false;           /* true while a card is being dragged: the DOM observer must not re-sort */

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

/* card priority: lower goes first; unknown cards keep their order after the known ones */
const PRIORITY = [
	/Интернет|Internet/i, /^(Сеть|Network)$/i, /порт|Port/i, /Беспровод|Wireless|Wi-?Fi/i, /Топ клиентов/i, /Трафик по приложениям/i, /Доступ в интернет/,
	/Состояние роутера/, /сейчас$/, /Лента событий/, /Быстрые действия/,
	/^(Система|System)$/i, /Температур|Temperature/i, /Память|Memory/i, /Хранилищ|Storage/i, /DHCP|Аренд/i, /DSL/i
];

function fmtRate(bps) {
	const bits = bps * 8;
	if (bits >= 1e9) return [ nf2.format(bits / 1e9), 'Гбит/с' ];
	if (bits >= 1e6) return [ (bits >= 1e8 ? nf0 : nf1).format(bits / 1e6), 'Мбит/с' ];
	if (bits >= 1e3) return [ nf0.format(bits / 1e3), 'Кбит/с' ];
	return [ nf0.format(bits), 'бит/с' ];
}

function niceCeil(v) {
	if (v <= 0) return 1;
	const p = Math.pow(10, Math.floor(Math.log10(v)));
	for (const m of [ 1, 2, 2.5, 5, 10 ])
		if (v <= m * p) return m * p;
	return 10 * p;
}

function SVG(tag, attrs, children) {
	const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const k in attrs || {})
		el.setAttribute(k, attrs[k]);
	for (const c of [].concat(children || []))
		if (c != null) el.appendChild(c);
	return el;
}


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

/* time based mini graph; classes[i] is the colour class of series i */
let sparkSeq = 0;
function spark(classes) {
	const W = 100, H = 34;
	const uid = 'nfg' + (++sparkSeq) + '_';
	/* заливка под линией — плавный градиент от линии вниз, без сплошного прямоугольника */
	const grads = classes.map((c, i) => SVG('linearGradient', { id: uid + i, x1: 0, y1: 0, x2: 0, y2: 1, class: c }, [
		SVG('stop', { offset: 0, 'stop-color': 'currentColor', 'stop-opacity': .26 }),
		SVG('stop', { offset: .55, 'stop-color': 'currentColor', 'stop-opacity': 0 }),
		SVG('stop', { offset: 1, 'stop-color': 'currentColor', 'stop-opacity': 0 })
	]));
	const parts = classes.map((c, i) => ({
		area: SVG('path', { class: 'a ' + c, style: `fill:url(#${uid + i});opacity:1` }),
		line: SVG('path', { class: 'l ' + c, pathLength: 1 }),
		glint: SVG('path', { class: 's ' + c })
	}));
	const el = SVG('svg', { class: 'nf-spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' },
		[ SVG('defs', {}, grads) ].concat(parts.reduce((a, p) => a.concat([ p.area, p.line, p.glint ]), [])));

	return {
		el,
		update(times, arrays, max, min) {
			const now = times.length ? times[times.length - 1] : 0, lo = min || 0, span = (max - lo) || 1;
			parts.forEach((p, i) => {
				const vals = arrays[i] || [];
				const pts = [];
				for (let k = 0; k < times.length; k++) {
					if (vals[k] == null || now - times[k] > WIN) continue;
					pts.push([ W - (now - times[k]) / WIN * W, H - 2 - Math.max(0, Math.min(1, (vals[k] - lo) / span)) * (H - 4) ]);
				}
				const pl = nfPlot([ pts ], H);
				p.line.setAttribute('d', pl.line);
				p.glint.setAttribute('d', pl.line);
				p.area.setAttribute('d', classes.length === 1 ? pl.area : '');
			});
		}
	};
}

function badge(kind, text) {
	return E('span', { class: 'nf-badge ' + kind }, text);
}

/* ---------- tile details: a dialog with a longer history chart ---------- */

const DETAIL = {
	net: { title: 'Интернет', cols: [ [ 7, 'Интернет', 'nf-c-down' ], [ 6, 'До шлюза', 'nf-c-up' ] ], fmt: v => nf0.format(v) + ' мс', ceil: v => niceCeil(Math.max(20, v)) },
	wan: { title: 'Трафик WAN', cols: [ [ 4, 'Загрузка', 'nf-c-down' ], [ 5, 'Отдача', 'nf-c-up' ] ], fmt: v => fmtRate(v).join(' '), ceil: v => niceCeil(Math.max(12500, v)) },
	cpu: { title: 'Процессор', cols: [ [ 1, 'Загрузка', 'nf-c-cpu' ] ], fmt: v => nf0.format(v) + '%', ceil: () => 100 },
	temp: { title: 'Температура', cols: [ [ 3, 'Процессор', 'nf-c-temp' ] ], fmt: v => nf1.format(v) + ' °C', ceil: v => Math.max(100, niceCeil(v)), floor: 30 },
	mem: { title: 'Память', cols: [ [ 2, 'Занято', 'nf-c-mem' ] ], fmt: v => nf0.format(v) + '%', ceil: () => 100 },
	ct: { title: 'Соединения', cols: [ [ 9, 'Соединений', 'nf-c-mem' ] ], fmt: v => nf0.format(v), ceil: v => niceCeil(Math.max(50, v)) },
	loss: { title: 'Потери пакетов', icon: 'net', cols: [ [ 8, 'Потери', 'nf-c-temp' ] ], fmt: v => nf1.format(v) + '%', ceil: v => niceCeil(Math.max(5, v)) },
	/* сигнал Wi‑Fi: средний и худший по всем клиентам; за час, сутки и неделю из «wifi», за месяц и больше из почасовых «wifi-hr» */
	sig: { title: 'Сигнал Wi‑Fi', icon: 'wifi', neg: true, cols: [ [ 1, 'Средний', 'nf-c-down' ], [ 2, 'Худший', 'nf-c-up' ] ], fmt: v => nf0.format(v) + ' дБм', ceil: () => -30, floor: -95,
		load: range => fs.exec(HIST, [ range === 'm' || range === 'q' ? 'wifi-hr' : 'wifi' ]).then(res => {
			const h = JSON.parse(res.stdout), step = range === 'm' || range === 'q' ? 3600 : 60, g = new Map();
			for (const r of h.rows || []) {
				const v = +r[2]; if (!isFinite(v) || v >= 0 || v < -120) continue;
				const t = Math.round(r[0] / step) * step, e = g.get(t) || [ 0, 0, 0 ];
				e[0] += v; e[1]++; e[2] = e[1] === 1 ? v : Math.min(e[2], v); g.set(t, e);
			}
			return { now: h.now, info: h.info, rows: Array.from(g.entries()).sort((a, b) => a[0] - b[0]).map(([ t, e ]) => [ t, e[0] / e[1], e[2] ]) };
		})
	}
};
const INFO = { up: 1, cli: 1, day: 1, stor: 1 };
const DRANGE = { h: [ 'fine', 3600, 'Час' ], d: [ 'coarse', 86400, 'Сутки' ], w: [ 'coarse', 604800, 'Неделя' ], m: [ 'long', 2592000, 'Месяц' ], q: [ 'long', 7776000, '3 мес.' ] };

function openDetail(key, from) {
	if (INFO[key] && !document.querySelector('.nf-dlg-bg')) return openInfo(key, from);
	const cfg = DETAIL[key];
	if (!cfg || document.querySelector('.nf-dlg-bg')) return;
	const two = v => String(v).padStart(2, '0');
	const clock = (ts, long) => { const d = new Date(ts * 1000); return (long ? two(d.getDate()) + '.' + two(d.getMonth() + 1) + ' ' : '') + two(d.getHours()) + ':' + two(d.getMinutes()); };
	let range = 'h', data = null;

	const W = 600, H = 220;
	const svg = SVG('svg', { class: 'nf-dchart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
	const xl = E('div', { class: 'nf-dx' });
	const tip = E('div', { class: 'nf-dtip', hidden: '' });
	const wrap = E('div', { class: 'nf-dplot' }, [ svg, tip ]);
	const stats = E('div', { class: 'nf-dstats' });
	const note = E('div', { class: 'nf-dnote' });
	const tabs = {};
	const seg = E('div', { class: 'nf-dseg', role: 'tablist' }, Object.keys(DRANGE).map(k =>
		tabs[k] = E('button', { type: 'button', click: () => { range = k; load(); } }, DRANGE[k][2])));
	const legend = E('div', { class: 'nf-dleg' }, cfg.cols.map(x => E('span', {}, [ E('i', { class: x[2] }), x[1] ])));

	const bg = E('div', { class: 'nf-dlg-bg' });
	const close = () => { document.removeEventListener('keydown', onKey); bg.classList.remove('on'); window.setTimeout(() => { bg.remove(); if (from && from.focus) from.focus(); }, 200); };
	const onKey = ev => { if (ev.key === 'Escape') close(); };
	const dlg = E('div', { class: 'nf-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': cfg.title }, [
		E('div', { class: 'nf-dlg-h' }, [ E('h4', {}, [ E('i', { class: 'nf-ci', 'data-i': cfg.icon || (key === 'wan' || key === 'net' ? 'net' : key === 'cpu' ? 'system' : key) }), cfg.title ]), seg,
			E('button', { type: 'button', class: 'nf-dlg-x', 'aria-label': 'Закрыть', click: close }, '×') ]),
		stats, legend, wrap, xl, note ]);
	bg.appendChild(dlg);
	bg.addEventListener('mousedown', ev => { if (ev.target === bg) close(); });
	document.addEventListener('keydown', onKey);
	document.body.appendChild(bg);
	window.requestAnimationFrame(() => bg.classList.add('on'));
	const closeBtn = dlg.querySelector('.nf-dlg-x'); closeBtn.focus();

	function draw() {
		const R = DRANGE[range];
		Object.keys(tabs).forEach(k => tabs[k].setAttribute('aria-pressed', String(k === range)));
		svg.replaceChildren(); xl.replaceChildren(); tip.hidden = true;
		if (!data || !data.rows) { note.textContent = data === false ? 'Сборщик истории не запущен: графика нет.' : 'Загружаю…'; stats.replaceChildren(); return; }
		const end = data.now, win = R[1];
		const rows = data.rows.filter(r => end - r[0] <= win);
		if (rows.length < 2) { note.textContent = 'Пока мало данных за этот период.'; stats.replaceChildren(); return; }
		note.textContent = '';
		const series = cfg.cols.map(x => rows.map(r => r[x[0]] != null && (cfg.neg ? isFinite(r[x[0]]) : r[x[0]] >= 0) ? r[x[0]] : null));
		const all = [].concat(...series).filter(v => v != null);
		const hi = cfg.ceil(all.length ? Math.max(...all) : 1), lo = cfg.floor || 0, span = (hi - lo) || 1;
		const t0 = end - win;
		const X = t => (t - t0) / win * W, Y = v => H - 4 - Math.max(0, Math.min(1, (v - lo) / span)) * (H - 10);
		for (let i = 0; i <= 4; i++) svg.appendChild(SVG('line', { class: 'g', x1: 0, x2: W, y1: Y(lo + span * i / 4), y2: Y(lo + span * i / 4) }));
		series.forEach((vals, si) => {
			let d = '', ad = '', fx = 0, lx = 0, open = false;
			rows.forEach((r, k) => {
				const v = vals[k];
				if (v == null) { open = false; return; }
				const x = X(r[0]).toFixed(1), y = Y(v).toFixed(1);
				d += (open ? 'L' : 'M') + x + ' ' + y;
				if (!open) fx = x;
				lx = x; open = true;
			});
			if (cfg.cols.length === 1 && d) ad = d + 'L' + lx + ' ' + H + 'L' + fx + ' ' + H + 'Z';
			if (ad) svg.appendChild(SVG('path', { class: 'a ' + cfg.cols[si][2], d: ad }));
			svg.appendChild(SVG('path', { class: 'l ' + cfg.cols[si][2], d, pathLength: 1 }));
		});
		const cur = SVG('line', { class: 'cur', y1: 0, y2: H, x1: 0, x2: 0, visibility: 'hidden' });
		svg.appendChild(cur);
		for (const f of [ 0, .25, .5, .75, 1 ]) xl.appendChild(E('span', {}, clock(t0 + win * f, range !== 'h' && win > 86400 * 1.5)));

		const st = cfg.cols.map((x, si) => {
			const v = series[si].filter(q => q != null);
			return v.length ? [ x[1], v[v.length - 1], Math.min(...v), v.reduce((s, q) => s + q, 0) / v.length, Math.max(...v) ] : null;
		}).filter(Boolean);
		const loss = key === 'net' ? rows.map(r => r[8]).filter(v => v != null && v >= 0) : [];
		const cells = [].concat(...st.map(s => [ [ s[0] + (st.length > 1 ? ' · сейчас' : ': сейчас'), s[1] ], [ st.length > 1 ? s[0] + ' · мин' : 'мин', s[2] ], [ st.length > 1 ? s[0] + ' · средн.' : 'средн.', s[3] ], [ st.length > 1 ? s[0] + ' · макс' : 'макс', s[4] ] ]
			.map(x => E('div', { class: 'nf-ds' }, [ E('span', {}, x[0]), E('b', {}, cfg.fmt(x[1])) ]))));
		if (loss.length) cells.push(E('div', { class: 'nf-ds' }, [ E('span', {}, 'потери в среднем'), E('b', {}, nf1.format(loss.reduce((s, q) => s + q, 0) / loss.length) + '%') ]));
		stats.replaceChildren(...cells);

		const move = ev => {
			const r = wrap.getBoundingClientRect(), f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), t = t0 + f * win;
			let bi = 0, bd = 1e12;
			rows.forEach((q, k) => { const dd = Math.abs(q[0] - t); if (dd < bd) { bd = dd; bi = k; } });
			const x = X(rows[bi][0]);
			cur.setAttribute('x1', x); cur.setAttribute('x2', x); cur.setAttribute('visibility', 'visible');
			tip.replaceChildren(E('span', {}, clock(rows[bi][0], win > 86400)), ...cfg.cols.map((cc, si) => E('div', {}, [ E('i', { class: cc[2] }), cc[1] + ' ', E('b', {}, series[si][bi] != null ? cfg.fmt(series[si][bi]) : '–') ])));
			tip.hidden = false;
			const px = x / W * r.width;
			tip.style.left = Math.min(r.width - tip.offsetWidth - 4, Math.max(4, px + 12)) + 'px';
		};
		wrap.onpointermove = move;
		wrap.onpointerleave = () => { cur.setAttribute('visibility', 'hidden'); tip.hidden = true; };
	}

	function load() {
		draw();
		const src = cfg.load ? cfg.load(range) : fs.exec(HIST, [ 'series', DRANGE[range][0] ]).then(res => JSON.parse(res.stdout));
		src.then(d => { data = d; if (data && data.info && !data.info.started) data = false; draw(); }).catch(() => { data = false; draw(); });
	}
	load();
}

/* ---------- окна без графика: аптайм, Wi‑Fi клиенты, трафик за сутки, хранилище ---------- */
function openInfo(key, from) {
	const T = { up: [ 'Аптайм и перезагрузки', 'system' ], cli: [ 'Wi‑Fi клиенты', 'wifi' ], day: [ 'Трафик за сутки', 'net' ], stor: [ 'Хранилище', 'system' ] }[key];
	const body = E('div', { class: 'nf-info' }, E('div', { class: 'nf-empty' }, 'Загружаю…'));
	const bg = E('div', { class: 'nf-dlg-bg' });
	const onKey = ev => { if (ev.key === 'Escape') close(); };
	const close = () => { document.removeEventListener('keydown', onKey); bg.classList.remove('on'); window.setTimeout(() => { bg.remove(); if (from && from.focus) from.focus(); }, 200); };
	bg.appendChild(E('div', { class: 'nf-dlg nf-dlg-info', role: 'dialog', 'aria-modal': 'true', 'aria-label': T[0] }, [
		E('div', { class: 'nf-dlg-h' }, [ E('h4', {}, [ E('i', { class: 'nf-ci', 'data-i': T[1] }), T[0] ]), E('button', { type: 'button', class: 'nf-dlg-x', 'aria-label': 'Закрыть', click: close }, '×') ]),
		body ]));
	bg.addEventListener('mousedown', ev => { if (ev.target === bg) close(); });
	document.addEventListener('keydown', onKey);
	document.body.appendChild(bg);
	window.requestAnimationFrame(() => bg.classList.add('on'));
	bg.querySelector('.nf-dlg-x').focus();
	const two = v => String(v).padStart(2, '0');
	const when = ts => { const d = new Date(ts * 1000); return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + two(d.getHours()) + ':' + two(d.getMinutes()); };
	const row = (a, b, bar) => E('div', { class: 'nf-info-row' }, [ E('span', {}, a), bar != null ? E('span', { class: 'nf-info-bar' }, E('i', { class: bar > 90 ? 'low' : bar > 75 ? 'mid' : '', style: 'width:' + Math.max(2, Math.min(100, bar)) + '%' })) : '', E('b', {}, b) ]);
	const head = t => E('div', { class: 'nf-info-h' }, t);
	const fill = (...n) => body.replaceChildren(...n.flat().filter(Boolean));
	const dur = sec => { const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60); return (d ? d + ' д ' : '') + (d || h ? h + ' ч ' : '') + m + ' мин'; };
	const J = f => fs.exec(HIST, f).then(r => JSON.parse(r.stdout)).catch(() => null);

	if (key === 'up') {
		Promise.all([ fs.exec(STATS, []).then(r => JSON.parse(r.stdout)).catch(() => null), J([ 'journal' ]) ]).then(([ d, j ]) => {
			if (!d) { fill(E('div', { class: 'nf-empty' }, 'Нет данных.')); return; }
			const boots = ((j && j.rows) || []).filter(r => r[1] === 'boot').sort((a, b) => b[0] - a[0]).slice(0, 8);
			fill(row('Работает без перезагрузки', dur(d.up)), row('Включён', when(Date.now() / 1000 - d.up)),
				row('Нагрузка за 1 / 5 / 15 минут', d.load.map(v => nf2.format(v)).join(' · ')),
				head('Последние перезагрузки'),
				boots.length ? boots.map(r => row(when(r[0]), 'перезагрузка')) : E('div', { class: 'nf-info-row' }, 'Журнал пока пуст: сборщик записывает перезагрузки с момента установки.'),
				E('div', { class: 'nf-dnote' }, 'Полный журнал обрывов и перезагрузок: Монитор ресурсов → История.'));
		});
	}
	else if (key === 'cli') {
		Promise.all([ L.resolveDefault(callIwDevs(), []), L.resolveDefault(callHints(), {}), L.require('nightfall-devid').catch(() => null) ]).then(([ devs, hints, DEVID ]) =>
			Promise.all((devs || []).map(dv => L.resolveDefault(callAssoc(dv), []).then(l => (Array.isArray(l) ? l : []).map(c => Object.assign({ dev: dv }, c))))).then(lists => {
				const cl = [].concat(...lists).sort((a, b) => (a.signal || -200) - (b.signal || -200));
				if (!cl.length) { fill(E('div', { class: 'nf-empty' }, 'Сейчас по Wi‑Fi никто не подключён.')); return; }
				const q = v => v >= -60 ? 'отлично' : v >= -67 ? 'хорошо' : v >= -75 ? 'слабовато' : 'плохо';
				fill(cl.map(c => {
					const mac = String(c.mac || '').toUpperCase(), h = hints[mac] || {}, id = DEVID && mac ? DEVID.identify(mac, h.name || '') : null;
					const name = h.name || (id && id.known ? [ id.label || 'Устройство', id.vendor && id.vendor !== id.label ? id.vendor : '' ].filter(Boolean).join(' ') : '') || (h.ipaddrs || [])[0] || mac;
					const rate = c.rx && c.rx.rate ? ' · ↓ ' + nf0.format(c.rx.rate / 1000) + ' Мбит/с' : '';
					return row(name + ' · ' + c.dev + (id && id.priv ? ' · частный MAC' : ''), (c.signal != null ? c.signal + ' дБм · ' + q(c.signal) : '–') + rate, c.signal != null ? Math.max(0, Math.min(100, (c.signal + 95) * 100 / 50)) : null);
				}), E('div', { class: 'nf-dnote' }, 'Сверху самые слабые. Цвет полосы: чем длиннее, тем лучше сигнал. График по часам: Монитор → История → «Сигнал Wi‑Fi по часам».'));
			}));
	}
	else if (key === 'day') {
		J([ 'traffic' ]).then(t => {
			const rows = ((t && t.rows) || []).slice().sort((a, b) => a[0].localeCompare(b[0]));
			if (!rows.length) { fill(E('div', { class: 'nf-empty' }, 'Счётчики пока не накопились.')); return; }
			const d0 = new Date(), key0 = d => d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate());
			const by = {}; rows.forEach(r => { by[r[0]] = r; });
			const days = []; for (let i = 0; i < 14; i++) { const d = new Date(d0.getTime() - i * 86400000), r = by[key0(d)]; days.push([ d, r ? r[1] : 0, r ? r[2] : 0 ]); }
			const sum = (n, k) => days.slice(0, n).reduce((a, x) => a + x[k], 0), mx = Math.max(1, ...days.map(x => x[1] + x[2]));
			fill(row('Сегодня', '↓ ' + fmtBytes(days[0][1]) + ' · ↑ ' + fmtBytes(days[0][2])), row('Вчера', '↓ ' + fmtBytes(days[1][1]) + ' · ↑ ' + fmtBytes(days[1][2])),
				row('За 7 дней', '↓ ' + fmtBytes(sum(7, 1)) + ' · ↑ ' + fmtBytes(sum(7, 2))), row('За 14 дней', '↓ ' + fmtBytes(sum(14, 1)) + ' · ↑ ' + fmtBytes(sum(14, 2))),
				head('По дням (скачано + отдано)'),
				days.map(x => row(x[0].toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }), fmtBytes(x[1] + x[2]), 100 * (x[1] + x[2]) / mx)),
				E('div', { class: 'nf-dnote' }, 'Итоги по счётчикам порта WAN, а если они занижены (аппаратное ускорение), по данным устройств. Разбивка по устройствам и месяцам: Монитор → История → «Трафик по месяцам».'));
		});
	}
	else {
		fs.exec(STATS, []).then(r => JSON.parse(r.stdout)).then(d => {
			const m = d.mem, used = m.total - m.avail, fm = kb => fmtBytes(kb * 1024);
			fill(d.flash ? row('Флеш-память (настройки и пакеты)', fm(d.flash[1]) + ' из ' + fm(d.flash[0]), 100 * d.flash[1] / d.flash[0]) : '',
				d.flash ? row('Свободно во флеш-памяти', fm(d.flash[0] - d.flash[1])) : '',
				d.tmp ? row('/tmp (оперативная память: история, журналы)', fm(d.tmp[1]) + ' из ' + fm(d.tmp[0]), 100 * d.tmp[1] / d.tmp[0]) : '',
				row('Оперативная память', fm(used) + ' из ' + fm(m.total), 100 * used / m.total),
				E('div', { class: 'nf-dnote' }, 'Подключённые флешки и SD-карты, на которые можно сохранять историю: Монитор → История → «Накопители».'));
		}).catch(() => fill(E('div', { class: 'nf-empty' }, 'Нет данных.')));
	}
}

/* ---------- live tiles ---------- */

function liveStrip() {
	const S = {
		t: [], cpu: [], mem: [], temp: [], rx: [], tx: [], ping: [], ct: [], lo: [], cli: null, sig: null, day: null,
		last: null, wan: null, online: null, gw: null, net: null, loss: null
	};
	const R = {};   /* DOM refs */

	const sp = {
		net: spark([ 'nf-c-down' ]), wan: spark([ 'nf-c-down', 'nf-c-up' ]), cpu: spark([ 'nf-c-cpu' ]),
		temp: spark([ 'nf-c-temp' ]), mem: spark([ 'nf-c-mem' ]), ct: spark([ 'nf-c-mem' ]), lo: spark([ 'nf-c-temp' ])
	};

	const tile = (key, title, extra, ...rows) => E('div', { class: 'nf-tile', 'data-tile': key }, [
		E('div', { class: 'nf-tile-k' }, [ E('span', {}, title), extra || '' ]) ].concat(rows));

	R.netBadge = E('span', {}, badge('off', '—'));
	R.tempBadge = E('span');
	const strip = E('div', { class: 'nf-live' }, [
		E('div', { class: 'nf-live-h' }, [
			E('span', {}, 'Сейчас'),
			E('span', { class: 'nf-live-acts' }, [
				R.cols = E('span', { class: 'nf-colsel', title: 'Сколько столбцов карточек на «Обзоре»; карточки плотно, без пустых мест' }, [ E('span', {}, 'Столбцы:') ].concat([ [ '0', 'Авто' ], [ '1', '1' ], [ '2', '2' ], [ '3', '3' ] ].map(c => E('button', { type: 'button', class: 'nf-linkbtn', 'data-c': c[0] }, c[1])))),
				R.lay = E('span', { class: 'nf-colsel nf-laysel', title: 'Какие плитки показывать и как расположить карточки: одной кнопкой' }, [ E('span', {}, 'Раскладка:') ].concat([ [ 'std', 'Стандарт' ], [ 'home', 'Дом' ], [ 'min', 'Минимал' ], [ 'admin', 'Админ' ] ].map(c => E('button', { type: 'button', class: 'nf-linkbtn', 'data-l': c[0] }, c[1])))),
				R.reset = E('button', { type: 'button', class: 'nf-linkbtn', title: 'Вернуть порядок карточек по умолчанию' }, 'Сбросить порядок карточек'),
				R.qrBtn = E('button', { type: 'button', class: 'nf-linkbtn', title: 'QR-код для подключения к Wi-Fi' }, 'QR Wi-Fi'),
				R.boardBtn = E('button', { type: 'button', class: 'nf-linkbtn', title: 'Полноэкранное табло: время, скорость, пинг, нагрузка' }, 'Табло')
			])
		]),
		E('div', { class: 'nf-live-grid' }, [
			tile('net', 'Интернет', R.netBadge,
				R.netV = E('div', { class: 'nf-tile-v' }, '–'), R.netS = E('div', { class: 'nf-tile-s' }, ' '), sp.net.el),
			tile('wan', 'Трафик WAN', null,
				R.wanV = E('div', { class: 'nf-tile-v' }, '–'), R.wanS = E('div', { class: 'nf-tile-s' }, ' '), sp.wan.el),
			tile('cpu', 'Процессор', null,
				R.cpuV = E('div', { class: 'nf-tile-v' }, '–'), R.cpuS = E('div', { class: 'nf-tile-s' }, ' '), sp.cpu.el),
			tile('temp', 'Температура', R.tempBadge,
				R.tempV = E('div', { class: 'nf-tile-v' }, '–'), R.tempS = E('div', { class: 'nf-tile-s' }, ' '), sp.temp.el),
			tile('mem', 'Память', null,
				R.memV = E('div', { class: 'nf-tile-v' }, '–'), R.memS = E('div', { class: 'nf-tile-s' }, ' '), sp.mem.el),
			tile('ct', 'Соединения', null,
				R.ctV = E('div', { class: 'nf-tile-v' }, '–'), R.ctS = E('div', { class: 'nf-tile-s' }, ' '), sp.ct.el),
			tile('up', 'Аптайм', null,
				R.upV = E('div', { class: 'nf-tile-v' }, '–'), R.upS = E('div', { class: 'nf-tile-s' }, ' ')),
			tile('cli', 'Wi‑Fi клиенты', null,
				R.cliV = E('div', { class: 'nf-tile-v' }, '–'), R.cliS = E('div', { class: 'nf-tile-s' }, ' ')),
			tile('loss', 'Потери пакетов', null,
				R.lossV = E('div', { class: 'nf-tile-v' }, '–'), R.lossS = E('div', { class: 'nf-tile-s' }, ' '), sp.lo.el),
			tile('sig', 'Сигнал Wi‑Fi', null,
				R.sigV = E('div', { class: 'nf-tile-v' }, '–'), R.sigS = E('div', { class: 'nf-tile-s' }, ' ')),
			tile('day', 'Трафик за сутки', null,
				R.dayV = E('div', { class: 'nf-tile-v' }, '–'), R.dayS = E('div', { class: 'nf-tile-s' }, ' ')),
			tile('stor', 'Хранилище', null,
				R.storV = E('div', { class: 'nf-tile-v' }, '–'), R.storS = E('div', { class: 'nf-tile-s' }, ' '))
		])
	]);

	/* режим «Табло»: крупные часы и показатели на весь экран (планшет на полке, второй монитор) */
	let boardEl = null, boardTimer = 0;
	const txt = el => (el && el.textContent || '').trim() || '–';
	function closeBoard() {
		if (!boardEl) return;
		clearInterval(boardTimer); boardEl.remove(); boardEl = null;
		if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
	}
	function openBoard() {
		if (boardEl) return;
		const val = E('div', { class: 'nf-bd-v' }), clock = E('div', { class: 'nf-bd-clock' }), date = E('div', { class: 'nf-bd-date' });
		const cell = (k, title) => { const v = E('div', { class: 'nf-bd-n' }), s = E('div', { class: 'nf-bd-s' }); return { k, v, s, el: E('div', { class: 'nf-bd-c', 'data-k': k }, [ E('div', { class: 'nf-bd-t' }, title), v, s ]) }; };
		const cells = [ cell('net', 'Интернет'), cell('wan', 'Трафик'), cell('cpu', 'Процессор'), cell('temp', 'Температура'), cell('mem', 'Память') ];
		boardEl = E('div', { class: 'nf-board', role: 'dialog', 'aria-label': 'Табло' }, [
			E('button', { type: 'button', class: 'nf-bd-x', 'aria-label': 'Закрыть' }, '✕'), clock, date,
			E('div', { class: 'nf-bd-grid' }, cells.map(c => c.el)) ]);
		const tick = () => {
			const d = new Date();
			clock.textContent = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
			date.textContent = d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
			const src = { net: [ R.netV, R.netS ], wan: [ R.wanV, R.wanS ], cpu: [ R.cpuV, R.cpuS ], temp: [ R.tempV, R.tempS ], mem: [ R.memV, R.memS ] };
			cells.forEach(c => {
				c.v.textContent = txt(src[c.k][0]); c.s.textContent = txt(src[c.k][1]) === '–' ? '' : txt(src[c.k][1]);
				const t = document.querySelector('.nf-tile[data-tile="' + c.k + '"]');
				c.el.setAttribute('data-lvl', t && t.getAttribute('data-lvl') || '');
			});
		};
		tick(); boardTimer = setInterval(tick, 1000);
		boardEl.addEventListener('click', closeBoard);
		document.body.appendChild(boardEl);
		const rq = boardEl.requestFullscreen || boardEl.webkitRequestFullscreen;
		if (rq) { try { const p = rq.call(boardEl); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
	}
	document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeBoard(); });
	document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) closeBoard(); });
	R.boardBtn.addEventListener('click', openBoard);
	function openQr() {
		if (document.querySelector('.nf-qr-ov')) return;
		const esc = v => String(v).replace(/([\\;,:"])/g, '\\$1');
		const body = E('div', { class: 'nf-qr-body' }, 'Загрузка…');
		const ov = E('div', { class: 'nf-qr-ov' }, E('div', { class: 'nf-qr-box' }, [
			E('div', { class: 'nf-qr-h' }, [ E('b', {}, 'QR-код Wi-Fi'), E('button', { type: 'button', class: 'nf-linkbtn', 'data-close': '1' }, 'Закрыть') ]),
			body,
			E('div', { class: 'nf-qr-note' }, 'Наведите камеру телефона — он предложит подключиться. Пароль виден только вам и не покидает роутер.')
		]));
		ov.addEventListener('click', ev => { if (ev.target === ov || (ev.target.getAttribute && ev.target.getAttribute('data-close'))) ov.remove(); });
		document.body.appendChild(ov);
		callUci('wireless').then(v => {
			const list = Object.keys(v).map(k => v[k]).filter(x => x['.type'] === 'wifi-iface' && x.mode !== 'sta' && x.ssid);
			body.textContent = '';
			if (!list.length) { body.textContent = 'Сети Wi-Fi не найдены.'; return; }
			const seen = {};
			list.forEach(x => {
				const open = !x.encryption || x.encryption === 'none';
				const sae = /^sae/.test(x.encryption || '') && !/psk/.test(x.encryption || '');
				const key = x.key || '';
				const k = x.ssid + '|' + key; if (seen[k]) return; seen[k] = 1;
				const txt = 'WIFI:T:' + (open ? 'nopass' : (sae ? 'SAE' : 'WPA')) + ';S:' + esc(x.ssid) + ';' + (open ? '' : 'P:' + esc(key) + ';') + (x.hidden === '1' ? 'H:true;' : '') + ';';
				const m = NfQr.encode(txt);
				const card = E('div', { class: 'nf-qr-card' });
				if (!m) card.appendChild(E('div', {}, 'Слишком длинные данные'));
				else if (!open && !key) card.appendChild(E('div', {}, 'Пароль не задан в настройках (возможно, радиус-сервер).'));
				else {
					const n = m.length, q = 3, NS = 'http://www.w3.org/2000/svg';
					const svg = document.createElementNS(NS, 'svg');
					svg.setAttribute('viewBox', '0 0 ' + (n + 2 * q) + ' ' + (n + 2 * q)); svg.setAttribute('class', 'nf-qr-svg'); svg.setAttribute('shape-rendering', 'crispEdges');
					const bg = document.createElementNS(NS, 'rect'); bg.setAttribute('width', n + 2 * q); bg.setAttribute('height', n + 2 * q); bg.setAttribute('fill', '#fff'); svg.appendChild(bg);
					let d = ''; m.forEach((r, i) => r.forEach((c, j) => { if (c) d += 'M' + (j + q) + ' ' + (i + q) + 'h1v1h-1z'; }));
					const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('fill', '#000'); svg.appendChild(p);
					card.appendChild(svg);
				}
				card.appendChild(E('div', { class: 'nf-qr-ssid' }, x.ssid));
				card.appendChild(E('div', { class: 'nf-qr-sub' }, open ? 'без пароля' : (x.encryption || '') + (x.disabled === '1' ? ' · выключена' : '')));
				body.appendChild(card);
			});
			/* гостевая сеть по таймеру: сети с «guest/гост» в названии и выключенные сети */
			const cands = Object.keys(v).filter(k => v[k]['.type'] === 'wifi-iface' && v[k].mode !== 'sta' && v[k].ssid && (v[k].disabled === '1' || /guest|гост/i.test((v[k].network || '') + ' ' + v[k].ssid)));
			const gbox = E('div', { class: 'nf-qr-guest' });
			if (!cands.length) {
				gbox.appendChild(E('div', { class: 'nf-qr-sub' }, 'Гостевая сеть по таймеру: создайте отдельную сеть Wi-Fi (например, guest) в Сеть → Беспроводная сеть, и здесь появятся кнопки включения.'));
			} else {
				fs.exec(GUESTBIN, [ 'status' ]).then(r => { let st = null; try { st = JSON.parse(r.stdout); } catch (e) { /* ignore */ } return st; }).catch(() => null).then(st => {
					const until = {}; ((st && st.list) || []).forEach(x => { until[x[0]] = x[1]; });
					const hm = t => { const d = new Date(t * 1000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
					const reopen = () => { ov.remove(); window.setTimeout(openQr, 400); };
					const act = (b, args) => { b.disabled = true; fs.exec(GUESTBIN, args).then(reopen).catch(() => { b.disabled = false; }); };
					gbox.appendChild(E('div', { class: 'nf-qr-gh' }, 'Гостевая сеть по таймеру'));
					cands.forEach(id => {
						const x = v[id], on = x.disabled !== '1';
						const btns = on ? [ E('button', { type: 'button', class: 'nf-linkbtn nf-bad', click: ev => act(ev.currentTarget, [ 'off', id ]) }, 'Выключить') ]
							: [ [ 30, '30 мин' ], [ 60, '1 час' ], [ 240, '4 часа' ], [ 1440, 'Сутки' ] ].map(([ m, t ]) => E('button', { type: 'button', class: 'nf-linkbtn', click: ev => act(ev.currentTarget, [ 'on', id, String(m) ]) }, t));
						gbox.appendChild(E('div', { class: 'nf-qr-gr' }, [
							E('div', { class: 'nf-qr-gn' }, [ E('b', {}, x.ssid), E('span', { class: 'nf-qr-sub' }, on ? (until[id] ? 'включена до ' + hm(until[id]) : 'включена, без таймера') : 'выключена') ]),
							E('div', { class: 'nf-qr-ga' }, btns) ]));
					});
					if (cands.some(id => v[id].disabled === '1')) gbox.appendChild(E('div', { class: 'nf-qr-note' }, 'После включения сеть появится через несколько секунд. Сама выключится по таймеру.'));
				});
			}
			body.appendChild(gbox);
		}).catch(() => { body.textContent = 'Нет доступа к настройкам Wi-Fi. Обновите пакет и перезайдите в LuCI.'; });
	}
	document.addEventListener('keydown', ev => { if (ev.key === 'Escape') { const o = document.querySelector('.nf-qr-ov'); if (o) o.remove(); } });
	R.qrBtn.addEventListener('click', openQr);

	const paintCols = () => { const cur = document.documentElement.getAttribute('data-nf-ov-cols') || '0'; R.cols.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.getAttribute('data-c') === cur)); };
	R.cols.addEventListener('click', ev => { const b = ev.target.closest && ev.target.closest('button[data-c]'); if (!b) return; if (window.Nightfall && window.Nightfall.set) window.Nightfall.set('ovCols', b.getAttribute('data-c')); paintCols(); window.setTimeout(() => window.dispatchEvent(new Event('resize')), 60); });
	new MutationObserver(paintCols).observe(document.documentElement, { attributes: true, attributeFilter: [ 'data-nf-ov-cols' ] }); paintCols();
	const paintLay = () => { const cur = (window.Nightfall && window.Nightfall.prefs && window.Nightfall.prefs().ovLay) || ''; R.lay.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.getAttribute('data-l') === cur)); };
	R.lay.addEventListener('click', ev => { const b = ev.target.closest && ev.target.closest('button[data-l]'); if (!b) return; if (window.Nightfall && window.Nightfall.layout) window.Nightfall.layout(b.getAttribute('data-l')); paintLay(); });
	new MutationObserver(paintLay).observe(document.documentElement, { attributes: true, attributeFilter: [ 'data-nf-hide', 'data-nf-ov-cols', 'data-nf-ov-size' ] }); paintLay();
	strip.addEventListener('click', ev => {
		const t = ev.target.closest && ev.target.closest('.nf-tile[data-tile]');
		if (t) openDetail(t.getAttribute('data-tile'), t);
	});
	strip.addEventListener('keydown', ev => {
		const t = ev.target.closest && ev.target.closest('.nf-tile[data-tile]');
		if (t && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); openDetail(t.getAttribute('data-tile'), t); }
	});
	strip.querySelectorAll('.nf-tile').forEach(t => { const k = t.getAttribute('data-tile'); if (!DETAIL[k] && !INFO[k]) return; t.setAttribute('tabindex', '0'); t.setAttribute('role', 'button'); t.setAttribute('title', 'Нажмите, чтобы открыть график'); });

	function trim(now) {
		while (S.t.length && S.t[0] < now - WIN) {
			S.t.shift(); S.cpu.shift(); S.mem.shift(); S.temp.shift(); S.rx.shift(); S.tx.shift(); S.ping.shift(); S.ct.shift(); S.lo.shift();
		}
	}

	function pickTemp(list) {
		let main = null, first = null, wifi = null;
		for (const [ n, v ] of list || []) {
			const c = v / 1000;
			if (!isFinite(c) || c <= 0) continue;
			if (/phy|mt76|mt79|wifi|wlan|ath|iwlwifi/i.test(n)) { if (wifi == null) wifi = c; continue; }
			if (first == null) first = c;
			if (main == null && /cpu|soc|core|a53|a73|thermal/i.test(n)) main = c;
		}
		/* у роутеров без датчика процессора (MikroTik hAP ac2) берём датчик Wi‑Fi‑чипа */
		return main != null ? main : first != null ? first : wifi;
	}

	function ingest(d) {
		const now = Date.now() / 1000, prev = S.last;
		S.last = d;
		if (!prev || d.up <= prev.up) return;

		const sum = x => x[0] + x[1] + x[2] + x[3] + x[4] + x[5] + x[6] + x[7];
		const dt = sum(d.cpu[0]) - sum(prev.cpu[0]);
		const cpu = dt > 0 ? 100 * (1 - ((d.cpu[0][3] + d.cpu[0][4]) - (prev.cpu[0][3] + prev.cpu[0][4])) / dt) : null;

		const up = d.up - prev.up;
		let rx = null, tx = null;
		const dev = S.wan;
		if (dev) {
			const a = prev.net.find(n => n[0] === dev), b = d.net.find(n => n[0] === dev);
			if (a && b && up > 0) {
				rx = Math.max(0, (b[1] - a[1]) / up);
				tx = Math.max(0, (b[5] - a[5]) / up);
			}
		}

		S.t.push(now); S.cpu.push(cpu);
		S.mem.push(100 * (d.mem.total - d.mem.avail) / d.mem.total);
		S.temp.push(pickTemp(d.temps));
		S.rx.push(rx); S.tx.push(tx);
		S.ping.push(S.net != null && S.net >= 0 ? S.net : null);
		S.ct.push(d.ct && d.ct[0] >= 0 ? d.ct[0] : null);
		S.lo.push(S.loss);
		trim(now);
	}

	function render() {
		const d = S.last;
		if (!d) return;
		const lastOf = a => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };

		/* internet */
		R.netBadge.replaceChildren(S.online === true ? badge('ok', 'Онлайн') : S.online === false ? badge('bad', 'Нет связи') : badge('off', 'Нет данных'));
		setNum(R.netV, S.net != null && S.net >= 0 ? nf0.format(S.net) + ' мс' : (S.online === false ? '—' : '–'));
		R.netS.textContent = S.gw != null && S.gw >= 0 ? 'до шлюза ' + nf1.format(S.gw) + ' мс' : (S.online == null ? 'история не собирается' : ' ');
		sp.net.update(S.t, [ S.ping ], niceCeil(Math.max(20, ...S.ping.filter(v => v != null))));

		/* WAN speed */
		const rx = lastOf(S.rx), tx = lastOf(S.tx);
		if (rx != null) {
			const r = fmtRate(rx), u = fmtRate(tx || 0);
			setNum(R.wanV, '↓ ' + r[0] + ' ' + r[1]);
			setNum(R.wanS, '↑ ' + u[0] + ' ' + u[1]);
		}
		else R.wanV.textContent = S.wan ? '–' : 'WAN не найден';
		sp.wan.update(S.t, [ S.rx, S.tx ], niceCeil(Math.max(12500, ...S.rx.filter(v => v != null), ...S.tx.filter(v => v != null))));

		/* CPU */
		const cpu = lastOf(S.cpu);
		setNum(R.cpuV, cpu != null ? nf0.format(cpu) + '%' : '–');
		R.cpuS.textContent = 'нагрузка ' + d.load.map(v => nf2.format(v)).join(' · ');
		setLvl(R.cpuV, cpu, ...thr('cpu', 60, 85));
		sp.cpu.update(S.t, [ S.cpu ], 100);

		/* temperature */
		const t = lastOf(S.temp);
		if (t != null) {
			setNum(R.tempV, nf1.format(t) + ' °C');
			R.tempBadge.replaceChildren(t >= 85 ? badge('bad', 'Жарко') : t >= 70 ? badge('warn', 'Тепло') : badge('ok', 'Норма'));
			R.tempS.textContent = 'процессор';
		}
		else { R.tempV.textContent = '–'; R.tempS.textContent = 'нет датчика'; R.tempBadge.replaceChildren(); }
		setLvl(R.tempV, t, ...thr('temp', 70, 85));
		sp.temp.update(S.t, [ S.temp ], 100, 30);

		/* memory */
		const m = d.mem, used = m.total - m.avail;
		setNum(R.memV, nf0.format(100 * used / m.total) + '%');
		R.memS.textContent = nf0.format(used / 1024) + ' МБ из ' + nf0.format(m.total / 1024) + ' МБ';
		setLvl(R.memV, 100 * used / m.total, ...thr('mem', 70, 88));
		sp.mem.update(S.t, [ S.mem ], 100);

		/* соединения, аптайм, клиенты Wi‑Fi: необязательные плитки (включаются в настройках «Сейчас») */
		const ct = d.ct && d.ct[1] > 0 ? d.ct : null;
		setNum(R.ctV, ct ? nf0.format(ct[0]) : '–');
		R.ctS.textContent = ct ? 'из ' + nf0.format(ct[1]) + ' (' + nf0.format(100 * ct[0] / ct[1]) + '%)' : 'нет данных';
		setLvl(R.ctV, ct ? 100 * ct[0] / ct[1] : null, 70, 90);
		sp.ct.update(S.t, [ S.ct ], niceCeil(Math.max(50, ...S.ct.filter(v => v != null))));
		const us = d.up || 0, ud = Math.floor(us / 86400), uh = Math.floor(us % 86400 / 3600), um = Math.floor(us % 3600 / 60);
		R.upV.textContent = ud > 0 ? ud + ' д ' + uh + ' ч' : uh > 0 ? uh + ' ч ' + um + ' мин' : um + ' мин';
		R.upS.textContent = 'нагрузка ' + d.load.map(v => nf2.format(v)).join(' · ');
		setNum(R.cliV, S.cli != null ? String(S.cli) : '–');
		R.cliS.textContent = S.cli == null ? 'считаю…' : 'подключено по Wi‑Fi';

		/* потери, сигнал Wi‑Fi, трафик за сутки, хранилище */
		setNum(R.lossV, S.loss != null ? nf1.format(S.loss) + '%' : '–');
		R.lossS.textContent = S.net != null && S.net >= 0 ? 'пинг ' + nf0.format(S.net) + ' мс' : 'нет данных';
		setLvl(R.lossV, S.loss, 2, 5);
		sp.lo.update(S.t, [ S.lo ], niceCeil(Math.max(5, ...S.lo.filter(v => v != null))));
		if (S.sig) {
			setNum(R.sigV, nf0.format(S.sig.avg) + ' дБм');
			R.sigS.textContent = 'худший ' + nf0.format(S.sig.worst) + ' дБм · клиентов ' + S.sig.n;
			setLvl(R.sigV, S.sig.avg >= -67 ? 0 : 100 - Math.max(0, S.sig.avg + 100) * 1.2, 40, 70);
		}
		else { R.sigV.textContent = '–'; R.sigS.textContent = S.cli === 0 ? 'нет клиентов Wi‑Fi' : 'считаю…'; setLvl(R.sigV, null, 40, 70); }
		if (S.day) { setNum(R.dayV, '↓ ' + fmtBytes(S.day[0])); R.dayS.textContent = '↑ ' + fmtBytes(S.day[1]); }
		else { R.dayV.textContent = '–'; R.dayS.textContent = 'счётчики не накоплены'; }
		if (d.flash && d.flash[0] > 0) {
			const fp = 100 * d.flash[1] / d.flash[0], fr = (d.flash[0] - d.flash[1]) / 1048576;
			setNum(R.storV, nf0.format(fp) + '%'); R.storS.textContent = 'свободно ' + (fr >= 1 ? nf1.format(fr) + ' ГБ' : nf0.format(fr * 1024) + ' МБ');
			setLvl(R.storV, fp, 75, 90);
		}
		else { R.storV.textContent = '–'; R.storS.textContent = 'нет данных'; }

		SHARED.t = Date.now(); SHARED.cpu = cpu; SHARED.mem = 100 * used / m.total; SHARED.temp = t;
		SHARED.online = S.online; SHARED.ping = S.net; SHARED.loss = S.loss;
	}

	function sample() {
		return fs.exec(STATS, []).then(res => {
			let d = null;
			try { d = JSON.parse(res.stdout); } catch (e) { /* ignore */ }
			if (!d) throw new Error('no data');
			ingest(d);
			render();
		});
	}

	function history() {
		return fs.exec(HIST, [ 'alerts' ]).then(res => {
			let h = null;
			try { h = JSON.parse(res.stdout); } catch (e) { /* ignore */ }
			if (!h || !h.info || !h.info.started) { S.online = null; return; }
			const last = (h.last || [])[0];
			const fresh = last && h.now - last[0] <= 90;
			S.net = fresh ? last[7] : null;
			S.gw = fresh ? last[6] : null;
			S.loss = fresh && last[8] != null && last[8] >= 0 ? last[8] : null;
			S.online = fresh ? last[7] >= 0 : null;
			if ((h.active || []).some(a => a[0] === 'wan')) S.online = false;
		}).catch(() => { S.online = null; });
	}

	function seed() {
		return fs.exec(HIST, [ 'series', 'fine' ]).then(res => {
			let h = null;
			try { h = JSON.parse(res.stdout); } catch (e) { /* ignore */ }
			if (!h || !h.rows) return;
			for (const r of h.rows) {
				if (h.now - r[0] > WIN) continue;
				S.t.push(r[0]); S.cpu.push(r[1] >= 0 ? r[1] : null); S.mem.push(r[2] >= 0 ? r[2] : null);
				S.temp.push(r[3] >= 0 ? r[3] : null); S.rx.push(r[4] >= 0 ? r[4] : null); S.tx.push(r[5] >= 0 ? r[5] : null);
				S.ping.push(r[7] >= 0 ? r[7] : null);
				S.ct.push(r[9] != null && r[9] >= 0 ? r[9] : null);
				S.lo.push(r[8] != null && r[8] >= 0 ? r[8] : null);
			}
		}).catch(() => {});
	}

	function clients() {
		const hid = document.documentElement.getAttribute('data-nf-hide') || '';
		if (hid.indexOf(' cli ') >= 0 && hid.indexOf(' sig ') >= 0) return Promise.resolve();
		return L.resolveDefault(callIwDevs(), []).then(devs => Promise.all((devs || []).map(dv => L.resolveDefault(callAssoc(dv), [])))).then(lists => {
			const all = [].concat(...lists.map(l => Array.isArray(l) ? l : []));
			S.cli = all.length;
			const sg = all.map(c => +c.signal).filter(v => isFinite(v) && v < 0 && v > -120);
			S.sig = sg.length ? { avg: sg.reduce((a, b) => a + b, 0) / sg.length, worst: Math.min(...sg), n: sg.length } : null;
		}).catch(() => {});
	}

	/* трафик за сегодня по счётчикам WAN (нужен плитке «Трафик за сутки») */
	function today() {
		if ((document.documentElement.getAttribute('data-nf-hide') || '').indexOf(' day ') >= 0) return Promise.resolve();
		return fs.exec(HIST, [ 'traffic' ]).then(res => {
			const h = JSON.parse(res.stdout), d = new Date(), k = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
			const r = (h.rows || []).find(x => x[0] === k);
			S.day = r ? [ r[1], r[2] ] : null;
		}).catch(() => {});
	}

	function findWan() {
		return callIfaces().then(res => {
			for (const i of (res && res.interface) || []) {
				const dev = i.l3_device || i.device;
				if (dev && i.up && (i.route || []).some(r => r.target === '0.0.0.0' || r.target === '::')) { S.wan = dev; return; }
			}
		}).catch(() => {});
	}

	/* плитку включили в настройках или сменили раскладку: данные для неё подгружаем сразу, а не через цикл опроса */
	new MutationObserver(() => { Promise.all([ clients(), today() ]).then(render); }).observe(document.documentElement, { attributes: true, attributeFilter: [ 'data-nf-hide' ] });

	let n = 0, timer = null;
	function tick() {
		if (document.hidden || window.getComputedStyle(strip).display === 'none') return;
		sample().then(() => {
			if (n++ % ALERTS_EVERY === 0) return Promise.all([ history(), clients(), today() ]).then(render);
		}).catch(() => {
			/* stats script not available (no ACL or package missing): drop the strip */
			if (!S.last) { strip.remove(); window.clearInterval(timer); }
		});
	}

	return {
		el: strip,
		resetBtn: R.reset,
		start() {
			Promise.all([ findWan(), seed() ]).then(() => history()).then(() => {
				tick();
				timer = window.setInterval(tick, EVERY);
			});
		}
	};
}

/* ---------- cards: priority order, drag & drop ---------- */

const PIN_KEY = 'nightfall-overview-pins-v1';
const NAMES_KEY = 'nightfall-names-v1';
let PIN_MEM = null, NAMES_MEM = null, EDITING = false;

function loadPins() {
	try { const v = JSON.parse(window.localStorage.getItem(PIN_KEY) || 'null'); return Array.isArray(v) ? v : (PIN_MEM || []); }
	catch (e) { return PIN_MEM || []; }
}

function savePins(list) {
	PIN_MEM = list;
	try { window.localStorage.setItem(PIN_KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
}

function loadNames() {
	try { const v = JSON.parse(window.localStorage.getItem(NAMES_KEY) || 'null'); return v && typeof v === 'object' ? v : (NAMES_MEM || {}); }
	catch (e) { return NAMES_MEM || {}; }
}

function setName(key, value) {
	const n = Object.assign({}, loadNames());
	if (value) n[key] = value; else delete n[key];
	NAMES_MEM = n;
	try { window.localStorage.setItem(NAMES_KEY, JSON.stringify(n)); } catch (e) { /* private mode */ }
}

const nameKey = k => String(k || '').toUpperCase();

/* inline rename: swaps the title box for an input; Enter or leaving the field saves, Esc cancels, empty text restores the automatic name */
function editName(box, key, auto, done) {
	const inp = E('input', { class: 'nf-rename', type: 'text', maxlength: '40', placeholder: auto, 'aria-label': 'Своё имя устройства' });
	inp.value = loadNames()[nameKey(key)] || '';
	box.replaceChildren(inp);
	EDITING = true;
	inp.focus(); inp.select();
	let fin = false;
	const end = save => {
		if (fin) return;
		fin = true; EDITING = false;
		if (save) setName(nameKey(key), inp.value.trim());
		done();
	};
	inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') end(true); else if (ev.key === 'Escape') end(false); });
	inp.addEventListener('blur', () => end(true));
}

let MEM = null;   /* fallback when localStorage is blocked: order survives until the page is reloaded */

function loadOrder() {
	try { const v = JSON.parse(window.localStorage.getItem(ORDER_KEY) || 'null'); return Array.isArray(v) ? v : MEM; }
	catch (e) { return MEM; }
}

function saveOrder(list) {
	MEM = list || null;
	try {
		if (list) window.localStorage.setItem(ORDER_KEY, JSON.stringify(list));
		else window.localStorage.removeItem(ORDER_KEY);
	} catch (e) { /* private mode */ }
}

function cardsOf(view) {
	return Array.from(view.children).filter(c => c.classList.contains('cbi-section') && c.querySelector(':scope > .cbi-title h3'));
}

function titleOf(sec) {
	const h = sec.querySelector(':scope > .cbi-title h3');
	return h ? (h.getAttribute('data-nf-title') || h.textContent.trim()) : '';
}

function rank(title, index, saved, pins) {
	const pin = pins && pins.includes(title) ? 0 : 1;
	const si = saved ? saved.indexOf(title) : -1;
	if (si >= 0) return [ pin, 0, si, 0 ];
	let p = PRIORITY.findIndex(re => re.test(title));
	if (p < 0) p = 100;
	return [ pin, 1, p, index ];
}

function sortCards(view, saved) {
	const cards = cardsOf(view);
	if (cards.length < 2) return;
	const pins = loadPins();
	const sorted = cards.map((c, i) => ({ c, r: rank(titleOf(c), i, saved, pins) }))
		.sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2] || a.r[3] - b.r[3]).map(x => x.c);
	if (sorted.every((c, i) => c === cards[i])) return;   /* already in order: do not touch the DOM (restarts animations) */
	const marker = document.createComment('nf');
	view.insertBefore(marker, cards[0]);
	sorted.forEach(c => view.insertBefore(c, marker));
	marker.remove();
}

/* FLIP: remember where the elements were, run the change, then glide them from the old place to the new one */
function flip(items, mutate) {
	if (document.documentElement.getAttribute('data-nf-motion') === 'off') { mutate(); return; }
	const before = new Map(items.map(e => [ e, e.getBoundingClientRect() ]));
	mutate();
	const moved = [];
	items.forEach(e => {
		const a = before.get(e), b = e.getBoundingClientRect();
		const dx = a.left - b.left, dy = a.top - b.top;
		if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
		e.style.transition = 'none';
		e.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
		moved.push(e);
	});
	if (!moved.length) return;
	void document.body.offsetWidth;
	window.requestAnimationFrame(() => moved.forEach(e => {
		e.classList.add('nf-moving');
		e.style.transition = 'transform .3s cubic-bezier(.2, .8, .2, 1)';
		e.style.transform = '';
		let done = false;
		const fin = () => { if (done) return; done = true; e.style.transition = ''; e.classList.remove('nf-moving'); e.removeEventListener('transitionend', fin); };
		e.addEventListener('transitionend', fin);
		window.setTimeout(fin, 420);
	}));
}

/* pointer-driven drag: the card follows the cursor, a dashed slot marks where it will land, the others glide aside */
function startDrag(view, sec, ev, persist) {
	const rect = sec.getBoundingClientRect(), cs = window.getComputedStyle(sec);
	const offX = ev.clientX - rect.left, offY = ev.clientY - rect.top;
	let px = ev.clientX, py = ev.clientY, last = 0, raf = 0, ended = false;

	const slot = E('div', { class: 'nf-slot' });
	slot.style.gridColumn = cs.gridColumnStart + ' / ' + cs.gridColumnEnd;
	slot.style.gridRowEnd = sec.style.gridRowEnd;
	slot.style.height = rect.height + 'px';
	slot.style.marginBottom = cs.marginBottom;
	DRAG = true;
	view.insertBefore(slot, sec);
	document.body.classList.add('nf-drag-on');
	sec.classList.add('nf-lifted');
	sec.style.left = rect.left + 'px'; sec.style.top = rect.top + 'px';
	sec.style.width = rect.width + 'px'; sec.style.height = rect.height + 'px';

	const check = () => {
		const now = performance.now();
		if (now - last < 150) return;
		const others = cardsOf(view).filter(c => c !== sec);
		const target = others.find(c => { const r = c.getBoundingClientRect(); return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom; });
		if (!target) return;
		const r = target.getBoundingClientRect(), wide = r.width > view.clientWidth * 0.7;
		const rx = (px - r.left) / r.width - 0.5, ry = (py - r.top) / r.height - 0.5;
		const before = (!wide && Math.abs(rx) > Math.abs(ry)) ? rx < 0 : ry < 0;
		const ref = before ? target : target.nextSibling;
		if (ref === slot || slot.nextSibling === ref) return;
		flip(others, () => view.insertBefore(slot, ref));
		last = now;
	};

	const loop = () => {
		if (ended) return;
		if (py < 70) window.scrollBy(0, -Math.min(22, (70 - py) / 3 + 4));
		else if (py > window.innerHeight - 70) window.scrollBy(0, Math.min(22, (py - (window.innerHeight - 70)) / 3 + 4));
		check();
		raf = window.requestAnimationFrame(loop);
	};

	const move = e => {
		px = e.clientX; py = e.clientY;
		sec.style.left = (px - offX) + 'px'; sec.style.top = (py - offY) + 'px';
		check();
	};

	const finish = () => {
		if (ended) return;
		ended = true;
		window.cancelAnimationFrame(raf);
		window.removeEventListener('pointermove', move);
		window.removeEventListener('pointerup', finish);
		window.removeEventListener('pointercancel', finish);
		const t = slot.getBoundingClientRect();
		const land = () => {
			view.insertBefore(sec, slot);
			slot.remove();
			sec.classList.remove('nf-lifted', 'nf-landing');
			sec.style.left = sec.style.top = sec.style.width = sec.style.height = sec.style.transition = '';
			document.body.classList.remove('nf-drag-on');
			persist();
			DRAG = false;
		};
		if (document.documentElement.getAttribute('data-nf-motion') === 'off') { land(); return; }
		sec.classList.add('nf-landing');
		sec.style.left = t.left + 'px'; sec.style.top = t.top + 'px';
		let done = false;
		const fin = () => { if (done) return; done = true; land(); };
		sec.addEventListener('transitionend', fin);
		window.setTimeout(fin, 320);
	};

	window.addEventListener('pointermove', move);
	window.addEventListener('pointerup', finish);
	window.addEventListener('pointercancel', finish);
	raf = window.requestAnimationFrame(loop);
}

const ICONS = [
	[ /Интернет|Internet/i, 'net' ], [ /^(Сеть|Network)$/i, 'network' ], [ /порт|Port/i, 'ports' ], [ /Беспровод|Wireless|Wi.?Fi/i, 'wifi' ],
	[ /Топ клиентов/i, 'top' ], [ /Состояние роутера/i, 'health' ], [ /Лента|событ/i, 'events' ], [ /Быстрые/i, 'quick' ],
	[ /^(Система|System)$/i, 'system' ], [ /Температур/i, 'temp' ], [ /Память|Memory/i, 'mem' ], [ /Хранилищ|Storage/i, 'disk' ], [ /DHCP|Аренд/i, 'dhcp' ]
];
const iconFor = title => (ICONS.find(x => x[0].test(title)) || [ 0, 'generic' ])[1];

/* размер карточки: '' (обычная) → wide → min; запоминается по названию карточки */
let SIZE_MEM = null;
function loadSizes() {
	try { const v = JSON.parse(window.localStorage.getItem(SIZE_KEY) || 'null'); return v && typeof v === 'object' ? v : (SIZE_MEM || {}); }
	catch (e) { return SIZE_MEM || {}; }
}
function saveSizes(m) {
	SIZE_MEM = m;
	try { window.localStorage.setItem(SIZE_KEY, JSON.stringify(m)); } catch (e) { /* private mode */ }
}
/* высота карточки, которую пользователь задал, потянув за уголок (px, по названию карточки) */
let H_MEM = null;
function loadHeights() {
	try { const v = JSON.parse(window.localStorage.getItem(HEIGHT_KEY) || 'null'); return v && typeof v === 'object' ? v : (H_MEM || {}); }
	catch (e) { return H_MEM || {}; }
}
function saveHeights(m) {
	H_MEM = m;
	try { window.localStorage.setItem(HEIGHT_KEY, JSON.stringify(m)); } catch (e) { /* private mode */ }
}
/* IP и MAC в таблицах (аренда DHCP, Wi‑Fi) не переносим по символам */
const NW_RE = /^((\d{1,3}\.){3}\d{1,3}|([0-9a-f]{2}[:-]){5}[0-9a-f]{2})$/i;
function markNoWrap(view) {
	view.querySelectorAll('.td, td').forEach(td => {
		if (!td.classList.contains('nf-nw') && NW_RE.test(td.textContent.trim())) td.classList.add('nf-nw');
	});
}

/* Таблицы с живыми данными (Wi‑Fi клиенты, аренды DHCP): LuCI пересобирает строки каждые 5 секунд, и ширина колонок и высота строк
   «дышат» из-за меняющегося текста (сигнал, скорость, подписи). Запоминаем наибольшие размеры и не даём таблице сжиматься обратно.
   Вызывается синхронно из MutationObserver, до отрисовки кадра, поэтому скачка не видно. Сбрасывается при изменении размера окна. */
let STAB_GEN = 0, STAB_W = window.innerWidth;
const STAB_MEM = {};   /* наибольшие размеры по id таблицы: LuCI создаёт таблицу заново при каждом опросе, память должна переживать смену элемента */
window.addEventListener('resize', () => { if (Math.abs(window.innerWidth - STAB_W) > 2) { STAB_W = window.innerWidth; STAB_GEN++; } });
/* смена размера карточек, плотности, шрифта или стиля в «Персонализации»: забываем накопленные минимумы, иначе таблицы остались бы прежнего размера */
new MutationObserver(() => {
	STAB_GEN++;
	const v = document.getElementById('view');
	if (v) { v.querySelectorAll('.cbi-section').forEach(c => { if (!c.classList.contains('nf-fixh')) c.style.minHeight = ''; }); window.setTimeout(() => { stabilizeTables(v); window.dispatchEvent(new Event('resize')); }, 120); }
}).observe(document.documentElement, { attributes: true, attributeFilter: [ 'data-nf-ov-size', 'data-nf-density', 'data-nf-font', 'data-nf-style', 'data-nf-radius', 'data-nf-fsz', 'data-nf-ovwide', 'data-nf-ov-cols', 'style' ] });
/* «Подключённые клиенты»: имя узла в первой строке, ниже IP и MAC (отдельный столбец MAC скрывается) */
function decorateHosts(view) {
	view.querySelectorAll('#wifi_assoclist_table').forEach(tb => {
		let any = false;
		tb.querySelectorAll('tr.tr, .tr').forEach(r => {
			if (r.classList.contains('table-titles') || r.querySelector(':scope > .th, :scope > th')) return;
			const c = r.querySelectorAll(':scope > .td, :scope > td');
			if (c.length < 3 || c[2].querySelector('.nf-host')) { if (c.length >= 3) any = true; return; }
			const mac = (c[1].textContent || '').trim(), raw = (c[2].textContent || '').trim();
			const m = /^(.+?)\s*\(([^)]*)\)\s*$/.exec(raw);
			const name = m ? m[1] : '', addrs = (m ? m[2] : raw).split(/\s*,\s*/).filter(Boolean);
			const v4 = addrs.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || addrs[0] || '';
			const wrap = E('div', { class: 'nf-host', title: raw }), isMac = x => x && /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(x);
			if (name) {
				wrap.appendChild(E('div', { class: 'nf-h1' }, name));
				wrap.appendChild(E('div', { class: 'nf-h2' }, [ v4, isMac(mac) ? E('span', { class: 'nf-h2m' }, ' · ' + mac) : '' ]));
			} else wrap.appendChild(E('div', { class: 'nf-h1 nf-h1ip' }, [ v4 || '?', isMac(mac) ? E('span', { class: 'nf-h2m' }, ' · ' + mac) : '' ]));
			c[2].textContent = ''; c[2].appendChild(wrap);
			any = true;
		});
		tb.classList.toggle('nf-hostmerged', any);
	});
}
/* «Свободно» в памяти: чем больше свободного, тем лучше. Зелёный — запас есть, жёлтый — средне, красный — мало (обратно обычным полосам) */
/* цвет линии по нагрузке: зелёный, жёлтый, красный */
/* пороги цвета плиток из настроек темы (атрибут на <html>, «середина,плохо») */
function thr(k, mid, bad) {
	const p = (document.documentElement.getAttribute('data-nf-thr-' + k) || '').split(',').map(parseFloat);
	return p.length === 2 && isFinite(p[0]) && isFinite(p[1]) && p[0] < p[1] ? p : [ mid, bad ];
}

function setLvl(el, v, mid, bad) {
	const tile = el && el.closest ? el.closest('.nf-tile') : null;
	if (tile) {
		tile.setAttribute('data-lvl', v == null ? '' : v >= bad ? 'bad' : v >= mid ? 'mid' : 'ok');
		tile.style.setProperty('--ring', v == null || !(v > 0) ? 0 : Math.max(4, Math.min(100, v)));
	}
}
/* число на карточке плавно «докручивается» до нового значения */
function setNum(el, text) {
	const m = /^(\D*)(-?\d+(?:[.,]\d+)?)(.*)$/.exec(text), off = document.documentElement.getAttribute('data-nf-motion') === 'off';
	if (el._nfR) { cancelAnimationFrame(el._nfR); el._nfR = 0; }
	const to = m ? parseFloat(m[2].replace(',', '.')) : null, from = el._nfN, sfx = m ? m[1] + '|' + m[3] : '';
	const same = el._nfS === sfx;      /* единица или приставка сменилась (Кбит → Мбит): число не докручиваем */
	el._nfN = to; el._nfS = sfx;
	if (!m || off || from == null || from === to || !same || Math.abs(to - from) > 1e6) { el.textContent = text; return; }
	const dec = (m[2].split(/[.,]/)[1] || '').length, sep = m[2].indexOf(',') >= 0 ? ',' : '.', t0 = performance.now(), D = 500;
	const step = now => {
		const k = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - k, 3);
		el.textContent = k >= 1 ? text : m[1] + (from + (to - from) * e).toFixed(dec).replace('.', sep) + m[3];
		el._nfR = k < 1 ? requestAnimationFrame(step) : 0;
	};
	el._nfR = requestAnimationFrame(step);
}
function levelFree(view) {
	const fmt = (n, u) => (Math.round(n * 100) / 100).toFixed(2) + ' ' + u;
	view.querySelectorAll('.cbi-progressbar').forEach(pb => {
		const row = pb.closest('.tr, tr'), lab = row && row.querySelector('.td, td');
		if (!lab) return;
		const t = (lab.textContent || '').trim(), title = pb.getAttribute('title') || '';
		const m = /\((\d+(?:[.,]\d+)?)%\)\s*$/.exec(title); if (!m) return;
		const f = parseFloat(m[1].replace(',', '.'));
		if (/^(свободно|free|available|доступно)$/i.test(t)) pb.setAttribute('data-nf-free', f >= 30 ? 'ok' : f >= 12 ? 'mid' : 'low');
		else if (/^(занято|used|в\s+использовании)$/i.test(t)) {
			/* «Занято» = всё, что не свободно (вместе с кэшем): 67% свободно → 33% занято */
			const fr = Array.from((row.closest('.table, table') || view).querySelectorAll('.cbi-progressbar')).find(x => { const r = x.closest('.tr, tr'), l = r && r.querySelector('.td, td'); return l && /^(свободно|free|available|доступно)$/i.test((l.textContent || '').trim()) && x !== pb; });
			const fm = fr && /([\d.,]+)\s*([KMGT]?i?B)\s*\/\s*([\d.,]+)\s*([KMGT]?i?B)\s*\((\d+(?:[.,]\d+)?)%\)/.exec(fr.getAttribute('title') || '');
			let u = f;
			if (fm && fm[2] === fm[4]) {
				const tot = parseFloat(fm[3].replace(',', '.')), fre = parseFloat(fm[1].replace(',', '.'));
				u = Math.max(0, Math.min(100, Math.round(100 - parseFloat(fm[5].replace(',', '.')))));
				const nt = fmt(tot - fre, fm[2]) + ' / ' + fmt(tot, fm[4]) + ' (' + u + '%)';
				if (title !== nt) { pb.setAttribute('title', nt); pb.setAttribute('data-nf-fixed', '1'); }
				const bar = pb.firstElementChild; if (bar && bar.style.width !== u + '%') bar.style.width = u + '%';
			}
			pb.setAttribute('data-nf-free', u < 60 ? 'ok' : u < 85 ? 'mid' : 'low');
		}
		else if (/^(буферизовано|кэшировано|кешировано|buffered|cached|shared)/i.test(t)) pb.setAttribute('data-nf-free', 'dim');
		else if (/(дисков|временн|storage|disk|temporary|tmp|overlay|root)/i.test(t)) pb.setAttribute('data-nf-free', f < 70 ? 'ok' : f < 90 ? 'mid' : 'low');   /* хранилище: заполнение */
	});
}
function stabilizeTables(view) {
	view.querySelectorAll('.table').forEach(tb => {
		if (!tb.querySelector('.td[data-title], td')) return;
		const st = tb.id ? (STAB_MEM[tb.id] = STAB_MEM[tb.id] || {}) : (tb.__nfSt = tb.__nfSt || {});
		if (st.gen !== STAB_GEN) { st.gen = STAB_GEN; st.col = []; st.row = []; st.h = 0; }
		if (tb.__nfGen !== STAB_GEN) { tb.__nfGen = STAB_GEN; tb.querySelectorAll('.tr, tr').forEach(r => { r.style.minHeight = ''; r.querySelectorAll('.td, .th, td, th').forEach(c => { c.style.minWidth = ''; }); }); tb.style.minHeight = ''; }
		const rows = Array.from(tb.querySelectorAll(':scope > .tr, :scope > tbody > tr, :scope > thead > tr'));
		if (!rows.length || tb.getBoundingClientRect().width < 40) return;
		/* число строк изменилось (клиент ушёл или появился): высота запоминается заново, иначе под таблицей остаётся пустое место */
		if (st.n !== rows.length) {
			if (st.n != null) { st.row = []; st.h = 0; tb.style.minHeight = ''; rows.forEach(r => { r.style.minHeight = ''; }); }
			st.n = rows.length;
		}
		/* запомненные ширины не должны выпирать из карточки: при переполнении сбрасываем и меряем заново */
		const box = tb.parentElement;
		if (box && st.col.length && tb.getBoundingClientRect().width > box.clientWidth + 2) {
			st.col = []; tb.querySelectorAll('.td, .th, td, th').forEach(c => { c.style.minWidth = ''; });
			st.noW = Date.now();
		}
		const keepW = !st.noW || Date.now() - st.noW > 60000;   /* после переполнения минуту не фиксируем ширины */
		rows.forEach((r, ri) => {
			const cells = Array.from(r.querySelectorAll(':scope > .td, :scope > .th, :scope > td, :scope > th'));
			cells.forEach((c, ci) => {
				const w = Math.ceil(c.getBoundingClientRect().width);
				if (!keepW) return;
				if (w > (st.col[ci] || 0)) st.col[ci] = w;
				if (st.col[ci] && c.style.minWidth !== st.col[ci] + 'px') c.style.minWidth = st.col[ci] + 'px';
			});
			const h = Math.ceil(r.getBoundingClientRect().height);
			if (h > (st.row[ri] || 0)) st.row[ri] = h;
			if (st.row[ri] && r.style.minHeight !== st.row[ri] + 'px') r.style.minHeight = st.row[ri] + 'px';
		});
		const th = Math.ceil(tb.getBoundingClientRect().height);
		if (th > st.h) st.h = th;
		if (st.h && tb.style.minHeight !== st.h + 'px') tb.style.minHeight = st.h + 'px';
	});
}

function syncSizes(view, relayoutNow) {
	const m = loadSizes();
	cardsOf(view).forEach(sec => {
		const t = titleOf(sec), v = m[t] || '';
		sec.classList.toggle('nf-wide', v === 'wide');
		sec.classList.toggle('nf-min', v === 'min');
		const hh = +loadHeights()[t] || 0;
		sec.style.minHeight = hh && v !== 'min' ? hh + 'px' : '';
		sec.classList.toggle('nf-fixh', !!hh && v !== 'min');
		const b = sec.querySelector(':scope > .cbi-title .nf-size');
		if (b) { b.setAttribute('data-s', v); b.title = v === 'wide' ? 'Широкая. Нажмите, чтобы свернуть' : v === 'min' ? 'Свёрнута. Нажмите, чтобы вернуть обычный размер' : 'Обычный размер. Нажмите, чтобы растянуть на всю ширину'; }
	});
	if (relayoutNow) window.dispatchEvent(new Event('resize'));
}

function syncPins(view) {
	const pins = loadPins();
	cardsOf(view).forEach(sec => {
		const on = pins.includes(titleOf(sec));
		sec.classList.toggle('nf-pinned', on);
		const b = sec.querySelector(':scope > .cbi-title .nf-pin');
		if (b) { b.setAttribute('aria-pressed', String(on)); b.title = on ? 'Открепить' : 'Закрепить вверху'; }
	});
}

function decorateCards(view) {
	const persist = () => saveOrder(cardsOf(view).map(titleOf));

	cardsOf(view).forEach(sec => {
		if (sec.hasAttribute('data-nf-card')) { if (sec.__nfRs && sec.__nfRs.parentNode !== sec) sec.appendChild(sec.__nfRs); return; }   /* LuCI может пересобрать содержимое: возвращаем уголок на место */
		sec.setAttribute('data-nf-card', '1');

		const h3 = sec.querySelector(':scope > .cbi-title h3');
		const tn = h3.firstChild;
		if (!tn || tn.nodeType !== 3) return;

		const title = tn.data.trim();
		h3.setAttribute('data-nf-title', title);
		const grip = E('span', {
			class: 'nf-grip', role: 'button', tabindex: '0', title: 'Потяните, чтобы переместить карточку (или нажмите ↑ ↓ на этом значке)',
			'aria-label': 'Переместить карточку «' + title + '»'
		}, '⋮⋮');
		const pin = E('button', { type: 'button', class: 'nf-pin', title: 'Закрепить вверху', 'aria-label': 'Закрепить карточку «' + title + '»', 'aria-pressed': 'false' });
		pin.addEventListener('click', ev => {
			ev.preventDefault(); ev.stopPropagation();
			const pins = loadPins().filter(t => t !== title);
			if (!loadPins().includes(title)) pins.push(title);
			savePins(pins);
			syncPins(view);
			flip(cardsOf(view), () => sortCards(view, loadOrder()));
		});
		const size = E('button', { type: 'button', class: 'nf-size', 'data-s': '', 'aria-label': 'Размер карточки «' + title + '»' });
		size.addEventListener('click', ev => {
			ev.preventDefault(); ev.stopPropagation();
			const m = Object.assign({}, loadSizes()), cur = m[title] || '';
			const nx = cur === '' ? 'wide' : cur === 'wide' ? 'min' : '';
			if (nx) m[title] = nx; else delete m[title];
			saveSizes(m);
			syncSizes(view, true);
		});
		h3.replaceChild(E('span', { class: 'nf-ttl' }, [ grip, E('i', { class: 'nf-ci', 'data-i': iconFor(title), 'aria-hidden': 'true' }), title, pin, size ]), tn);

		const hb = h3.querySelector(':scope > .label[data-indicator], :scope > .cbi-button, :scope > button');
		if (hb) {
			const sync = () => {
				const tx = (hb.textContent || '').trim();
				if (tx) { hb.setAttribute('title', tx); hb.setAttribute('aria-label', tx); }
				hb.classList.toggle('nf-show', /показ|разв|show|unhide/i.test(tx));
			};
			sync(); hb.addEventListener('mouseenter', sync); hb.addEventListener('focus', sync);
			hb.addEventListener('click', () => { window.setTimeout(sync, 60); window.setTimeout(sync, 400); });
		}

		grip.addEventListener('pointerdown', ev => {
			if (DRAG || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
			ev.preventDefault();
			const x0 = ev.clientX, y0 = ev.clientY;
			const probe = e => {
				if (Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) < 4) return;
				drop();
				startDrag(view, sec, e, persist);
			};
			const drop = () => { window.removeEventListener('pointermove', probe); window.removeEventListener('pointerup', drop); window.removeEventListener('pointercancel', drop); };
			window.addEventListener('pointermove', probe);
			window.addEventListener('pointerup', drop);
			window.addEventListener('pointercancel', drop);
		});

		/* уголок для растягивания: вправо/влево меняет ширину (одна колонка или вся ширина), вниз/вверх высоту */
		const rs = E('span', { class: 'nf-rs', role: 'slider', tabindex: '0', 'aria-label': 'Размер карточки «' + title + '»: стрелки меняют ширину и высоту, Delete сбрасывает',
			title: 'Потяните, чтобы изменить размер. Двойное нажатие сбрасывает.' });
		sec.appendChild(rs); sec.__nfRs = rs;
		const setH = (px, save) => {
			const m = Object.assign({}, loadHeights());
			if (px) m[title] = Math.round(px); else delete m[title];
			if (save) saveHeights(m);
			sec.style.minHeight = px ? Math.round(px) + 'px' : '';
			sec.classList.toggle('nf-fixh', !!px);
		};
		const setW = wide => {
			const m = Object.assign({}, loadSizes());
			if (wide) m[title] = 'wide'; else delete m[title];
			saveSizes(m);
			syncSizes(view, true);
		};
		rs.addEventListener('pointerdown', ev => {
			if (ev.pointerType === 'mouse' && ev.button !== 0) return;
			ev.preventDefault(); ev.stopPropagation();
			const x0 = ev.clientX, y0 = ev.clientY, h0 = sec.getBoundingClientRect().height, wide0 = sec.classList.contains('nf-wide');
			const multi = window.matchMedia('(min-width: 900px)').matches;
			rs.setPointerCapture(ev.pointerId);
			sec.classList.add('nf-resizing');
			let moved = false;
			const mv = e => {
				const dy = e.clientY - y0, dx = e.clientX - x0;
				if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
				if (!moved) return;
				setH(Math.max(90, h0 + dy), false);
				if (multi) {
					if (!wide0 && dx > 70) sec.classList.add('nf-wide');
					else if (wide0 && dx < -70) sec.classList.remove('nf-wide');
					else sec.classList.toggle('nf-wide', wide0);
				}
				window.dispatchEvent(new Event('resize'));
			};
			const up = () => {
				rs.removeEventListener('pointermove', mv); rs.removeEventListener('pointerup', up); rs.removeEventListener('pointercancel', up);
				sec.classList.remove('nf-resizing');
				if (!moved) return;   /* простое нажатие ничего не запоминает */
				const hh = Math.round(sec.getBoundingClientRect().height);
				saveHeights(Object.assign({}, loadHeights(), { [title]: Math.max(90, hh) }));
				const m = Object.assign({}, loadSizes());
				if (sec.classList.contains('nf-wide')) m[title] = 'wide'; else if (m[title] === 'wide') delete m[title];
				saveSizes(m);
				syncSizes(view, true);
			};
			rs.addEventListener('pointermove', mv); rs.addEventListener('pointerup', up); rs.addEventListener('pointercancel', up);
		});
		rs.addEventListener('dblclick', () => { setH(0, true); setW(false); });
		rs.addEventListener('keydown', ev => {
			const cur = sec.getBoundingClientRect().height;
			if (ev.key === 'ArrowRight') setW(true);
			else if (ev.key === 'ArrowLeft') setW(false);
			else if (ev.key === 'ArrowDown') setH(cur + 40, true);
			else if (ev.key === 'ArrowUp') setH(Math.max(90, cur - 40), true);
			else if (ev.key === 'Delete' || ev.key === 'Backspace' || ev.key === 'Home') { setH(0, true); setW(false); }
			else return;
			ev.preventDefault(); window.dispatchEvent(new Event('resize'));
		});

		grip.addEventListener('keydown', ev => {
			if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
			ev.preventDefault();
			const list = cardsOf(view), i = list.indexOf(sec);
			let ok = false;
			if (ev.key === 'ArrowUp' && i > 0) { flip(list, () => view.insertBefore(sec, list[i - 1])); ok = true; }
			else if (ev.key === 'ArrowDown' && i < list.length - 1) { flip(list, () => view.insertBefore(list[i + 1], sec)); ok = true; }
			if (!ok) return;
			grip.focus();
			persist();
		});
	});
}

/* ---------- status badges ---------- */

function signalLevel(dbm) {
	if (dbm >= -60) return [ 'ok', 'Отличный' ];
	if (dbm >= -70) return [ 'ok', 'Хороший' ];
	if (dbm >= -80) return [ 'warn', 'Слабый' ];
	return [ 'bad', 'Плохой' ];
}

/* Идемпотентно: вызывается синхронно из MutationObserver (до отрисовки кадра),
   поэтому «сырой» текст LuCI («нет соединения», «1 GbE») ни разу не попадает на экран. */
function enhanceBadges(view) {
	/* Wi-Fi clients: signal strength */
	view.querySelectorAll('.ifacebadge[data-signal]').forEach(b => {
		const raw = b.getAttribute('data-signal');
		const have = b.querySelector(':scope > .nf-badge');
		if (have && b.getAttribute('data-nf-q') === raw) return;
		const dbm = parseInt(raw, 10);
		b.setAttribute('data-nf-q', raw);
		if (!isFinite(dbm)) return;
		const [ kind, text ] = signalLevel(dbm);
		if (have) { have.className = 'nf-badge ' + kind; if (have.textContent !== text) have.textContent = text; }
		else b.appendChild(badge(kind, text));
	});

	/* port boxes: link state next to the speed */
	view.querySelectorAll('.ifacebox').forEach(box => {
		const img = box.querySelector('.ifacebox-body > img[src*="port_"], .ifacebox-body > img[src*="/pse_"]');
		if (!img) return;
		const up = /_up\.svg/.test(img.getAttribute('src'));
		const state = up ? 'up' : 'down';
		if (box.getAttribute('data-nf-port') !== state) box.setAttribute('data-nf-port', state);
		const body = img.parentNode, node = body.lastChild;
		if (!node || node === img || node.nodeName === 'BR') return;
		if (node.nodeType === 3) {
			const raw = node.data.trim();
			if (!raw) return;
			let txt = raw;
			if (!up && /соедин|no link|not connected|disconnected|нет/i.test(txt)) txt = 'нет связи';
			const bd = badge(up ? 'ok' : 'off', txt);
			bd.title = raw;
			body.replaceChild(bd, node);
		}
		else if (!node.classList.contains('nf-badge') || !node.classList.contains(up ? 'ok' : 'off')) {
			node.classList.remove('ok', 'off');
			node.classList.add('nf-badge', up ? 'ok' : 'off');
		}
	});
}

/* ---------- dense grid layout: each card spans N rows of 8px ---------- */

/* Раскладка карточек по столбцам. Считаем здесь, а не в таблице стилей: так работает независимо от того, какие классы LuCI успел навесить.
   «Авто» повторяет прежние правила: 2 столбца, 3 при «Компактных» на экране от 1700 px, 1 при «Крупных» или «Один столбец». */
function applyColumns(view, relayout) {
	const root = document.documentElement, pref = root.getAttribute('data-nf-ov-cols') || '0';
	const size = root.getAttribute('data-nf-ov-size') || 'md', wideOn = root.getAttribute('data-nf-ov-wide') === 'on';
	const w = window.innerWidth;
	let n = pref === '1' || pref === '2' || pref === '3' ? +pref : (size === 'lg' || wideOn ? 1 : size === 'sm' && w >= 1700 ? 3 : 2);
	if (w < 900) n = 0;
	const imp = (el, k, v) => el.style.setProperty(k, v, 'important');
	const clear = (el, ks) => ks.forEach(k => el.style.removeProperty(k));
	const kids = Array.from(view.children).filter(c => c.nodeType === 1);
	if (!n) {
		clear(view, [ 'display', 'grid-template-columns', 'grid-auto-rows', 'grid-auto-flow', 'column-gap', 'row-gap', 'align-items', 'column-count' ]);
		kids.forEach(c => { clear(c, [ 'grid-column', 'margin', 'align-self', 'min-width', 'width', 'break-inside', 'column-span' ]); c.style.gridRowEnd = ''; });
		if (relayout) relayout();
		return;
	}
	/* плотная сетка: ряды по 8 px, карточка занимает столько рядов, сколько ей нужно; dense подтягивает следующие карточки в свободные места */
	imp(view, 'display', 'grid'); imp(view, 'column-count', 'auto'); imp(view, 'grid-template-columns', 'repeat(' + n + ', minmax(0, 1fr))');
	imp(view, 'grid-auto-rows', '8px'); imp(view, 'grid-auto-flow', 'row dense'); imp(view, 'column-gap', '16px'); imp(view, 'row-gap', '0'); imp(view, 'align-items', 'start');
	kids.forEach(c => {
		const card = c.classList.contains('cbi-section') && !c.classList.contains('nf-live');
		const span = !card || (n > 1 && (c.classList.contains('nf-wide') || !!c.querySelector('.table .th:nth-child(5)')));
		clear(c, [ 'break-inside', 'column-span', 'width' ]);
		imp(c, 'grid-column', span ? '1 / -1' : 'auto'); imp(c, 'min-width', '0'); imp(c, 'align-self', 'start');
		if (card || c.classList.contains('nf-live')) imp(c, 'margin', '0');
	});
	if (relayout) relayout();
}

function gridLayout(view) {
	const ROW = 8, GAP = 16;
	let raf = 0;
	const ro = new ResizeObserver(() => schedule());
	const seen = new WeakSet();

	function apply() {
		raf = 0;
		const grid = window.getComputedStyle(view).display === 'grid';
		Array.from(view.children).forEach(el => {
			if (el.nodeType !== 1 || window.getComputedStyle(el).display === 'none') return;
			if (!seen.has(el)) { seen.add(el); ro.observe(el); }
			if (!grid) { el.style.gridRowEnd = ''; return; }
			const h = el.getBoundingClientRect().height;
			el.style.gridRowEnd = 'span ' + Math.max(1, Math.ceil((h + GAP) / ROW));
		});
	}
	function schedule() { if (!raf) raf = window.requestAnimationFrame(apply); }

	window.addEventListener('resize', schedule);
	return schedule;
}



/* ---------- плашка «Новое устройство в сети»: по событиям сборщика за последние сутки ---------- */
function newDevBanner() {
	const el = E('div', { class: 'nf-newdev', hidden: 'hidden' });
	let timer = null;
	const seenKey = 'nightfall-newdev-seen';
	const seen = () => { try { return parseInt(localStorage.getItem(seenKey), 10) || 0; } catch (e) { return 0; } };
	const mark = ts => { try { localStorage.setItem(seenKey, String(ts)); } catch (e) { /* ignore */ } };
	function load() {
		if (document.hidden) return;
		fs.exec(HIST, [ 'series', 'fine' ]).then(res => {
			let h = null;
			try { h = JSON.parse(res.stdout); } catch (e) { /* no collector */ }
			const now = Date.now() / 1000, last = seen();
			const ev = ((h && h.events) || []).filter(e => typeof e[2] === 'string' && e[2].indexOf('Новое устройство в сети:') === 0 && e[0] > last && now - e[0] < 86400);
			if (!ev.length) { el.hidden = true; return; }
			const lastEv = ev[ev.length - 1], txt = lastEv[2].replace('Новое устройство в сети:', '').trim();
			const mac = (txt.match(/([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/) || [])[1];
			const priv = /частный адрес/.test(txt);
			const name = txt.split(',')[0].trim();
			const acts = [ E('button', { type: 'button', class: 'nf-linkbtn', click: () => { mark(Math.ceil(lastEv[0])); el.hidden = true; } }, 'Это моё') ];
			if (mac) acts.push(E('button', { type: 'button', class: 'nf-linkbtn nf-bad', click: ev2 => {
				const b = ev2.currentTarget; b.disabled = true;
				fs.exec(BLOCKBIN, [ 'block', mac, name === 'без имени' ? '' : name ]).then(() => { mark(Math.ceil(lastEv[0])); el.hidden = true; }).catch(() => { b.disabled = false; });
			} }, 'Отключить интернет'));
			el.replaceChildren(E('span', { class: 'nf-newdev-i', 'aria-hidden': 'true' }, '🆕'),
				E('div', { class: 'nf-newdev-t' }, [ E('b', {}, ev.length > 1 ? 'Новых устройств: ' + ev.length + '. Последнее:' : 'Новое устройство в сети'), E('span', {}, txt.replace(/\s*\(частный.*$/, '')) , priv ? E('span', { class: 'nf-newdev-n' }, 'Частный адрес Wi-Fi: у телефона он может меняться.') : '' ]),
				E('div', { class: 'nf-newdev-a' }, acts));
			el.hidden = false;
		}).catch(() => {});
	}
	return { el, start() { load(); timer = window.setInterval(load, 30000); } };
}

/* ---------- top clients card ---------- */

function fmtBytes(b) {
	const u = [ 'Б', 'КБ', 'МБ', 'ГБ', 'ТБ' ];
	let i = 0;
	while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
	return (i < 2 ? nf0 : nf2).format(b) + ' ' + u[i];
}

function normIp(ip) {
	if (ip.indexOf(':') < 0) return ip;
	const h = ip.toLowerCase().split('::');
	const a = h[0] ? h[0].split(':') : [], b = h.length > 1 && h[1] ? h[1].split(':') : [];
	const mid = h.length > 1 ? new Array(Math.max(0, 8 - a.length - b.length)).fill('0') : [];
	return a.concat(mid, b).map(g => g.padStart(4, '0')).join(':');
}

/* мини-график строки: values — массив чисел (старые слева); рисуется ломаной с заливкой */
function miniSpark(vals, cls) {
	const W = 100, H = 22, n = vals.length;
	if (n < 2) return '';
	const mx = Math.max(1, ...vals);
	const pts = vals.map((v, i) => [ (i / (n - 1) * W).toFixed(1), (H - 2 - (v / mx) * (H - 4)).toFixed(1) ]);
	const line = 'M' + pts.map(p => p.join(' ')).join('L');
	return '<svg class="nf-msp ' + cls + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true"><path class="a" d="' + line + 'L' + W + ' ' + H + 'L0 ' + H + 'Z"/><path class="l" d="' + line + '"/></svg>';
}

/* порядок дочерних узлов без лишнего «выдёргивания»: на месте стоящие строки не пересоздаются, их числа и графики обновляются плавно */
function syncChildren(parent, nodes) {
	nodes.forEach((nd, i) => { if (parent.children[i] !== nd) parent.insertBefore(nd, parent.children[i] || null); });
	while (parent.children.length > nodes.length) parent.lastElementChild.remove();
}

function topCard() {
	const body = E('div', { class: 'nf-top-b' }, E('div', { class: 'nf-empty' }, 'Собираю данные…'));
	let mode = 'now';
	try { mode = localStorage.getItem('nightfall-top-mode') === 'day' ? 'day' : 'now'; } catch (e) { /* ignore */ }
	const modeBtns = [ [ 'now', 'Сейчас' ], [ 'day', 'За сутки' ] ].map(([ k, t ]) => E('button', { type: 'button', class: 'nf-linkbtn' + (k === mode ? ' on' : ''), 'data-m': k,
		click: ev => { ev.stopPropagation(); mode = k; try { localStorage.setItem('nightfall-top-mode', k); } catch (e) { /* ignore */ } modeBtns.forEach(b => b.classList.toggle('on', b.getAttribute('data-m') === k)); render(last); } }, t));
	const el = E('div', { class: 'cbi-section nf-top fade-in' }, [
		E('div', { class: 'cbi-title nf-top-t' }, [ E('h3', {}, 'Топ клиентов'), E('span', { class: 'nf-top-m', role: 'group', 'aria-label': 'Период' }, modeBtns) ]), body ]);
	let names = null, timer = null, DEVID = null, hrRows = null, hrAt = 0;
	const live = {};            /* ключ устройства → последние замеры скорости (байт/с), для мини-графика «Сейчас» */
	const rowsEl = new Map();   /* ключ → { el, parts }: строки живут между обновлениями */
	L.require('nightfall-devid').then(m => { DEVID = m; if (last) render(last); }).catch(() => { /* пакет монитора без модуля: без значков */ });

	let last = null;

	function render(dv) {
		if (EDITING) return;
		last = dv;
		if (!dv || !Array.isArray(dv.rate)) {
			rowsEl.clear();
			body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Нет данных'), E('span', {}, 'Сбор статистики по устройствам не запущен.') ]));
			return;
		}
		const ipName = {};
		for (const mac in names || {})
			for (const ip of (names[mac].ipaddrs || []).concat(names[mac].ip6addrs || []))
				ipName[normIp(ip)] = { n: names[mac].name || mac, k: mac.toUpperCase(), h: names[mac].name || '' };
		/* адрес → MAC по таблице соседей роутера (ip neigh): узнаём устройства без имени в DHCP и с временными адресами IPv6 */
		const neigh = {};
		for (const [ ip, mac ] of dv.neigh || []) neigh[normIp(ip)] = mac.toUpperCase();
		/* адреса самого роутера: текущие, прежние внешние и вся внешняя подсеть провайдера (адрес меняется) */
		const routerIps = String((dv.info && dv.info.router_ips) || '').split(/\s+/).filter(Boolean), routerNets = [];
		const ip4 = ip => { const a = String(ip).split('.'); return a.length === 4 && a.every(x => /^\d+$/.test(x)) ? ((+a[0] * 256 + +a[1]) * 256 + +a[2]) * 256 + +a[3] : -1; };
		String((dv.info && dv.info.router_nets) || '').split(/\s+/).filter(Boolean).forEach(c => { const [ ip, bits ] = c.split('/'), b = ip4(ip), sz = Math.pow(2, 32 - (+bits || 32)); if (b >= 0) routerNets.push([ b - b % sz, sz ]); });
		const isRouter = ip => { if (routerIps.includes(ip)) return true; const x = ip4(ip); return x >= 0 && routerNets.some(([ b, sz ]) => x >= b && x < b + sz); };
		const rows = {};
		const keyOf = ip => {
			if (isRouter(ip)) return 'router';
			const nm = ipName[normIp(ip)];
			return nm ? nm.k : neigh[normIp(ip)] || ip;
		};
		const row = ip => {
			const k = keyOf(ip), nm = ipName[normIp(ip)];
			return rows[k] || (rows[k] = { k, name: k === 'router' ? 'Роутер' : nm ? nm.n : ip, host: nm ? nm.h : '', ip, rd: 0, ru: 0, dd: 0, du: 0 });
		};
		const fresh = dv.now - dv.ts <= 60;
		if (fresh) for (const [ ip, d, u ] of dv.rate) { const r = row(ip); r.rd += d; r.ru += u; }
		for (const [ ip, d, u ] of dv.day || []) { const r = row(ip); r.dd += d; r.du += u; }
		/* замеры для мини-графика «Сейчас»: каждое обновление — одна точка, у кого трафика нет — ноль */
		for (const k in live) if (!rows[k]) live[k].push(0);
		for (const k in rows) (live[k] || (live[k] = [])).push(rows[k].rd + rows[k].ru);
		for (const k in live) { if (live[k].length > 40) live[k].shift(); if (!rows[k] && live[k].every(v => v === 0)) delete live[k]; }
		/* по часам за сутки: из почасовых итогов сборщика (devhr), номер часа считаем от текущего момента */
		const hourly = {};
		for (const [ ts, ip, d, u ] of hrRows || []) {
			const i = Math.floor((dv.now - ts) / 3600);
			if (i < 0 || i > 23) continue;
			const a = hourly[keyOf(ip)] || (hourly[keyOf(ip)] = new Array(24).fill(0));
			a[23 - i] += d + u;
		}
		/* трафик самого роутера (VPN, прокси) повторяет трафик устройств, поэтому в рейтинге «за сутки» и в долях его нет; в «Сейчас» он виден: так заметно, что роутер что-то качает */
		const all = Object.values(rows).filter(r => r.rd + r.ru + r.dd + r.du > 0 && !(mode === 'day' && r.k === 'router')), dayTot = all.reduce((t, r) => t + r.dd + r.du, 0) || 1;
		const list = mode === 'day'
			? all.sort((a, b) => (b.dd + b.du) - (a.dd + a.du) || (b.rd + b.ru) - (a.rd + a.ru)).slice(0, 8)
			: all.sort((a, b) => (b.rd + b.ru) - (a.rd + a.ru) || (b.dd + b.du) - (a.dd + a.du)).slice(0, 5);
		if (!list.length) {
			rowsEl.clear();
			body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Пока тихо'), E('span', {}, 'Сейчас нет заметного трафика от устройств.') ]));
			return;
		}
		if (body.firstElementChild && body.firstElementChild.classList.contains('nf-empty')) body.replaceChildren();
		const val = r => mode === 'day' ? r.dd + r.du : r.rd + r.ru, mx = Math.max(1, ...list.map(val));
		const seen = new Set();
		const nodes = list.map(r => {
			seen.add(r.k);
			let rw = rowsEl.get(r.k);
			if (!rw) {
				rw = { nbox: E('div', { class: 'nf-top-n' }), sp: E('div', { class: 'nf-top-sp' }), bar: E('i'), dn: E('span'), up: E('span'), tot: E('b'), lbl: E('span') };
				rw.el = E('div', { class: 'nf-top-r' }, [
					rw.nbox,
					E('div', { class: 'nf-top-g' }, [ rw.sp, E('div', { class: 'nf-top-bar' }, rw.bar) ]),
					E('div', { class: 'nf-top-v' }, [ rw.dn, rw.up ]),
					E('div', { class: 'nf-top-d' }, [ rw.tot, rw.lbl ]) ]);
				rowsEl.set(r.k, rw);
			}
			const canName = r.k !== 'router' && /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(r.k);
			const custom = canName ? loadNames()[nameKey(r.k)] : '';
			const id = DEVID && canName ? DEVID.identify(r.k, r.host) : null;
			/* имя: своё → из DHCP → вид устройства по MAC → адрес */
			const shown = custom || (r.name !== r.ip ? r.name : (id && id.label && id.known ? id.label : r.name));
			const sub = [ custom ? r.name : '', shown === r.ip ? '' : r.ip, id && id.vendor ? id.vendor : '', id && id.priv ? 'частный MAC' : '' ].filter(Boolean);
			const sig = [ shown, sub.join('|'), canName ? 1 : 0, id ? id.kind : '' ].join('\n');
			if (rw.sig !== sig || !rw.nbox.firstChild || rw.nbox.querySelector('.nf-rename')) {
				rw.sig = sig;
				const nameEl = E('b', { title: (id && id.hint ? id.hint + '\n' : '') + r.k }, E('span', { class: 'nf-dv-t' }, shown));
				if (id) {
					const ic = E('i', { class: 'nf-dv-i' + (id.priv ? ' priv' : '') }); ic.innerHTML = DEVID.icon(id.kind);
					nameEl.insertBefore(ic, nameEl.firstChild);
				}
				rw.nbox.replaceChildren(nameEl, E('span', {}, sub.join(' · ')));
				if (canName) nameEl.appendChild(E('button', { type: 'button', class: 'nf-edit', title: 'Своё имя', 'aria-label': 'Переименовать «' + shown + '»',
					click: ev => { ev.stopPropagation(); editName(rw.nbox, r.k, r.name, () => { rw.sig = ''; render(last); }); } }));
			}
			rw.bar.style.width = Math.max(2, Math.round(val(r) / mx * 100)) + '%';
			const dn = fmtRate(r.rd), up = fmtRate(r.ru);
			setNum(rw.dn, '↓ ' + dn[0] + ' ' + dn[1]); setNum(rw.up, '↑ ' + up[0] + ' ' + up[1]);
			setNum(rw.tot, fmtBytes(r.dd + r.du));
			rw.lbl.textContent = 'за день' + (mode === 'day' ? ' · ' + Math.max(1, Math.round((r.dd + r.du) / dayTot * 100)) + '%' : '');
			const series = mode === 'day' ? hourly[r.k] : live[r.k];
			rw.sp.innerHTML = series && series.some(v => v > 0) ? miniSpark(series, mode === 'day' ? 'h' : 'n') : '';
			rw.sp.title = mode === 'day' ? 'Трафик по часам за сутки' : 'Скорость за последние минуты';
			return rw.el;
		});
		for (const k of Array.from(rowsEl.keys())) if (!seen.has(k)) rowsEl.delete(k);
		syncChildren(body, nodes);
	}

	function load() {
		if (document.hidden || window.getComputedStyle(el).display === 'none') return;
		const needHr = Date.now() - hrAt > 300000;
		Promise.all([ fs.exec(HIST, [ 'devices' ]), names ? null : L.resolveDefault(callHints(), {}), needHr ? L.resolveDefault(fs.exec(HIST, [ 'devhr' ]), null) : null ]).then(r => {
			if (r[1]) names = r[1];
			if (needHr) { hrAt = Date.now(); try { hrRows = JSON.parse(r[2].stdout).rows; } catch (e) { /* старый сборщик без devhr */ } }
			let dv = null;
			try { dv = JSON.parse(r[0].stdout); } catch (e) { /* no collector */ }
			render(dv);
		}).catch(() => render(null));
	}

	return { el, contains: n => el.contains(n), start() { load(); timer = window.setInterval(load, 8000); } };
}

/* ---------- traffic by application (YouTube, Telegram…) ---------- */

/* значки приложений: простые линейные символы по типу сервиса (не логотипы компаний) */
const APP_SHAPES = {
	play: [ [ 'rect', { x: 3, y: 5, width: 18, height: 14, rx: 4 } ], [ 'path', { d: 'M10 9.5v5l4.5-2.5z' } ] ],
	chat: [ [ 'path', { d: 'M4 5h16v11H9l-5 4z' } ] ],
	camera: [ [ 'rect', { x: 3, y: 3, width: 18, height: 18, rx: 5 } ], [ 'circle', { cx: 12, cy: 12, r: 4 } ], [ 'circle', { cx: 17.2, cy: 6.8, r: .6 } ] ],
	people: [ [ 'circle', { cx: 9, cy: 8, r: 3 } ], [ 'path', { d: 'M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6' } ], [ 'circle', { cx: 17, cy: 9, r: 2.4 } ], [ 'path', { d: 'M16 14.2c2.8.2 5 2.4 5 5.3' } ] ],
	music: [ [ 'path', { d: 'M9 18V6l10-2v12' } ], [ 'circle', { cx: 6.5, cy: 18, r: 2.5 } ], [ 'circle', { cx: 16.5, cy: 16, r: 2.5 } ] ],
	video: [ [ 'rect', { x: 3, y: 6, width: 12, height: 12, rx: 2 } ], [ 'path', { d: 'M15 10l6-3v10l-6-3' } ] ],
	game: [ [ 'rect', { x: 2, y: 8, width: 20, height: 9, rx: 4.5 } ], [ 'path', { d: 'M7 12.5h3M8.5 11v3' } ], [ 'circle', { cx: 15.5, cy: 12, r: .6 } ], [ 'circle', { cx: 17.5, cy: 13.5, r: .6 } ] ],
	search: [ [ 'circle', { cx: 11, cy: 11, r: 6.5 } ], [ 'path', { d: 'M16 16l5 5' } ] ],
	cloud: [ [ 'path', { d: 'M7 18a4 4 0 0 1-.6-7.95A6 6 0 0 1 18 9.5 4.3 4.3 0 0 1 17.5 18z' } ] ],
	apps: [ [ 'rect', { x: 3, y: 3, width: 8, height: 8, rx: 2 } ], [ 'rect', { x: 13, y: 3, width: 8, height: 8, rx: 2 } ], [ 'rect', { x: 3, y: 13, width: 8, height: 8, rx: 2 } ], [ 'rect', { x: 13, y: 13, width: 8, height: 8, rx: 2 } ] ],
	globe: [ [ 'circle', { cx: 12, cy: 12, r: 9 } ], [ 'path', { d: 'M3 12h18M12 3c2.6 2.4 4 5.4 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.4-4-9s1.4-6.6 4-9z' } ] ]
};
const APP_GLYPH = { 'YouTube': 'play', 'Netflix': 'play', 'Twitch': 'play', 'Telegram': 'chat', 'WhatsApp': 'chat', 'Discord': 'chat', 'ВКонтакте': 'people', 'Facebook': 'people', 'X (Twitter)': 'chat',
	'Instagram': 'camera', 'TikTok': 'music', 'Spotify': 'music', 'Zoom': 'video', 'Steam': 'game', 'Яндекс': 'search', 'Google': 'search', 'Cloudflare': 'cloud', 'Amazon': 'cloud', 'Apple': 'apps', 'Microsoft': 'apps' };
function appGlyph(name) {
	const el = SVG('svg', { viewBox: '0 0 24 24', width: 18, height: 18, class: 'nf-ic', 'aria-hidden': 'true' }, (APP_SHAPES[APP_GLYPH[name] || 'globe']).map(sh => SVG(sh[0], sh[1])));
	return el;
}
const APP_COLORS = { 'YouTube': '#ff3b30', 'Telegram': '#2aabee', 'WhatsApp': '#25d366', 'Instagram': '#e1306c', 'Facebook': '#1877f2', 'TikTok': '#25c8c8',
	'Netflix': '#e50914', 'Twitch': '#9146ff', 'Spotify': '#1db954', 'Discord': '#5865f2', 'Zoom': '#2d8cff', 'Steam': '#66c0f4', 'ВКонтакте': '#0077ff',
	'Яндекс': '#fc3f1d', 'Google': '#4285f4', 'Apple': '#a2aaad', 'Microsoft': '#00a4ef', 'Amazon': '#ff9900', 'X (Twitter)': '#8899a6', 'Cloudflare': '#f38020' };
const PERIODS = [ [ 'day', 'Сегодня', 1 ], [ 'week', '7 дней', 7 ], [ 'month', '30 дней', 30 ] ];

function ymd(d) { return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }

/* суммы по приложениям за период: today — строки «ip, приложение, вниз, вверх», hist — то же с датой первой колонкой.
   «Прочее · домен» сворачивается в «Прочее», а домены уходят в подробности (other). */
function sumApps(data, days, ip) {
	const tot = {}, other = {};
	const add = (a, d, u) => {
		const m = /^Прочее(?: · (.+))?$/.exec(a);
		if (m) {
			const t = other[m[1] || ''] || (other[m[1] || ''] = [ 0, 0 ]);
			t[0] += d; t[1] += u;
			a = 'Прочее';
		}
		const t = tot[a] || (tot[a] = [ 0, 0 ]);
		t[0] += d; t[1] += u;
	};
	for (const [ i, a, d, u ] of data.day || []) if (!ip || i === ip) add(a, d, u);
	if (days > 1) {
		const t = String(data.today || '');
		const base = /^\d{8}$/.test(t) ? new Date(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8)) : new Date();
		base.setDate(base.getDate() - (days - 1));
		const from = ymd(base);
		for (const [ dt, i, a, d, u ] of data.hist || []) if (+dt >= from && (!ip || i === ip)) add(a, d, u);
	}
	return { tot, other };
}

function appsCard() {
	const body = E('div', { class: 'nf-apps-b' }, E('div', { class: 'nf-empty' }, 'Собираю данные…'));
	const el = xcard('nf-apps', 'Трафик по приложениям', body);
	let names = null, timer = null, data = null, period = 'day', dev = '', busy = false;

	const run = cmd => fs.exec(APPSBIN, [ cmd ]).then(r => { try { return JSON.parse(r.stdout); } catch (e) { return null; } });

	function label(ip) {
		for (const mac in names || {}) {
			const n = names[mac];
			if ((n.ipaddrs || []).concat(n.ip6addrs || []).some(x => normIp(x) === normIp(ip)))
				return loadNames()[nameKey(mac)] || n.name || ip;
		}
		return ip;
	}

	function toggle(cmd, ask) {
		if (busy || (ask && !window.confirm(ask))) return;
		busy = true;
		body.replaceChildren(E('div', { class: 'nf-empty' }, cmd === 'enable' ? 'Включаю…' : 'Выключаю…'));
		run(cmd).then(r => {
			busy = false;
			if (!r || !r.ok) { body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Не получилось'), E('span', {}, (r && r.error) || 'Нет ответа от роутера. Выйдите и войдите снова (права обновляются при входе).') ])); return; }
			window.setTimeout(load, cmd === 'enable' ? 2500 : 500);
		}).catch(() => { busy = false; load(); });
	}

	function render() {
		if (EDITING || busy) return;
		if (!data || typeof data.enabled === 'undefined') {
			body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Нет данных'), E('span', {}, 'Сборщик статистики не запущен или не обновлён до версии с учётом приложений.') ]));
			return;
		}
		if (!data.enabled) {
			body.replaceChildren(E('div', { class: 'nf-apps-off' }, [
				E('b', {}, 'Сколько трафика у YouTube, Telegram и других'),
				E('span', {}, 'Роутер сопоставит адреса соединений с именами сайтов из DNS-запросов и покажет, кто сколько скачал. Для этого будет включён журнал DNS в dnsmasq: он пишется в память роутера (не на диск) и обрезается до 1 МБ. Выключить можно здесь же.'),
				E('button', { type: 'button', class: 'cbi-button cbi-button-action', click: () => toggle('enable', 'Включить учёт трафика по приложениям?\n\nБудет включён журнал DNS в dnsmasq (в памяти роутера) и dnsmasq перезапустится на пару секунд.') }, 'Включить учёт')
			]));
			return;
		}
		const p = PERIODS.find(x => x[0] === period) || PERIODS[0];
		const ips = {};
		for (const r of (data.day || [])) ips[r[0]] = 1;
		for (const r of (data.hist || [])) ips[r[1]] = 1;
		const sel = E('select', { class: 'nf-apps-dev', 'aria-label': 'Устройство', change: ev => { dev = ev.target.value; render(); } },
			[ E('option', { value: '' }, 'Все устройства') ].concat(Object.keys(ips).sort().map(ip => E('option', { value: ip }, label(ip) + (label(ip) === ip ? '' : ' · ' + ip)))));
		sel.value = dev && ips[dev] ? dev : '';
		if (sel.value !== dev) dev = sel.value;
		const seg = E('div', { class: 'nf-apps-seg', role: 'group', 'aria-label': 'Период' }, PERIODS.map(x =>
			E('button', { type: 'button', 'aria-pressed': String(x[0] === period), click: () => { period = x[0]; render(); } }, x[1])));

		const { tot, other } = sumApps(data, p[2], dev);
		const rows = Object.keys(tot).map(a => ({ a, d: tot[a][0], u: tot[a][1], t: tot[a][0] + tot[a][1] })).filter(r => r.t > 0).sort((x, y) => (x.a === 'Прочее') - (y.a === 'Прочее') || y.t - x.t);
		const sum = rows.reduce((n, r) => n + r.t, 0);
		const list = rows.slice(0, 9);
		const content = [];
		if (!list.length) {
			content.push(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Пока пусто'), E('span', {}, data.dnsmap > 0 ? 'Данных за этот период ещё нет.' : 'Журнал DNS пока пуст. Подождите несколько минут, пока устройства сделают запросы. Если ничего не появляется, проверьте, что устройства используют DNS роутера (а не DoH/DoT в браузере или телефоне).') ]));
		}
		else {
			const mx = Math.max(1, ...list.map(r => r.t));
			list.forEach(r => {
				content.push(E('div', { class: 'nf-apps-r', style: '--c:' + (APP_COLORS[r.a] || 'var(--nf-text-dim)') }, [
					E('div', { class: 'nf-apps-n' }, [ r.a === 'Прочее' ? E('i') : appGlyph(r.a), E('b', {}, r.a) ]),
					E('div', { class: 'nf-top-bar' }, E('i', { style: 'width:' + Math.max(2, Math.round(r.t / mx * 100)) + '%' })),
					E('div', { class: 'nf-apps-v' }, [ E('b', {}, fmtBytes(r.t)), E('span', {}, '↓ ' + fmtBytes(r.d) + ' · ↑ ' + fmtBytes(r.u)) ]),
					E('div', { class: 'nf-apps-p' }, sum ? nf0.format(r.t / sum * 100) + '%' : '')
				]));
				/* из чего состоит «Прочее»: самые тяжёлые домены (по ним можно добавить правило в /etc/nightfall-apps.list) */
				if (r.a === 'Прочее') {
					const top = Object.keys(other).map(k => ({ k: k || 'прямые адреса без имени', t: other[k][0] + other[k][1] })).filter(x => x.t > 0).sort((x, y) => y.t - x.t).slice(0, 6);
					if (top.length) content.push(E('div', { class: 'nf-apps-sub' }, [ E('span', {}, 'Крупнее всего:') ].concat(top.map(x => E('span', { class: 'nf-apps-chip', title: x.k }, [ x.k + ' ', E('b', {}, fmtBytes(x.t)) ])))));
				}
			});
		}
		body.replaceChildren(E('div', { class: 'nf-apps-bar' }, [ seg, sel ]), ...content,
			E('div', { class: 'nf-apps-f' }, [
				E('span', {}, 'Всего ' + fmtBytes(sum) + '. Данные приблизительные: трафик через VPN и шифрованный DNS определить нельзя.'),
				E('button', { type: 'button', class: 'nf-link', click: () => toggle('disable', 'Выключить учёт трафика по приложениям?\n\nЖурнал DNS в dnsmasq будет возвращён к прежним настройкам.') }, 'Выключить учёт')
			]));
	}

	function load() {
		if (idle(el) || busy || EDITING) return;
		Promise.all([ fs.exec(HIST, [ 'apps' ]), names ? null : L.resolveDefault(callHints(), {}) ]).then(r => {
			if (r[1]) names = r[1];
			try { data = JSON.parse(r[0].stdout); } catch (e) { data = null; }
			render();
		}).catch(() => { data = null; render(); });
	}

	return { el, contains: n => el.contains(n), start() { load(); timer = window.setInterval(load, 15000); } };
}

/* ---------- «Доступ в интернет»: отключение устройств вручную и по расписанию ---------- */

const BLOCKBIN = '/usr/libexec/nightfall-block';
const GUESTBIN = '/usr/libexec/nightfall-guest';
const WOLBIN = '/usr/libexec/nightfall-wol';

function blockCard() {
	const body = E('div', { class: 'nf-blk-b' }, E('div', { class: 'nf-empty' }, 'Собираю данные…'));
	const head = E('div', { class: 'nf-blk-h', hidden: true });
	const el = xcard('nf-block', 'Доступ в интернет', E('div', {}, [ head, body ]));
	let timer = null, devs = null, busy = false, open = null, note = '', logOn = false, logRows = null;
	let tab = 'all', qs = '', more = false, checking = false, checkedAt = 0, DEVID = null;
	try { tab = localStorage.getItem('nightfall-blk-tab') || 'all'; } catch (e) { /* ignore */ }
	L.require('nightfall-devid').then(m => { DEVID = m; if (devs) render(); }).catch(() => { /* пакет монитора без модуля: без значков */ });
	const search = E('input', { type: 'search', class: 'nf-blk-q', placeholder: 'Найти устройство', 'aria-label': 'Найти устройство', input: () => { qs = search.value.trim().toLowerCase(); more = false; render(); } });
	const tabsEl = E('div', { class: 'nf-blk-tabs', role: 'group', 'aria-label': 'Показать устройства' });
	const chkBtn = E('button', { type: 'button', class: 'nf-linkbtn', title: 'Роутер заново проверит, кто сейчас подключён: Wi-Fi по подключению к точке доступа, кабельные по ответу на запрос ARP', click: () => { if (checking) return; checking = true; renderHead(); load(true); } }, 'Проверить сейчас');
	const chkNote = E('span', { class: 'nf-blk-chk' });
	head.append(tabsEl, E('div', { class: 'nf-blk-tools' }, [ search, chkBtn, chkNote ]));
	const nmOf = d => {
		const id = DEVID && d.mac ? DEVID.identify(d.mac, d.name) : null;
		return { id, nm: d.name || (id && id.known ? [ id.label || 'Устройство', id.vendor && id.vendor !== id.label ? id.vendor : '' ].filter(Boolean).join(' ') : '') || d.ip || d.mac };
	};
	const hasRule = d => !!(d.active || d.from || d.quota || d.manual);
	function renderHead() {
		const all = devs || [];
		const groups = Array.from(new Set(all.map(d => d.group).filter(Boolean))).sort();
		const defs = [ [ 'all', 'Все', all.length ], [ 'on', 'В сети', all.filter(d => d.online).length ], [ 'off', 'Не в сети', all.filter(d => !d.online).length ], [ 'rule', 'С правилами', all.filter(hasRule).length ] ]
			.concat(groups.map(g => [ 'g:' + g, g, all.filter(d => d.group === g).length ]));
		const shown = defs.filter(x => x[0] === 'all' || x[0] === tab || x[2] > 0);
		tabsEl.replaceChildren(...shown.map(x => E('button', { type: 'button', class: 'nf-linkbtn' + (tab === x[0] ? ' on' : ''), 'aria-pressed': String(tab === x[0]),
			click: () => { tab = x[0]; more = false; try { localStorage.setItem('nightfall-blk-tab', tab); } catch (e) { /* ignore */ } render(); } }, [ x[1], E('i', {}, String(x[2])) ])));
		search.hidden = all.length < 8 && !qs;
		chkBtn.disabled = checking; chkBtn.classList.toggle('spin', checking); chkBtn.textContent = checking ? 'Проверяю…' : 'Проверить сейчас';
		chkNote.textContent = checkedAt ? 'проверено в ' + new Date(checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
		head.hidden = !all.length;
	}

	const run = args => fs.exec(BLOCKBIN, args).then(r => { try { return JSON.parse(r.stdout); } catch (e) { return null; } });

	function act(args, okNote) {
		if (busy) return;
		busy = true;
		run(args).then(r => {
			busy = false;
			note = r && r.ok ? okNote : ((r && r.error) || 'Нет ответа от роутера. Выйдите и войдите в LuCI снова (права обновляются при входе).');
			open = r && r.ok ? null : open;
			load(true);
		}).catch(() => { busy = false; note = 'Не получилось выполнить команду.'; load(true); });
	}

	function sched(d) {
		const from = E('input', { type: 'time', value: d.from || '23:00', 'aria-label': 'Отключать с' });
		const to = E('input', { type: 'time', value: d.to || '07:00', 'aria-label': 'Включать в' });
		return E('div', { class: 'nf-blk-sched' }, [
			E('span', {}, 'Отключать каждый день с'), from, E('span', {}, 'до'), to,
			E('button', { type: 'button', class: 'cbi-button cbi-button-action', click: () => act([ 'sched', d.mac, from.value, to.value, d.name || '' ], 'Расписание сохранено.') }, 'Сохранить'),
			d.from ? E('button', { type: 'button', class: 'cbi-button', click: () => act([ 'sched', d.mac, 'off' ], 'Расписание убрано.') }, 'Убрать') : ''
		]);
	}

	function quotaRow(d) {
		const gb = E('input', { type: 'number', min: '0.1', step: '0.1', value: d.quota ? String(Math.round(d.quota / 102.4) / 10) : '', placeholder: 'ГБ', 'aria-label': 'Лимит в сутки, ГБ' });
		return E('div', { class: 'nf-blk-sched' }, [
			E('span', {}, 'Лимит трафика в сутки'), gb, E('span', {}, 'ГБ'),
			E('button', { type: 'button', class: 'cbi-button cbi-button-action', click: () => {
				const v = parseFloat(String(gb.value).replace(',', '.'));
				if (!(v > 0)) { note = 'Введите лимит в гигабайтах, например 5.'; render(); return; }
				act([ 'quota', d.mac, String(Math.round(v * 1024)), d.name || '' ], 'Лимит задан: интернет отключится до конца суток, когда устройство скачает ' + v + ' ГБ.');
			} }, 'Задать'),
			d.quota ? E('button', { type: 'button', class: 'cbi-button', click: () => act([ 'quota', d.mac, 'off' ], 'Лимит убран.') }, 'Убрать') : ''
		]);
	}

	function render() {
		if (EDITING || busy) return;
		if (!devs) {
			body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Нет данных'), E('span', {}, 'Не удалось получить список устройств. Если вы только что обновили тему, выйдите и войдите в LuCI снова.') ]));
			return;
		}
		renderHead();
		const pass = d => (tab === 'all' || (tab === 'on' && d.online) || (tab === 'off' && !d.online) || (tab === 'rule' && hasRule(d)) || tab === 'g:' + d.group)
			&& (!qs || [ d.name, d.ip, d.mac, d.group, nmOf(d).nm ].some(v => v && String(v).toLowerCase().indexOf(qs) >= 0));
		const found = devs.filter(pass).sort((a, b) => ((b.active ? 1 : 0) - (a.active ? 1 : 0)) || ((b.from || b.quota ? 1 : 0) - (a.from || a.quota ? 1 : 0)) || (b.online - a.online) || nmOf(a).nm.localeCompare(nmOf(b).nm));
		const rows = more ? found : found.slice(0, 30);
		const list = rows.map(d => {
			const { id, nm } = nmOf(d);
			const q = d.quota ? ' · 📉 ' + fmtBytes(d.used) + ' из ' + fmtBytes(d.quota * 1048576) : '';
			const st = d.active ? E('span', { class: 'nf-blk-st bad' }, (d.reason === 'quota' ? 'лимит исчерпан' : d.reason === 'sched' ? 'по расписанию' : 'отключено') + q)
				: E('span', { class: 'nf-blk-st ' + (d.online && !d.from && !d.quota ? 'ok' : '') }, (d.from ? '⏰ ' + d.from + '–' + d.to + (d.snoozed ? ' (пропуск до завтра)' : '') + ' · ' : '') + (d.online ? (d.wifi ? 'в сети · Wi-Fi' : 'в сети') : 'не в сети') + q);
			const line = E('div', { class: 'nf-blk-r' + (d.active ? ' off' : '') }, [
				E('div', { class: 'nf-blk-n' }, [ E('b', { title: id && id.hint ? id.hint : '' }, [ id ? (() => { const ic = E('i', { class: 'nf-dv-i' + (id.priv ? ' priv' : '') }); ic.innerHTML = DEVID.icon(id.kind); return ic; })() : '', E('span', { class: 'nf-dv-t' }, nm) ]),
					E('span', {}, [ d.ip !== nm ? d.ip : '', d.mac, !d.name && id && id.vendor ? id.vendor : '', id && id.priv ? 'частный MAC' : '' ].filter(Boolean).join(' · ')) ]),
				st,
				E('div', { class: 'nf-blk-a' }, [
					E('button', { type: 'button', class: 'cbi-button ' + (d.active ? 'cbi-button-action' : 'cbi-button-remove'),
						click: () => act([ d.active ? 'unblock' : 'block', d.mac, nm ], d.active ? nm + ': интернет возвращён.' : nm + ': интернет отключён.') }, d.active ? 'Вернуть' : 'Отключить'),
					!d.online ? E('button', { type: 'button', class: 'cbi-button nf-wol', title: 'Включить по сети (Wake-on-LAN): в компьютере или NAS должна быть включена эта функция', 'aria-label': 'Включить ' + nm,
						click: ev => { const b = ev.currentTarget; b.disabled = true; fs.exec(WOLBIN, [ 'send', d.mac ]).then(r => { let j = null; try { j = JSON.parse(r.stdout); } catch (e) { /* пусто */ } note = j && j.ok ? nm + ': сигнал на включение отправлен. Компьютеру нужно 10–30 секунд.' : ((j && j.error) || 'Нет ответа от роутера. Обновите тему и войдите в LuCI снова.'); render(); }).catch(() => { note = 'Не получилось отправить сигнал.'; render(); }); } }, '⚡') : '',
					E('button', { type: 'button', class: 'cbi-button', 'aria-expanded': String(open === d.mac), click: () => { open = open === d.mac ? null : d.mac; render(); } }, '⏰')
				])
			]);
			return open === d.mac ? E('div', { class: 'nf-blk-g' }, [ line, sched(d), quotaRow(d) ]) : line;
		});
		body.replaceChildren(
			note ? E('div', { class: 'nf-blk-note' }, note) : '',
			...(list.length ? list : [ E('div', { class: 'nf-empty' }, devs.length ? 'В этой вкладке никого нет.' : 'Устройств не видно.') ]),
			found.length > rows.length ? E('button', { type: 'button', class: 'nf-link nf-blk-more', click: () => { more = true; render(); } }, 'Показать ещё ' + (found.length - rows.length)) : '',
			logOn ? E('div', { class: 'nf-blk-log' }, (logRows && logRows.length ? logRows.map(r => E('div', {}, [ E('span', {}, new Date(r[0] * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })), E('b', {}, r[2] || r[1]), E('span', { class: r[3] === 'on' ? 'bad' : 'ok' }, r[3] === 'on' ? 'отключён' : 'возвращён'), E('i', {}, r[4]) ])) : [ E('div', { class: 'nf-empty' }, 'Записей пока нет.') ])) : '',
			E('div', { class: 'nf-apps-f' }, [ E('span', {}, 'Устройству отключается выход в интернет (по MAC-адресу). Роутер и локальная сеть остаются доступными, поэтому вернуть доступ можно всегда. Устройства со «случайным» Wi-Fi адресом лучше отключить в настройках самого телефона. То же можно делать кнопками в Telegram-боте.'),
				E('button', { type: 'button', class: 'nf-link', click: () => { logOn = !logOn; if (logOn) run([ 'log' ]).then(r => { logRows = r && r.ok ? r.log : []; render(); }); else render(); } }, logOn ? 'Скрыть журнал' : 'Журнал блокировок') ]));
	}

	function load(force) {
		if (!force && (idle(el) || busy || EDITING || open)) return;
		run([ 'list' ]).then(r => { devs = r && r.ok ? r.devices : null; if (devs) checkedAt = Date.now(); checking = false; render(); }).catch(() => { devs = null; checking = false; render(); });
	}

	return { el, contains: n => el.contains(n), start() { load(true); timer = window.setInterval(load, 20000); } };
}

/* ---------- extra cards ---------- */

function xcard(cls, title, body) {
	return E('div', { class: 'cbi-section nf-xcard ' + cls + ' fade-in' }, [ E('div', { class: 'cbi-title' }, E('h3', {}, title)), body ]);
}

function idle(el) { return document.hidden || window.getComputedStyle(el).display === 'none'; }

function healthCard() {
	const C = 2 * Math.PI * 38;
	const ARC = 'M46 8a38 38 0 1 1 0 76a38 38 0 1 1 0-76';
	const fg = SVG('path', { class: 'fg', d: ARC, 'stroke-dasharray': C.toFixed(1), 'stroke-dashoffset': C.toFixed(1) });
	const num = E('b', {}, '–'), head = E('strong', {}, 'Собираю данные…'), chips = E('div', { class: 'nf-chips' });
	const ring = E('div', { class: 'nf-ring' }, [ SVG('svg', { viewBox: '0 0 92 92' }, [ SVG('path', { class: 'bg', d: ARC }), fg ]), num ]);
	const el = xcard('nf-health', 'Состояние роутера', E('div', { class: 'nf-health-b' }, [ ring, E('div', { class: 'nf-health-t' }, [ head, chips ]) ]));
	let timer = null;

	function render() {
		const s = SHARED;
		if (s.t == null || idle(el)) return;
		let score = 100;
		const f = [];
		const add = (pen, lvl, text) => { score -= pen; f.push([ lvl, text ]); };

		if (s.online === false) add(50, 'bad', 'Нет интернета');
		else if (s.online === true) f.push([ 'ok', 'Интернет работает' ]);
		if (s.ping != null && s.ping >= 0) {
			if (s.ping > 150) add(15, 'bad', 'Высокий пинг ' + nf0.format(s.ping) + ' мс');
			else if (s.ping > 80) add(6, 'warn', 'Пинг ' + nf0.format(s.ping) + ' мс');
		}
		if (s.loss != null && s.loss > 2) add(s.loss > 10 ? 20 : 10, s.loss > 10 ? 'bad' : 'warn', 'Потери ' + nf0.format(s.loss) + '%');
		if (s.cpu != null) {
			if (s.cpu > 90) add(20, 'bad', 'Процессор ' + nf0.format(s.cpu) + '%');
			else if (s.cpu > 70) add(8, 'warn', 'Процессор ' + nf0.format(s.cpu) + '%');
		}
		if (s.mem != null) {
			if (s.mem > 90) add(20, 'bad', 'Память ' + nf0.format(s.mem) + '%');
			else if (s.mem > 80) add(8, 'warn', 'Память ' + nf0.format(s.mem) + '%');
		}
		if (s.temp != null) {
			if (s.temp > 80) add(25, 'bad', 'Жарко ' + nf0.format(s.temp) + ' °C');
			else if (s.temp > 70) add(12, 'warn', 'Тепло ' + nf0.format(s.temp) + ' °C');
			else if (s.temp > 60) add(4, 'warn', 'Температура ' + nf0.format(s.temp) + ' °C');
		}
		score = Math.max(0, Math.min(100, Math.round(score)));
		const bad = f.filter(x => x[0] !== 'ok');
		if (!bad.length) f.push([ 'ok', 'Нагрузка в норме' ]);

		num.textContent = String(score);
		fg.setAttribute('stroke-dashoffset', (C * (1 - score / 100)).toFixed(1));
		ring.style.setProperty('--c', score >= 85 ? 'var(--nf-g-up, #2ea043)' : score >= 65 ? '#e8a317' : 'var(--nf-g-bad, #e5484d)');
		head.textContent = score >= 85 ? 'Всё хорошо' : score >= 65 ? 'Есть замечания' : score >= 40 ? 'Нужно внимание' : 'Проблемы';
		chips.replaceChildren(...f.slice(0, 6).map(x => E('span', { class: 'nf-chip ' + x[0] }, x[1])));
	}

	return { el, contains: n => el.contains(n), start() { render(); timer = window.setInterval(render, 3000); } };
}

function wifiCard() {
	const body = E('div', { class: 'nf-wifi-b' }, E('div', { class: 'nf-empty' }, 'Ищу подключённые устройства…'));
	const el = xcard('nf-wifi', 'Wi‑Fi сейчас', body);
	let names = null, timer = null;
	const BAND = { '2g': '2,4 ГГц', '5g': '5 ГГц', '6g': '6 ГГц', '60g': '60 ГГц' };

	const open = new Set();
	let lastList = null;
	const dur = s => { s = +s || 0; const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? d + ' д ' + h + ' ч' : h ? h + ' ч ' + m + ' мин' : m + ' мин'; };

	function render(list) {
		if (EDITING) return;
		lastList = list;
		if (!list.length) {
			body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Никого нет'), E('span', {}, 'К Wi‑Fi сейчас не подключено ни одно устройство.') ]));
			return;
		}
		list.sort((a, b) => b.signal - a.signal);
		body.replaceChildren(...list.map(s => {
			const lv = signalLevel(s.signal), n = lv[0] === 'ok' ? (s.signal >= -60 ? 4 : 3) : lv[0] === 'warn' ? 2 : 1;
			const mac = nameKey(s.mac), hint = names && names[mac] || {};
			const auto = hint.name || s.mac, custom = loadNames()[mac] || '', shown = custom || auto;
			const rx = s.rx && s.rx.rate ? nf0.format(s.rx.rate / 1000) : '–', tx = s.tx && s.tx.rate ? nf0.format(s.tx.rate / 1000) : '–';
			const isOpen = open.has(mac);
			const title = E('b', { title: s.mac }, shown);
			const row = E('div', { class: 'nf-sta', role: 'button', tabindex: '0', 'aria-expanded': String(isOpen) }, [
				E('div', { class: 'nf-av' }, shown.charAt(0)),
				title,
				E('div', { class: 'nf-sig', 'data-l': lv[0] }, [
					E('i', {}, [ 1, 2, 3, 4 ].map(k => E('s', { class: k <= n ? 'on' : '', style: 'height:' + (4 + k * 3) + 'px' }))),
					E('span', {}, nf0.format(s.signal) + ' дБм') ]),
				E('small', {}, [ s.ssid, s.band, '↓' + rx + ' ↑' + tx + ' Мбит/с' ].filter(Boolean).join(' · '))
			]);
			const kv = (k, v) => v == null || v === '' ? null : E('div', {}, [ E('span', {}, k), E('b', {}, v) ]);
			const snr = s.noise != null && s.noise < 0 ? s.signal - s.noise : null;
			const det = E('div', { class: 'nf-sta-d' }, [
				kv('MAC', s.mac), kv('IP', ((hint.ipaddrs || [])[0]) || ((hint.ip6addrs || [])[0])), kv('Сеть', [ s.ssid, s.band ].filter(Boolean).join(' · ')),
				kv('Сигнал', nf0.format(s.signal) + ' дБм · ' + lv[1]), kv('Шум', s.noise != null && s.noise < 0 ? nf0.format(s.noise) + ' дБм' : ''), kv('Запас сигнала', snr != null ? nf0.format(snr) + ' дБ' : ''),
				kv('Скорость ↓', s.rx && s.rx.rate ? nf0.format(s.rx.rate / 1000) + ' Мбит/с' + (s.rx.mhz ? ' · ' + s.rx.mhz + ' МГц' : '') : ''),
				kv('Скорость ↑', s.tx && s.tx.rate ? nf0.format(s.tx.rate / 1000) + ' Мбит/с' + (s.tx.mhz ? ' · ' + s.tx.mhz + ' МГц' : '') : ''),
				kv('Подключён', s.connected_time ? dur(s.connected_time) : ''), kv('Был тих', s.inactive != null ? nf0.format(s.inactive) + ' мс' : ''),
				kv('Пакетов ↓/↑', s.rx && s.tx && s.rx.packets != null ? nf0.format(s.rx.packets) + ' / ' + nf0.format(s.tx.packets) : ''),
				kv('Режим', [ s.he ? 'Wi‑Fi 6' : s.vht ? 'Wi‑Fi 5' : s.ht ? 'Wi‑Fi 4' : '' ].filter(Boolean).join(''))
			].filter(Boolean));
			const rn = E('button', { type: 'button', class: 'nf-qa nf-rn', click: ev => {
				ev.stopPropagation();
				editName(title.parentNode.querySelector('b'), mac, auto, () => render(lastList));
			} }, custom ? 'Изменить имя' : 'Дать имя');
			det.appendChild(E('div', { class: 'nf-sta-a' }, rn));
			const toggle = () => { if (open.has(mac)) open.delete(mac); else open.add(mac); render(lastList); };
			row.addEventListener('click', toggle);
			row.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
			return E('div', { class: 'nf-sta-w' + (isOpen ? ' open' : '') }, isOpen ? [ row, det ] : [ row ]);
		}));
	}

	function load() {
		if (idle(el)) return;
		Promise.all([ callWireless().then(v => v || {}, () => null), names ? null : L.resolveDefault(callHints(), {}) ]).then(r => {
			if (r[0] === null) { body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Нет доступа к данным Wi‑Fi'), E('span', {}, 'После обновления темы выйдите из LuCI и войдите заново, затем выполните: /etc/init.d/rpcd restart') ])); return; }
			if (r[1]) names = Object.keys(r[1]).reduce((o, k) => { o[k.toUpperCase()] = r[1][k]; return o; }, {});
			const ifs = [];
			for (const radio in r[0] || {}) {
				const rc = r[0][radio] || {};
				for (const i of rc.interfaces || []) {
					const cfg = i.config || {};
					if (i.ifname && (cfg.mode || 'ap') === 'ap')
						ifs.push({ dev: i.ifname, ssid: cfg.ssid || '', band: BAND[(rc.config || {}).band] || '' });
				}
			}
			const next = ifs.length ? Promise.resolve(ifs) : L.resolveDefault(callIwDevs(), []).then(d => (d || []).map(dev => ({ dev, ssid: '', band: '' })));
			return next.then(list => {
			if (!list.length) { body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Wi‑Fi не найден'), E('span', {}, 'Беспроводные интерфейсы не настроены или выключены.') ])); return; }
			return Promise.all(list.map(i => Promise.all([ L.resolveDefault(callAssoc(i.dev), []), (i.ssid && i.band) ? null : L.resolveDefault(callIwInfo(i.dev), null) ]).then(r => {
					const inf = r[1] || {}, f = +inf.frequency || 0;
					const band = i.band || (f ? (f < 3000 ? BAND['2g'] : f < 5925 ? BAND['5g'] : BAND['6g']) : '');
					return (r[0] || []).map(s => Object.assign({}, s, { ssid: i.ssid || inf.ssid || '', band }));
				}))).then(l => render([].concat(...l)));
			});
		}).catch(() => {});
	}

	return { el, contains: n => el.contains(n), start() { load(); timer = window.setInterval(load, 8000); } };
}

function eventsCard() {
	const body = E('div', { class: 'nf-ev-b' }, E('div', { class: 'nf-empty' }, 'Читаю журнал…'));
	const el = xcard('nf-events', 'Лента событий', body);
	let timer = null;
	const LV = { ok: 'ok', info: 'info', warn: 'warn', warning: 'warn', crit: 'bad', critical: 'bad', bad: 'bad', error: 'bad', err: 'bad' };
	const two = v => String(v).padStart(2, '0');
	function when(ts) {
		const d = new Date(ts * 1000), n = new Date();
		const hm = two(d.getHours()) + ':' + two(d.getMinutes());
		return d.toDateString() === n.toDateString() ? hm : two(d.getDate()) + '.' + two(d.getMonth() + 1) + ' ' + hm;
	}

	function load() {
		if (idle(el)) return;
		fs.exec(HIST, [ 'series', 'fine' ]).then(res => {
			let h = null;
			try { h = JSON.parse(res.stdout); } catch (e) { /* no collector */ }
			if (!h || !Array.isArray(h.events)) {
				body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Нет данных'), E('span', {}, 'Сбор истории не запущен.') ]));
				return;
			}
			const raw = h.events.slice().reverse(), list = [];
			for (const e of raw) {   /* identical neighbours collapse into one row with a counter */
				const last = list[list.length - 1];
				if (last && last[2] === e[2]) last[3]++; else list.push([ e[0], e[1], e[2], 1 ]);
				if (list.length >= 8 && !(last && last[2] === e[2])) break;
			}
			if (!list.length) { body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Всё спокойно'), E('span', {}, 'Событий пока не было.') ])); return; }
			body.replaceChildren(...list.map(e => E('div', { class: 'nf-ev', 'data-l': LV[String(e[1]).toLowerCase()] || 'info' }, [ E('div', {}, e[3] > 1 ? e[2] + ' ×' + e[3] : e[2]), E('span', {}, when(e[0])) ])));
		}).catch(() => {});
	}

	return { el, contains: n => el.contains(n), start() { load(); timer = window.setInterval(load, 15000); } };
}

function quickCard() {
	const note = E('div', { class: 'nf-qnote' });
	const body = E('div', { class: 'nf-quick-b' });
	const el = xcard('nf-quick', 'Быстрые действия', body);

	function action(label, confirmText, run) {
		let timer = null;
		const b = E('button', { type: 'button', class: 'nf-qa' }, label);
		b.addEventListener('click', () => {
			if (!b.classList.contains('arm')) {
				b.classList.add('arm'); b.textContent = confirmText;
				timer = window.setTimeout(() => { b.classList.remove('arm'); b.textContent = label; }, 4000);
				return;
			}
			window.clearTimeout(timer);
			b.classList.remove('arm'); b.textContent = label; b.disabled = true;
			Promise.resolve(run()).catch(() => { note.textContent = 'Не получилось выполнить действие (нет прав?).'; }).then(() => { b.disabled = false; });
		});
		return b;
	}

	function waitBack() {
		let was = false;
		const t = window.setInterval(() => {
			fetch(window.location.pathname, { cache: 'no-store' }).then(r => { if (r.ok && was) { window.clearInterval(t); window.location.reload(); } }).catch(() => { was = true; });
		}, 3000);
	}

	body.append(
		action('Перезапустить Wi‑Fi', 'Нажмите ещё раз', () => {
			note.textContent = 'Перезапускаю Wi‑Fi… устройства переподключатся сами.';
			return fs.exec('/sbin/wifi', [ 'reload' ]).then(r => { note.textContent = r.code === 0 ? 'Wi‑Fi перезапущен.' : 'Команда вернула ошибку ' + r.code; });
		}),
		action('Перезагрузить роутер', 'Точно перезагрузить?', () => {
			note.textContent = 'Роутер перезагружается… страница обновится сама, когда он вернётся.';
			return callReboot().then(waitBack);
		}),
		note);

	return { el, contains: n => el.contains(n), start() {} };
}

/* ---------- init ---------- */

return baseclass.extend({
	__init__() {
		const path = (L.env.dispatchpath || []).join('/');
		if (path !== 'admin/status/overview') return;

		const view = document.getElementById('view');
		if (!view) return;

		let strip = null, extras = [], ready = false, timer = null;
		const relayout = gridLayout(view);

		const run = () => {
			timer = null;
			if (DRAG || !cardsOf(view).length) return;

			if (!ready) {
				ready = true;
				strip = liveStrip();
				strip.resetBtn.addEventListener('click', () => { saveOrder(null); sortCards(view, null); });
				sortCards(view, loadOrder());
				view.insertBefore(strip.el, cardsOf(view)[0]);
				const nd = newDevBanner(); strip.el.insertBefore(nd.el, strip.el.firstChild); nd.start();
				strip.start();
				extras = [ healthCard(), wifiCard(), eventsCard(), quickCard(), topCard(), appsCard(), blockCard() ];
				extras.forEach(x => { view.appendChild(x.el); x.start(); });
			}
			else {
				sortCards(view, loadOrder());
				const first = cardsOf(view)[0];
				if (first && strip.el.nextSibling !== first && strip.el.parentNode === view)
					view.insertBefore(strip.el, first);
			}

			decorateCards(view);
			syncPins(view);
			syncSizes(view);
			markNoWrap(view); decorateHosts(view); levelFree(view);
			enhanceBadges(view);
			applyColumns(view, relayout);
		};

		const schedule = muts => {
			if (timer || (muts && muts.every(m => (strip && strip.el.contains(m.target)) || extras.some(x => x.contains(m.target)) || (m.target === view && DRAG)))) return;
			timer = window.setTimeout(run, 250);
		};
		new MutationObserver(muts => {
			const own = muts.every(m => (strip && strip.el.contains(m.target)) || extras.some(x => x.contains(m.target)) || (m.target === view && DRAG));
			if (!own) { enhanceBadges(view); markNoWrap(view); decorateHosts(view); levelFree(view); stabilizeTables(view); }
			schedule(muts);
		}).observe(view, { childList: true, subtree: true, characterData: true });
		/* значки сигнала и Wi-Fi в таблицах догружаются уже после вставки строк: учитываем их размер сразу, не ждать следующего опроса */
		view.addEventListener('load', ev => { if (ev.target && ev.target.tagName === 'IMG') stabilizeTables(view); }, true);
		window.addEventListener('resize', () => { applyColumns(view); relayout(); });
		new MutationObserver(() => { applyColumns(view); relayout(); }).observe(document.documentElement, { attributes: true, attributeFilter: [ 'data-nf-ov-cols', 'data-nf-ov-size', 'data-nf-ov-wide' ] });
		schedule();
	}
});
