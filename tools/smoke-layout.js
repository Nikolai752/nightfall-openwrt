// Проверка вёрстки окон и таблиц LuCI на экране компьютера (ловит регрессии вроде «Здесь пока что пусто» не по центру
// и узкого окна поиска Wi-Fi). Страница собирается из разметки LuCI и стилей темы, сеть не нужна.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'luci-theme-nightfall/htdocs/luci-static/nightfall/cascade.css'), 'utf8');
const MCSS = fs.readFileSync(path.join(__dirname, '..', 'luci-theme-nightfall/htdocs/luci-static/nightfall/mobile.css'), 'utf8');
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
	'</div><div class="tr placeholder"><div class="td"><em class="spinning">Сканирование беспроводных сетей…</em></div></div></div>' +
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
	// индикатор загрузки: маленький (20 px) и не налезает на текст, значка пустого состояния (46 px) нет
	const sc = await p.evaluate(() => {
		const em = document.querySelector('#scan .placeholder em'), cs = getComputedStyle(em, '::before');
		const rg = document.createRange(); rg.selectNodeContents(em); const tx = rg.getBoundingClientRect(), eb = em.getBoundingClientRect();
		return { w: parseFloat(cs.width), gap: tx.left - (eb.left + 4 + 20) };
	});
	if (sc.w > 24) bad('сканирование: вместо индикатора большой круг ' + Math.round(sc.w) + ' px');
	if (sc.gap < 2) bad('сканирование: индикатор налезает на текст (зазор ' + Math.round(sc.gap) + ' px)');
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
	// телефон (как в шапке темы: mobile.css подключается только на узком экране): пустая строка и сканирование по центру
	const mctx = await b.newContext({ viewport: { width: 390, height: 800 }, screen: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
	const mp = await mctx.newPage();
	await mp.setContent(html.replace('</style>', MCSS + '\n@media screen { .table .tr { display: flex; flex-wrap: wrap; } .table .td { flex: 0 0 50% !important; width: 50% !important; display: inline-block !important; } }</style>')); await mp.waitForTimeout(400);
	const mo = await mp.evaluate(() => {
		const res = {};
		for (const [k, tsel, dsel] of [['карточка настроек', '#t2', '#t2 .placeholder .td'], ['окно сканирования', '#scan .table', '#scan .placeholder .td']]) {
			const t = document.querySelector(tsel), td = document.querySelector(dsel), a = t.getBoundingClientRect(), c = td.getBoundingClientRect();
			res[k] = { dx: Math.abs((c.left + c.width / 2) - (a.left + a.width / 2)), w: c.width, tw: a.width };
		}
		const em = document.querySelector('#scan .placeholder em'), cs = getComputedStyle(em, '::before');
		const rg = document.createRange(); rg.selectNodeContents(em);
		res.spin = { w: parseFloat(cs.width), gap: rg.getBoundingClientRect().left - (em.getBoundingClientRect().left + 4 + 20) };
		res.dbg = ['#t2', '#t2 .tr.placeholder', '#t2 .tr.placeholder .td', '#scan .table', '#scan .tr.placeholder', '#scan .tr.placeholder .td'].map(q => { const e = document.querySelector(q), c = getComputedStyle(e), r = e.getBoundingClientRect(); return q + ' ' + c.display + ' pos=' + c.position + ' flex=' + c.flex + ' L=' + Math.round(r.left) + ' W=' + Math.round(r.width); }).join('\n') + '\nmq=' + matchMedia('(max-device-width: 600px)').matches;
		return res;
	});
	if (process.env.DBG) console.log(mo.dbg);
	for (const k of ['карточка настроек', 'окно сканирования'])
		if (mo[k].dx > 4 || mo[k].w < mo[k].tw - 30) bad('телефон, ' + k + ': «пусто» не по центру (сдвиг ' + Math.round(mo[k].dx) + ', ширина ' + Math.round(mo[k].w) + ' из ' + Math.round(mo[k].tw) + ')');
	if (mo.spin.w > 24 || mo.spin.gap < 2) bad('телефон: индикатор сканирования: ' + Math.round(mo.spin.w) + ' px, зазор до текста ' + Math.round(mo.spin.gap) + ' px');
	await mctx.close();
	fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
	await p.screenshot({ path: path.join(__dirname, 'out', 'layout.png') }).catch(() => {});
	await b.close();
	console.log(fail ? 'ТЕСТ ВЁРСТКИ НЕ ПРОЙДЕН' : 'ТЕСТ ВЁРСТКИ ПРОЙДЕН'); process.exit(fail);
})();
