// Браузерный тест «Монитора ресурсов»: подставляет вместо LuCI имитацию и запускает настоящие скрипты роутера
// (nightfall-stats, nightfall-sec, nightfall-diag) на заглушках; открывает каждую вкладку и проверяет, что она рисуется без ошибок.
const { chromium } = require('playwright'); const fs = require('fs'); const os = require('os'); const path = require('path'); const cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'luci-app-nightfall-monitor/root/usr/libexec');
const SRC = fs.readFileSync(path.join(ROOT, 'luci-app-nightfall-monitor/htdocs/luci-static/resources/view/nightfall/monitor.js'), 'utf8');
const CSS = path.join(ROOT, 'luci-theme-nightfall/htdocs/luci-static/nightfall/cascade.css');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'nfmon-'));
const NOW = Math.floor(Date.now() / 1000);
cp.execFileSync('sh', [path.join(__dirname, 'sec-fixtures.sh'), T]);
const ENV = Object.assign({}, process.env, { NF_LOGREAD: path.join(T, 'logread'), NF_PROC: path.join(T, 'proc'), NF_KNOWN: path.join(T, 'known'), NF_UCI: path.join(T, 'uci'), NF_UPDATEBIN: path.join(T, 'upd'), NF_SHADOW: path.join(T, 'shadow'), NF_DIR: path.join(T, 'd'), NF_NFT: path.join(T, 'nft'), NFT_LOG: path.join(T, 'nft.log') });
const run = (script, args, extra) => { try { return cp.execFileSync('sh', [path.join(LIB, script)].concat(args), { env: Object.assign({}, ENV, extra || {}), timeout: 20000 }).toString(); } catch (e) { return String(e.stdout || ''); } };
let fail = 0; const bad = m => { console.log('ОШИБКА: ' + m); fail = 1; };
const EXEC = (cmd, args) => {
	const n = path.basename(cmd);
	if (n === 'nightfall-stats') return run('nightfall-stats', args);
	if (n === 'nightfall-sec' || n === 'nightfall-diag' || n === 'nightfall-log') return run(n, args);
	if (n === 'nightfall-dns') return run(n, args, { NF_LOGREAD: path.join(T, 'dnslogread'), NF_UCI: path.join(T, 'uci_dns') });
	if (n === 'nightfall-history') return args[0] === 'devices' ? '{"now":1794786100,"ts":1794786090,"rate":[],"day":[["192.168.1.20",5000000,1000000]],"yday":[],"neigh":[["192.168.1.20","aa:bb:cc:dd:ee:01"]],"info":{}}' : args[0] === 'wifi' && !args[1] ? '{"now":1794786100,"rows":[],"events":[[1794786000,"aa:bb:cc:dd:ee:01","join","phy0"],[1794785000,"aa:bb:cc:dd:ee:01","leave","phy0"]]}' : args[0] === 'extip' ? '{"now":1794786100,"rows":[[1794700000,"203.0.113.7",0],[1794780000,"100.64.3.9",1]]}' : args[0] === 'procmem' ? '{"now":1794786100,"rows":[[1794780000,[["dnsmasq",10000],["uhttpd",3000]]],[1794780900,[["dnsmasq",13000],["uhttpd",3000]]],[1794781800,[["dnsmasq",16000],["uhttpd",3000]]],[1794782700,[["dnsmasq",19000],["uhttpd",3000]]],[1794783600,[["dnsmasq",22000],["uhttpd",3000]]],[1794784500,[["dnsmasq",25000],["uhttpd",3000]]],[1794785400,[["dnsmasq",28000],["uhttpd",3000]]],[1794786300,[["dnsmasq",31000],["uhttpd",3000]]]]}' : args[0] === 'known' ? '{"now":1794786100,"rows":[["AA:BB:CC:DD:EE:01","x",1794700000]]}' : args[0] === 'mode' ? '{"mode":"full","step":15}' : args[0] === 'journal' ? JSON.stringify({ now: NOW, rows: [[ NOW - 120, 'outage', 120, 'нет интернета' ], [ NOW - 600, 'boot', 0, 'Загрузка роутера' ]] }) : '{}';
	if (n === 'nightfall-block') return args[0] === 'log' ? JSON.stringify({ ok: true, log: [[ NOW - 20, 'aa:bb', 'Камера', 'on', 'вручную (интерфейс)' ], [ NOW - 10, 'aa:bb', 'Камера', 'off', 'по расписанию' ]] }) : '{"ok":true}';
	return '';
};
const BOOT = `
function E(tag, attr, data) {
	const el = document.createElement(tag);
	if (attr != null && (typeof attr !== 'object' || Array.isArray(attr) || attr instanceof Node)) { data = attr; attr = {}; }
	for (const k in (attr || {})) {
		const v = attr[k];
		if (typeof v === 'function') el.addEventListener(k, v);
		else if (k === 'class') el.className = v;
		else if (v === true || v === '') el.setAttribute(k, '');
		else if (v === false || v == null) continue;
		else el.setAttribute(k, v);
	}
	const add = d => { if (d == null || d === false) return; if (Array.isArray(d)) d.forEach(add); else if (d instanceof Node) el.appendChild(d); else el.appendChild(document.createTextNode(String(d))); };
	add(data);
	return el;
}
window.E = E; window._ = s => s;
const ok = v => Promise.resolve(v);
window.L = { resolveDefault: (p, d) => Promise.resolve(p).catch(() => d), require: n => /overview/.test(n) ? ok({ blockCard: () => ({ el: E('div', { class: 'cbi-section' }, [ E('h3', {}, 'Доступ в интернет'), E('div', {}, 'карточка') ]), start() {} }) }) : ok({ identify: () => null, parseUA: () => null }), bind: (f, o) => f.bind(o) };
const viewM = { extend: o => o };
const rpcM = { declare: spec => (...a) => ok(spec.object === 'system' ? { model: 'Тестовый роутер', hostname: 'test' } : spec.object === 'network.interface' ? { interface: [] } : spec.object === 'luci-rpc' ? {} : spec.expect && Array.isArray(spec.expect.results) ? [] : {}) };
const fsM = { exec: (c, a) => window.__exec(c, a || []).then(s => ({ code: 0, stdout: s, stderr: '' })), read: () => ok(''), stat: () => ok(null), lines: () => ok([]) };
const uiM = { addNotification() {}, showModal(t, c) { const d = document.createElement('div'); d.id = 'mock-modal'; d.append(t); [].concat(c).forEach(x => d.append(x)); document.body.append(d); }, hideModal() { const d = document.getElementById('mock-modal'); if (d) d.remove(); }, tabs: {}, createHandlerFn: f => f };
// Smoke-тест проверяет статичный набор фикстур. Таймер LuCI-поллинга здесь отключён:
// периодический rerender заменял DOM вкладок во время Playwright click и вызывал случайные таймауты.
const pollM = { add() {}, remove() {}, start() {}, stop() {} };
const netM = { getWifiNetworks: () => ok([]), getHostHints: () => ok({ getMACHints: () => [] }) };
window.__mod = (new Function('view', 'rpc', 'fs', 'poll', 'ui', 'network', 'DevId', SRC.replace(/^'require[^\\n]*\\n/gm, '')))(viewM, rpcM, fsM, pollM, uiM, netM, { identify: () => null });
`;
(async () => {
	const b = await chromium.launch();
	const names = { wifi: 'Wi-Fi клиенты', devs: 'Доступ в интернет', diag: 'Диагностика сети', sec: 'Сводка безопасности', log: 'Журнал событий' };
	for (const [vn, vp] of [ [ 'desktop', { width: 1280, height: 900 } ], [ 'mobile', { width: 390, height: 800 } ] ]) {
		const p = await b.newPage({ viewport: vp, isMobile: vn === 'mobile', hasTouch: vn === 'mobile' });
		const errs = [];
		p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
		await p.exposeFunction('__exec', (c, a) => EXEC(c, a));
		await p.route('**/*', r => {
			const u = new URL(r.request().url());
			if (u.pathname === '/page') return r.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ru"><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href="http://t.local/c.css"></head><body><div id=m></div></body></html>' });
			if (u.pathname === '/c.css') return r.fulfill({ contentType: 'text/css', body: fs.readFileSync(CSS) });
			return r.fulfill({ status: 404, body: '' });
		});
		await p.goto('http://t.local/page');
		await p.addScriptTag({ content: 'const SRC = ' + JSON.stringify(SRC) + ';\n' + BOOT });
		await p.evaluate(async () => { const m = window.__mod; const d = await m.load(); document.getElementById('m').appendChild(m.render(d)); });
		await p.waitForTimeout(2500);
		const tabs = await p.$$eval('.nfm-tab.nfm-ti', els => els.map(e => e.getAttribute('data-ic')));
		for (const k of [ 'overview', 'net', 'wifi', 'devs', 'procs', 'svcs', 'diag', 'sec', 'log', 'hist' ]) if (!tabs.includes(k)) bad(vn + ': нет вкладки ' + k);
		for (const k of [ 'overview', 'procs', 'wifi', 'devs', 'diag', 'sec', 'log', 'net', 'hist' ]) {
			await p.click(`.nfm-tab.nfm-ti[data-ic="${k}"]`); await p.waitForTimeout(k === 'sec' || k === 'log' ? 3000 : 1500);
			const vis = await p.evaluate(() => Array.from(document.querySelectorAll('.nfm > div[hidden], .nfm > div:not([hidden])')).filter(x => !x.hasAttribute('hidden') && x.className === '').map(x => x.textContent.slice(0, 4000)).join('\n'));
			if (names[k] && !vis.includes(names[k])) bad(vn + ': вкладка ' + k + ' не показала «' + names[k] + '»');
			if (k === 'sec') {
				for (const w of [ 'неудачных входов', '203.0.113.5', 'dropbear', 'uhttpd', 'Камера', 'Web: TCP 8080', 'v1.0.0' ]) if (!vis.includes(w)) bad(vn + ': в «Безопасности» нет «' + w + '»');
				await p.screenshot({ path: path.join(OUT, 'monitor-sec-' + vn + '.png'), fullPage: true });
			}
			if (k === 'log') {
				for (const w of [ 'Обрыв связи', 'Камера: доступ закрыт', 'Камера: доступ открыт' ]) if (!vis.includes(w)) bad(vn + ': в «Журнале» нет «' + w + '»');
				await p.fill('.nfm-search[aria-label="Поиск по журналу"]', 'расписанию'); await p.waitForTimeout(300);
				const f = await p.evaluate(() => Array.from(document.querySelectorAll('.nfm-ev-i')).filter(e => e.offsetParent).map(e => e.textContent).join('|'));
				if (!f.includes('открыт') || f.includes('Обрыв')) bad(vn + ': поиск по журналу не отфильтровал: ' + f);
				await p.screenshot({ path: path.join(OUT, 'monitor-log-' + vn + '.png') });
			}
			if (k === 'sec') {
				p.once('dialog', d => d.accept());
				await p.click('text=Закрыть на 24 ч >> nth=0'); await p.waitForTimeout(800);
				const lg = fs.readFileSync(path.join(T, 'nft.log'), 'utf8');
				if (!lg.includes('add element inet nightfall_ban b4 { 203.0.113.5 timeout 24h }')) bad(vn + ': кнопка «Закрыть на 24 ч» не закрыла адрес: ' + lg);
				await p.waitForTimeout(1500);
				const t2 = await p.evaluate(() => document.body.textContent);
				if (!t2.includes('23h59m10s')) bad(vn + ': список закрытых адресов не показал срок');
			}
			if (k === 'log') {
				await p.waitForTimeout(1500);
				const rl = await p.evaluate(() => Array.from(document.querySelectorAll('.nfm-rlog .nfm-ev-i')).map(e => e.textContent).join('|'));
				if (!rl.includes('dropbear') || !rl.includes('Bad password attempt')) bad(vn + ': журнал роутера пуст: ' + rl.slice(0, 80));
				await p.fill('.nfm-search[aria-label="Поиск по журналу роутера"]', 'luci'); await p.waitForTimeout(300);
				const f2 = await p.evaluate(() => Array.from(document.querySelectorAll('.nfm-rlog .nfm-ev-i')).map(e => e.textContent).join('|'));
				if (f2.includes('dropbear') || !f2.includes('failed login')) bad(vn + ': поиск по журналу роутера не сработал: ' + f2.slice(0, 80));
			}
			if (k === 'overview') {
				await p.waitForTimeout(1500);
				const ot = await p.evaluate(() => document.body.textContent);
				for (const w of [ 'Сейчас больше всех', 'Сеть сейчас', 'Перезагрузить роутер', 'Подробнее во вкладке «Сеть»' ]) if (!ot.includes(w)) bad(vn + ': в «Обзоре» нет «' + w + '»');
				if (!/Всё в порядке|Есть замечания|Требует внимания/.test(ot)) bad(vn + ': нет строки-вывода в «Обзоре»');
				if (await p.evaluate(() => { const d = document.querySelector('.nfm-more'); return d && d.open; })) bad(vn + ': меню «⋯» открыто по умолчанию');
				await p.screenshot({ path: path.join(OUT, 'monitor-overview-' + vn + '.png') });
			}
			if (k === 'wifi') {
				await p.waitForTimeout(1500);
				const wt = await p.evaluate(() => document.body.textContent);
				for (const w of [ 'Диапазоны: 2,4 и 5 ГГц', 'Рекомендации', 'Подключения и отключения', 'подключился', 'отключился' ]) if (!wt.includes(w)) bad(vn + ': в «Wi‑Fi» нет «' + w + '»');
			}
			if (k === 'sec') {
				const st = await p.evaluate(() => document.body.textContent);
				for (const w of [ 'Проверки настроек', 'Пароль root не задан', 'Сеть «Guest» без пароля', 'LuCI доступен по http' ]) if (!st.includes(w)) bad(vn + ': в «Безопасности» нет «' + w + '»');
			}
			if (k === 'log') {
				const csv = await p.evaluate(() => !!Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Скачать CSV'));
				if (!csv) bad(vn + ': нет кнопки «Скачать CSV»');
				await p.selectOption('select[aria-label="Период"]', '86400'); await p.waitForTimeout(300);
			}
			if (k === 'net') {
				await p.waitForTimeout(1500);
				const dn = await p.evaluate(() => document.body.textContent);
				if (!dn.includes('DNS-запросы') || !dn.includes('Куда чаще обращаются')) bad(vn + ': нет карточки DNS во вкладке «Сеть»');
				if (!dn.includes('Адрес WAN и CGNAT') || !dn.includes('CGNAT')) bad(vn + ': нет карточки CGNAT во вкладке «Сеть»');
			}
			if (k === 'diag') {
				await p.click('text=Проверить всё: шлюз, интернет, DNS'); await p.waitForTimeout(6000);
				const o = await p.evaluate(() => document.querySelector('.nfm-diag-out').textContent);
				if (!/Шлюз|Маршрут по умолчанию/.test(o)) bad(vn + ': проверка диагностики ничего не вывела: ' + o);
			}
			if (k === 'devs') {
				const dt = await p.evaluate(() => document.body.textContent);
				for (const w of [ 'Кто дома', 'Необычная активность' ]) if (!dt.includes(w)) bad(vn + ': в «Устройствах» нет «' + w + '»');
			}
			if (k === 'procs') {
				await p.waitForTimeout(1500);
				const pt = await p.evaluate(() => document.body.textContent);
				if (!pt.includes('Память по программам за период') || !pt.includes('возможна утечка')) bad(vn + ': нет карточки памяти по программам с признаком утечки');
			}
			if (k === 'log') {
				/* Reset search and date range before testing pinning. Fixture timestamps are relative to now. */
				await p.fill('.nfm-search[aria-label="Поиск по журналу"]', '');
				await p.selectOption('select[aria-label="Период"]', '0');
				await p.waitForTimeout(300);
				await p.click('.nfm-pin >> nth=0'); await p.waitForTimeout(300);
				const pn = await p.evaluate(() => window.localStorage.getItem('nfm_pins'));
				if (!pn || pn === '[]') bad(vn + ': закрепление записи журнала не сохранилось');
				await p.click('.nfm-tabs button[data-k="pin"]'); await p.waitForTimeout(300);
				const pc = await p.evaluate(() => document.querySelectorAll('.nfm-evlist .nfm-ev-i .nfm-pin.on').length);
				if (pc < 1) bad(vn + ': фильтр «Закреплённые» пуст');
				await p.click('.nfm-tabs button[data-k="all"]');
			}
			if (k === 'diag') {
				const gt = await p.evaluate(() => document.body.textContent);
				for (const w of [ 'Потери по маршруту', 'Тест задержки под нагрузкой', 'История проверок' ]) if (!gt.includes(w)) bad(vn + ': в «Диагностике» нет «' + w + '»');
			}
			if (k === 'devs') {
				await p.waitForTimeout(1200);
				await p.click('tr.nfm-rowlink >> nth=0'); await p.waitForTimeout(1200);
				const mt = await p.evaluate(() => (document.getElementById('mock-modal') || { textContent: '' }).textContent);
				if (!mt.includes('Трафик за 14 дней') || !mt.includes('192.168.1.20') || !mt.includes('Впервые замечено')) bad(vn + ': карточка устройства не открылась: ' + mt.slice(0, 120));
				await p.screenshot({ path: path.join(OUT, 'monitor-devcard-' + vn + '.png') });
				await p.evaluate(() => { const d = document.getElementById('mock-modal'); if (d) d.remove(); });
			}
			if (k === 'devs') await p.screenshot({ path: path.join(OUT, 'monitor-devs-' + vn + '.png') });
		}
		const hs = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		if (hs > 2) bad(vn + ': горизонтальная прокрутка страницы (' + hs + 'px)');
		errs.filter(e => !/Failed to load resource|404/.test(e)).forEach(e => bad(vn + ': ошибка в консоли: ' + e));
		await p.close();
	}
	await b.close(); fs.rmSync(T, { recursive: true, force: true });
	console.log(fail ? 'ТЕСТ МОНИТОРА НЕ ПРОЙДЕН' : 'ТЕСТ МОНИТОРА ПРОЙДЕН'); process.exit(fail);
})();
