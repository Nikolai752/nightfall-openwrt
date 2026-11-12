// Проверка вёрстки окон и таблиц LuCI на экране компьютера (ловит регрессии вроде «Здесь пока что пусто» не по центру
// и узкого окна поиска Wi-Fi). Страница собирается из разметки LuCI и стилей темы, сеть не нужна.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'luci-theme-nightfall/htdocs/luci-static/nightfall/cascade.css'), 'utf8');
const TH = ['Интерфейс', 'Цели', 'Шлюз', 'Метрика', 'Таблица', 'Отключить'].map(t => '<div class="th cbi-section-table-cell">' + t + '</div>').join('');
const html = '<!doctype html><html lang="ru"><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>' + CSS + '</style></head>' +
	'<body class="modal-overlay-active"><div id="maincontent"><div id="view"><div class="cbi-map"><div class="cbi-section"><div class="cbi-section-node">' +
	'<div class="table cbi-section-table" id="t1"><div class="tr cbi-section-table-titles">' + TH + '</div>' +
	'<div class="tr cbi-section-table-row placeholder"><div class="td"><em>Здесь пока что пусто</em></div></div></div></div></div>' +
	'<div class="cbi-page-actions" id="pa"><button class="cbi-button cbi-button-apply">Сохранить и применить</button><button class="cbi-button cbi-button-save">Сохранить</button><button class="cbi-button cbi-button-reset">Сброс</button></div></div></div></div>' +
	'<div id="modal_overlay" class="active"><div class="modal" id="scan"><h4>Найденные точки доступа Wi-Fi</h4><div class="table"><div class="tr table-titles">' +
	['Сигнал', 'SSID', 'Канал', 'Режим работы', 'BSSID', 'Шифрование'].map(t => '<div class="th">' + t + '</div>').join('') +
	'</div><div class="tr placeholder"><div class="td"><em><span class="spinning">Сканирование беспроводных сетей…</span></em></div></div></div>' +
	'<div class="button-row"><button class="btn cbi-button">Закрыть</button></div></div></div></body></html>';
let fail = 0; const bad = m => { console.log('ОШИБКА: ' + m); fail = 1; };
(async () => {
	const b = await chromium.launch();
	const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
	p.on('pageerror', e => bad(e.message));
	await p.setContent(html); await p.waitForTimeout(700);
	const r = await p.evaluate(() => {
		const c = el => { const b = el.getBoundingClientRect(); return { l: b.left, w: b.width, cx: b.left + b.width / 2 }; };
		const t = c(document.getElementById('t1')), td = c(document.querySelector('#t1 .placeholder .td'));
		const m = c(document.getElementById('scan')), sp = c(document.querySelector('#scan .placeholder .td'));
		const mt = c(document.querySelector('#scan .table'));
		const btns = [...document.querySelectorAll('#pa button')].map(x => x.getBoundingClientRect());
		return { t, td, m, sp, mt, gap: btns[1].left - btns[0].right, h: btns.map(x => Math.round(x.height)) };
	});
	if (Math.abs(r.td.cx - r.t.cx) > 4) bad('«Здесь пока что пусто» не по центру таблицы (сдвиг ' + Math.round(r.td.cx - r.t.cx) + ' px)');
	if (r.td.w < r.t.w - 4) bad('пустая строка уже таблицы (' + Math.round(r.td.w) + ' из ' + Math.round(r.t.w) + ' px)');
	if (r.m.w < 900) bad('окно поиска Wi-Fi узкое: ' + Math.round(r.m.w) + ' px, нужно от 900');
	if (Math.abs(r.sp.cx - r.mt.cx) > 4) bad('надпись сканирования не по центру окна (сдвиг ' + Math.round(r.sp.cx - r.mt.cx) + ' px)');
	if (r.gap < 6) bad('кнопки панели сохранения слишком близко: ' + Math.round(r.gap) + ' px');
	if (new Set(r.h).size > 1) bad('кнопки панели сохранения разной высоты: ' + r.h.join(', '));
	fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
	await p.screenshot({ path: path.join(__dirname, 'out', 'layout.png') }).catch(() => {});
	await b.close();
	console.log(fail ? 'ТЕСТ ВЁРСТКИ НЕ ПРОЙДЕН' : 'ТЕСТ ВЁРСТКИ ПРОЙДЕН'); process.exit(fail);
})();
