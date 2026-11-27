// Проверка карточки «Температуры» (v1.18.0): код берётся из nightfall-overview.js и запускается в браузере с заглушками LuCI.
// Запуск: node tools/test-temp.js
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'luci-theme-nightfall/htdocs/luci-static/resources/nightfall-overview.js'), 'utf8');
const a = src.indexOf('/* nf-temps:begin */'), z = src.indexOf('function healthCard()');
if (a < 0 || z < 0) { console.log('ОШИБКА: не нашёл блок температур в nightfall-overview.js'); process.exit(1); }
const code = src.slice(a, z);
let fail = 0; const bad = m => { console.log('ОШИБКА: ' + m); fail = 1; };
(async () => {
	const b = await chromium.launch(), p = await b.newPage();
	await p.setContent('<!doctype html><body><div id="view"><div class="cbi-section" id="stock"><div class="cbi-title"><h3 data-nf-title="Температура">Температура</h3></div></div></div></body>');
	const r = await p.evaluate(async c => {
		const E = (t, a, ch) => { const e = document.createElement(t); for (const k in a || {}) { if (typeof a[k] === 'function') e.addEventListener(k, a[k]); else e.setAttribute(k, a[k]); } [].concat(ch == null ? [] : ch).forEach(x => e.append(x && x.nodeType ? x : String(x))); return e; };
		const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
		const calls = []; const spark = () => ({ el: document.createElementNS('http://www.w3.org/2000/svg', 'svg'), update: (t, v, hi, lo) => calls.push({ n: t.length, hi, lo }) });
		let reply = null; const fsx = { exec: () => Promise.resolve({ stdout: JSON.stringify(reply) }) };
		const mk = new Function('E', 'nf1', 'spark', 'fs', 'HIST', 'idle', 'localStorage', 'tr', c + '; return { tempLabel, tempSlope, tempLevel, tempScale, tempCard, hideStockTemp };');
		const api = mk(E, nf1, spark, fsx, 'x', () => false, { getItem: () => null, setItem: () => {} }, s => s);
		const out = {};
		out.labels = [ 'cpu_thermal', 'mt7915_phy0', 'mt7915_phy1', 'nvme', 'foo', 'mt7915_phy0#2' ].map(api.tempLabel).join('|');
		const t = [], up = [], flat = [], spike = [];
		for (let i = 0; i < 9; i++) { t.push(1000 + i * 15); up.push(60 + i * 0.5); flat.push(65); spike.push(i === 4 ? 70 : 65); }
		out.up = api.tempSlope(t, up); out.flat = api.tempSlope(t, flat); out.spike = api.tempSlope(t, spike); out.short = api.tempSlope([ 0, 15 ], [ 50, 51 ]);
		out.lv = [ 0.2, 1, 3 ].map(api.tempLevel).join(',');
		out.scale = api.tempScale([ 65, 65.4 ]); out.scale2 = api.tempScale([ 40, 80 ]);
		// карточка: нет данных → штатная остаётся
		const view = document.getElementById('view'), card = api.tempCard(); view.appendChild(card.el);
		reply = { names: [], rows: [] }; card.start(); await new Promise(r => setTimeout(r, 50));
		out.stockNoData = document.getElementById('stock').classList.contains('nf-stock-hidden');
		// есть данные: 3 датчика, у CPU рост
		const rows = []; for (let i = 0; i < 9; i++) rows.push([ 1000 + i * 15, 60 + i * 0.5, 65, 66 ]);
		reply = { names: [ 'mt7915_phy0', 'cpu_thermal', 'mt7915_phy1' ], rows: rows.map(r => [ r[0], r[2], r[1], r[3] ]) };
		card.start(); await new Promise(r => setTimeout(r, 50));
		out.tiles = card.el.querySelectorAll('.nf-tt').length;
		out.first = card.el.querySelector('.nf-tt .nf-tt-n').textContent;
		out.value = card.el.querySelector('.nf-tt .nf-tt-v').textContent;
		out.rate = card.el.querySelector('.nf-tt .nf-tt-r').textContent; out.rlv = card.el.querySelector('.nf-tt .nf-tt-r').getAttribute('data-lv');
		out.flatTxt = card.el.querySelectorAll('.nf-tt .nf-tt-r')[1].textContent;
		out.stockHidden = document.getElementById('stock').classList.contains('nf-stock-hidden');
		reply = { names: [ 'cpu-thermal', 'cpu_thermal' ], rows: [ [ 1000, 70, -1 ], [ 1015, 70, -1 ], [ 1030, -1, 71 ], [ 1045, -1, 71 ], [ 1060, -1, 71 ], [ 1075, -1, 71 ] ] };
		card.start(); await new Promise(r => setTimeout(r, 50));
		out.stale = card.el.querySelectorAll('.nf-tt').length;
		reply = { names: [ 'mt7915_phy0', 'cpu_thermal', 'mt7915_phy1' ], rows: rows.map(r => [ r[0], r[2], r[1], r[3] ]) };
		card.start(); await new Promise(r => setTimeout(r, 50));
		out.lay = card.el.querySelector('.nf-tt-grid').getAttribute('data-lay'); out.mainFirst = card.el.querySelector('.nf-tt').classList.contains('nf-tt-main'); out.mainCount = card.el.querySelectorAll('.nf-tt-main').length;
		out.min = card.el.querySelector('.nf-tt .nf-tt-m').textContent;
		return out;
	}, code);
	if (r.labels !== 'Процессор|Wi‑Fi, радио 1|Wi‑Fi, радио 2|Накопитель|foo|Wi‑Fi, радио 1') bad('названия датчиков: ' + r.labels);
	if (!(r.up > 1.9 && r.up < 2.1)) bad('наклон роста +0,5 °C за 15 с: ' + r.up + ', ждали около 2 °C/мин');
	if (r.flat !== 0) bad('ровная линия должна дать 0: ' + r.flat);
	if (!(Math.abs(r.spike) < 0.5)) bad('одиночный скачок датчика исказил скорость: ' + r.spike);
	if (r.short !== null) bad('при истории меньше 45 с скорость должна быть пустой: ' + r.short);
	if (r.lv !== 'ok,warn,bad') bad('границы цветов: ' + r.lv);
	if (r.scale[1] - r.scale[0] < 6 || r.scale[0] > 64 || r.scale[1] < 66) bad('шкала не даёт запаса: ' + r.scale);
	if (r.scale2[0] > 39 || r.scale2[1] < 81) bad('широкая шкала: ' + r.scale2);
	if (r.stockNoData) bad('штатная карточка скрыта, хотя данных нет');
	if (r.tiles !== 3) bad('плиток датчиков: ' + r.tiles);
	if (r.first !== 'Процессор') bad('первым должен идти процессор, а не ' + r.first);
	if (!/^64,0 °C$/.test(r.value)) bad('значение процессора: ' + r.value);
	if (!/^↑ \+2,0 °C\/мин$/.test(r.rate) || r.rlv !== 'warn') bad('скорость нагрева: «' + r.rate + '» ' + r.rlv);
	if (r.flatTxt !== '→ стабильно') bad('стабильный датчик: ' + r.flatTxt);
	if (!r.stockHidden) bad('штатная карточка не скрыта при наличии данных');
	if (r.stale !== 1) bad('переименованный датчик остался плиткой: ' + r.stale + ' плиток вместо 1');
	if (r.lay !== 'main3' || !r.mainFirst || r.mainCount !== 1) bad('раскладка трёх датчиков: ' + r.lay + ', главная плитка первая: ' + r.mainFirst + ', их ' + r.mainCount);
	if (!/мин 60,0 · макс 64,0/.test(r.min)) bad('мин/макс: ' + r.min);
	await b.close();
	console.log(fail ? 'ТЕСТ ТЕМПЕРАТУР НЕ ПРОЙДЕН' : 'ТЕСТ ТЕМПЕРАТУР ПРОЙДЕН'); process.exit(fail);
})();
