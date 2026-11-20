'use strict';
'require baseclass';

const WINDOW = 300;
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

function SVG(tag, attrs, children) {
	const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const k in attrs || {})
		el.setAttribute(k, attrs[k]);
	for (const child of [].concat(children || []))
		if (child != null) el.appendChild(child);
	return el;
}

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


return baseclass.extend({ ring, chart, sparkline });
