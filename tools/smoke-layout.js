// Проверка вёрстки окон и таблиц LuCI на экране компьютера (ловит регрессии вроде «Здесь пока что пусто» не по центру
// и узкого окна поиска Wi-Fi). Страница собирается из разметки LuCI и стилей темы, сеть не нужна.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'luci-theme-nightfall/htdocs/luci-static/nightfall/cascade.css'), 'utf8');
const TH = ['Интерфейс', 'Цели', 'Шлюз', 'Метрика', 'Таблица', 'Отключить'].map(t => '<div class="th cbi-section-table-cell">' + t + '</div>').join('');
const html = '<!doctype html><html lang="ru"><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>' + CSS + '</style></head>' +
	'<body class="modal-overlay-active"><div id="maincontent"><div id="view"><div class="cbi-map"><div class="cbi-section"><div class="cbi-section-node">' +
	'<div class="table cbi-section-table" id="t1"><div class="tr cbi-section-table-titles">' + TH + '</div>' +
	'<div class="tr cbi-section-table-row placeholder"><div class="td"><em>Здесь пока что пусто</em></div></div></div></div></div>' +
	'<div class="cbi-section"><div class="cbi-section-node"><div class="table cbi-section-table" id="t2"><div class="tr cbi-section-table-titles">' +
	['Имя хоста', 'MAC-адреса', 'IPv4-адрес', 'Срок аренды', 'DUID/IAID', 'Токен IPv6', 'Установить тег', 'Тег совпадения'].map(t => '<div class="th cbi-section-table-cell">' + t + '</div>').join('') +
	'</div><div class="tr cbi-section-table-row placeholder"><div class="td"><em>Здесь пока что пусто</em></div></div></div></div></div>' +
	'<div class="cbi-page-actions" id="pa"><button class="cbi-button cbi-button-apply">Сохранить и применить</button><button class="cbi-button cbi-button-save">Сохранить</button><button class="cbi-button cbi-button-reset">Сброс</button></div></div></div></div>' +
	'<div id="modal_overlay" class="active"><div class="modal" id="scan"><h4>Найденные точки доступа Wi-Fi</h4><div class="table"><div class="tr table-titles">' +
	['Сигнал', 'SSID', 'Канал', 'Режим работы', 'BSSID', 'Шифрование'].map(t => '<div class="th">' + t + '</div>').join('') +
	'</div><div class="tr placeholder"><div class="td"><em><span class="spinning">Сканирование беспроводных сетей…</span></em></div></div></div>' +
	'<div class="button-row"><button class="btn cbi-button">Закрыть</button></div></div></div></body></html>';
// окно входа: отдельная страница, как её рисует sysauth.ut
const login = '<!doctype html><html lang="ru"><head><meta charset=utf-8><style>' + CSS + '</style></head><body class="nf-blank modal-overlay-active"><div id="modal_overlay" class="active"><div class="modal login"><h4>Веб-интерфейс</h4>' +
	'<form class="cbi-map"><div class="cbi-section"><div class="cbi-section-node"><div class="cbi-value"><label class="cbi-value-title">Имя пользователя</label><div class="cbi-value-field"><input type="text" value="root"></div></div>' +
	'<div class="cbi-value"><label class="cbi-value-title">Пароль</label><div class="cbi-value-field"><input type="password"></div></div></div></div></form><button class="btn cbi-button-positive important">Войти</button></div></div></body></html>';
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
	const d = await p.evaluate(() => {
		const t = document.getElementById('t2'), td = t.querySelector('.placeholder .td'), tb = t.getBoundingClientRect(), b = td.getBoundingClientRect(), th = t.querySelector('.th').getBoundingClientRect();
		return { cx: Math.abs((b.left + b.width / 2) - (tb.left + tb.width / 2)), wide: b.width, tw: tb.width, bot: Math.abs(b.bottom - tb.bottom), over: b.top < th.bottom - 1, th: tb.height };
	});
	if (d.cx > 4) bad('таблица аренд DHCP: «пусто» не по центру (сдвиг ' + Math.round(d.cx) + ' px)');
	if (d.wide < d.tw - 4) bad('таблица аренд DHCP: «пусто» уже таблицы (' + Math.round(d.wide) + ' из ' + Math.round(d.tw) + ' px)');
	if (d.bot > 2 || d.over) bad('таблица аренд DHCP: пустая строка наезжает на заголовок или не у нижнего края');
	// высота таблицы не должна зависеть от содержимого пустой строки (иначе таблица «плавает»)
	await p.evaluate(() => { document.querySelector('#t2 .placeholder .td em').textContent = 'Сбор данных…'; });
	await p.waitForTimeout(100);
	const h2 = await p.evaluate(() => document.getElementById('t2').getBoundingClientRect().height);
	if (Math.abs(h2 - d.th) > 1) bad('высота таблицы меняется от текста пустой строки: ' + Math.round(d.th) + ' → ' + Math.round(h2) + ' px');
	if (r.m.w < 900) bad('окно поиска Wi-Fi узкое: ' + Math.round(r.m.w) + ' px, нужно от 900');
	if (Math.abs(r.sp.cx - r.mt.cx) > 4) bad('надпись сканирования не по центру окна (сдвиг ' + Math.round(r.sp.cx - r.mt.cx) + ' px)');
	if (r.gap < 6) bad('кнопки панели сохранения слишком близко: ' + Math.round(r.gap) + ' px');
	if (new Set(r.h).size > 1) bad('кнопки панели сохранения разной высоты: ' + r.h.join(', '));
	// окно входа: исходные 380 px и по центру
	const lp = await b.newPage({ viewport: { width: 1400, height: 900 } });
	await lp.setContent(login); await lp.waitForTimeout(300);
	const lg = await lp.evaluate(() => { const m = document.querySelector('.modal.login').getBoundingClientRect(); return { w: m.width, cx: m.left + m.width / 2 }; });
	if (lg.w > 381) bad('окно входа растянуто: ' + Math.round(lg.w) + ' px, должно быть 380');
	if (Math.abs(lg.cx - 700) > 4) bad('окно входа не по центру экрана (сдвиг ' + Math.round(lg.cx - 700) + ' px)');
	await lp.close();
	// телефон: пустая строка в карточном виде тоже по центру
	const mp = await b.newPage({ viewport: { width: 390, height: 800 } });
	await mp.setContent(html); await mp.waitForTimeout(300);
	const mo = await mp.evaluate(() => { const t = document.getElementById('t2'), td = t.querySelector('.placeholder .td'); const a = t.getBoundingClientRect(), c = td.getBoundingClientRect(); return { dx: Math.abs((c.left + c.width / 2) - (a.left + a.width / 2)), w: c.width, tw: a.width }; });
	if (mo.dx > 4 || mo.w < mo.tw - 30) bad('телефон: «пусто» не по центру карточки (сдвиг ' + Math.round(mo.dx) + ', ширина ' + Math.round(mo.w) + ' из ' + Math.round(mo.tw) + ')');
	await mp.close();
	fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
	await p.screenshot({ path: path.join(__dirname, 'out', 'layout.png') }).catch(() => {});
	await b.close();
	console.log(fail ? 'ТЕСТ ВЁРСТКИ НЕ ПРОЙДЕН' : 'ТЕСТ ВЁРСТКИ ПРОЙДЕН'); process.exit(fail);
})();
