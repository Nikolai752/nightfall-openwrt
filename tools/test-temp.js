// Проверка графиков и скорости нагрева в карточке «Температура» (#93): код берётся из nightfall-overview.js и запускается
// в браузере с заглушками LuCI. Запуск: node tools/test-temp.js
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'luci-theme-nightfall/htdocs/luci-static/resources/nightfall-overview.js'), 'utf8');
const a = src.indexOf('const TWIN'), z = src.indexOf('function badge(kind, text)');
if (a < 0 || z < 0) { console.log('ОШИБКА: не нашёл блок температур в nightfall-overview.js'); process.exit(1); }
const code = src.slice(a, z);
let fail = 0; const bad = m => { console.log('ОШИБКА: ' + m); fail = 1; };
(async () => {
	const b = await chromium.launch(), p = await b.newPage();
	await p.setContent('<!doctype html><body><div class="cbi-section" id="sec"><div class="cbi-title"><h3 data-nf-title="Температура">Температура</h3></div><div class="table" id="tb"></div></div></body>');
	const r = await p.evaluate(c => {
		const E = (t, a, ch) => { const e = document.createElement(t); for (const k in a || {}) e.setAttribute(k, a[k]); [].concat(ch || []).forEach(x => e.append(x && x.nodeType ? x : String(x))); return e; };
		const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
		const calls = []; const spark = (cls, win) => ({ el: document.createElementNS('http://www.w3.org/2000/svg', 'svg'), update: (t, v, hi, lo) => calls.push({ n: t.length, win, hi, lo }) });
		const api = new Function('E', 'nf1', 'spark', c + '; return { recordTemps, tempRate, rateLevel, updateTemps, TH };')(E, nf1, spark);
		const render = () => { document.getElementById('tb').innerHTML = '<div class="tr"><div class="th">Датчик</div><div class="th">Температура</div></div>' +
			'<div class="tr"><div class="td">cpu_thermal / temp1</div><div class="td">70.4 °C</div></div><div class="tr"><div class="td">mt7915_phy0 / temp1</div><div class="td">65 °C</div></div>'; };
		const out = {};
		render();
		for (let i = 0; i <= 40; i++) api.recordTemps([ [ 'cpu_thermal', 60000 + i * 100 ], [ 'mt7915_phy0', 65000 ] ], 1000 + i * 3);   // 40 замеров × 3 с, CPU +0,1 °C за замер
		api.updateTemps();
		out.cpuRate = document.querySelectorAll('.nf-rate')[0].textContent; out.cpuLv = document.querySelectorAll('.nf-rate')[0].getAttribute('data-lv');
		out.phyRate = document.querySelectorAll('.nf-rate')[1].textContent; out.phyLv = document.querySelectorAll('.nf-rate')[1].getAttribute('data-lv');
		out.win = calls[0].win; out.n = calls[0].n;
		render(); api.updateTemps();   // LuCI перерисовала таблицу: графики возвращаются
		out.after = document.querySelectorAll('.nf-trend').length;
		api.recordTemps([ [ 'cpu_thermal', 75000 ] ], 1000 + 41 * 3); out.hot = api.tempRate(api.TH.get('cpu_thermal'));
		for (let i = 0; i < 400; i++) api.recordTemps([ [ 'cpu_thermal', 70000 ] ], 2000 + i * 3);
		out.len = api.TH.get('cpu_thermal').length;
		out.few = api.tempRate([ [ 0, 50 ], [ 5, 51 ] ]);
		out.lv = [ 0.2, 1, 3 ].map(api.rateLevel).join(',');
		return out;
	}, code);
	if (r.win !== 300) bad('окно графика не 5 минут: ' + r.win);
	if (!/^↑ \+2,0 °C\/мин$/.test(r.cpuRate) && !/\+2/.test(r.cpuRate)) bad('скорость нагрева CPU: «' + r.cpuRate + '», ждали около +2,0 °C/мин');
	if (r.cpuLv !== 'warn') bad('цвет для +2 °C/мин: ' + r.cpuLv);
	if (!/^→ 0,0 °C\/мин$/.test(r.phyRate) || r.phyLv !== 'ok') bad('стабильный датчик: «' + r.phyRate + '» ' + r.phyLv);
	if (r.after !== 2) bad('после перерисовки таблицы графики не вернулись: ' + r.after);
	if (!(r.hot > 2)) bad('резкий нагрев не распознан: ' + r.hot);
	if (r.len > 101) bad('история не обрезается до 5 минут: ' + r.len + ' замеров');
	if (r.few !== null) bad('при истории меньше 20 с скорость должна быть пустой: ' + r.few);
	if (r.lv !== 'ok,warn,bad') bad('границы цветов: ' + r.lv);
	await b.close();
	console.log(fail ? 'ТЕСТ ТЕМПЕРАТУР НЕ ПРОЙДЕН' : 'ТЕСТ ТЕМПЕРАТУР ПРОЙДЕН'); process.exit(fail);
})();
