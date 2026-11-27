// Браузерный тест «Монитора ресурсов»: подставляет вместо LuCI имитацию и запускает настоящие скрипты роутера
// (nightfall-stats, nightfall-sec, nightfall-diag) на заглушках; открывает каждую вкладку и проверяет, что она рисуется без ошибок.
const { chromium } = require('playwright'); const fs = require('fs'); const os = require('os'); const path = require('path'); const cp = require('child_process'); const vm = require('vm');
const THEME_SRC = fs.readFileSync(path.join(__dirname, '../luci-theme-nightfall/htdocs/luci-static/nightfall/nightfall.js'), 'utf8');
const PRESET_START = THEME_SRC.indexOf('var PRESETS = ['), PRESET_END = THEME_SRC.indexOf('\n\t];', PRESET_START) + 4;
if (PRESET_START < 0 || PRESET_END <= PRESET_START) throw new Error('Nightfall theme presets not found');
const PRESETS = vm.runInNewContext(THEME_SRC.slice(PRESET_START, PRESET_END) + '\nPRESETS');
const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'luci-app-nightfall-monitor/root/usr/libexec');
const SRC = fs.readFileSync(path.join(ROOT, 'luci-app-nightfall-monitor/htdocs/luci-static/resources/view/nightfall/monitor.js'), 'utf8');
const CHARTS_SRC = fs.readFileSync(path.join(ROOT, 'luci-app-nightfall-monitor/htdocs/luci-static/resources/nightfall-monitor-charts.js'), 'utf8');
const CSS = path.join(ROOT, 'luci-theme-nightfall/htdocs/luci-static/nightfall/cascade.css');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'nfmon-'));
const CFG_SET_CALLS = [];
const NOW = Math.floor(Date.now() / 1000);
cp.execFileSync('sh', [path.join(__dirname, 'sec-fixtures.sh'), T]);
const ENV = Object.assign({}, process.env, { NF_LOGREAD: path.join(T, 'logread'), NF_PROC: path.join(T, 'proc'), NF_KNOWN: path.join(T, 'known'), NF_UCI: path.join(T, 'uci'), NF_UPDATEBIN: path.join(T, 'upd'), NF_SHADOW: path.join(T, 'shadow'), NF_DIR: path.join(T, 'd'), NF_NFT: path.join(T, 'nft'), NFT_LOG: path.join(T, 'nft.log') });
const run = (script, args, extra) => { try { return cp.execFileSync('sh', [path.join(LIB, script)].concat(args), { env: Object.assign({}, ENV, extra || {}), timeout: 20000 }).toString(); } catch (e) { return String(e.stdout || ''); } };
let fail = 0; const bad = m => { console.log('ОШИБКА: ' + m); fail = 1; };
const EXEC = (cmd, args) => {
	const n = path.basename(cmd);
	if (n === 'nightfall-stats') return run('nightfall-stats', args);
	if (n === 'nightfall-telegram-route') return args[0] === 'inspect'
		? JSON.stringify({ ok: true, steer: { found: true, version: '2.1.4' }, outputs: [
			{ id: 'steer:zm_vpn2', label: 'Steer · zm_vpn2 · wg2', table: 304, mark: '0x00500000', device: 'wg2', ready: true },
			{ id: 'steer:offline', label: 'Steer · spare · wg3', table: 305, mark: '0x00600000', device: 'wg3', ready: false }
		], interfaces: [] })
		: JSON.stringify({ ok: true, active: true, mode: 'vpn', source: 'steer', uid: 104, table: 304, device: 'wg2', output: 'steer:zm_vpn2' });
	if (n === 'nightfall-config' && args[0] === 'set') { CFG_SET_CALLS.push(args.slice()); return '{\"ok\":true}'; }
	if (n === 'nightfall-config' && args[0] === 'get') return JSON.stringify({ ok: true, values: { TG: '1', TG_ALERTS: '1', TG_BOT: '1', TG_CLEAN: '0', TG_UPDATES: '1', TG_SEC: '1', TG_WIDGETS: '0', TG_REPORT: '', TG_TOKEN: '', TG_CHAT: '', TG_USERS: '', TG_PROXY: '', TG_IFACE: '', TG_ROUTE_MODE: 'vpn', TG_ROUTE_OUTPUT: 'steer:zm_vpn2' } });
	if (n === 'nightfall-sec' || n === 'nightfall-diag' || n === 'nightfall-log') return run(n, args);
	if (n === 'nightfall-dns') return run(n, args, { NF_LOGREAD: path.join(T, 'dnslogread'), NF_UCI: path.join(T, 'uci_dns') });
	if (n === 'nightfall-history') return args[0] === 'apps' ? JSON.stringify({ enabled: 1, lite: 0, today: '20261118', day: [["192.168.1.20", "ВКонтакте", "VPN", 1048576, 51200], ["192.168.1.20", "Прочее · okcdn.ru", "Direct", 2097152, 1024], ["192.168.1.20", "Прочее · Нет DNS-имени", "Unknown", 512000, 1000], ["192.168.1.20", "Telegram", "VPN", 256000, 1000]], hist: [] }) : args[0] === 'devices' ? JSON.stringify({ now: NOW, ts: NOW - 10, rate: [], day: [["192.168.1.20", 5000000, 1000000]], yday: [], neigh: [["192.168.1.20", "aa:bb:cc:dd:ee:01"]], info: {} }) : args[0] === 'wifi' && !args[1] ? JSON.stringify({ now: NOW, rows: [], events: [[NOW - 60, "aa:bb:cc:dd:ee:01", "join", "phy0"], [NOW - 120, "aa:bb:cc:dd:ee:01", "leave", "phy0"]] }) : args[0] === 'extip' ? JSON.stringify({ now: NOW, rows: [[NOW - 86400, "203.0.113.7", 0], [NOW - 60, "100.64.3.9", 1]] }) : args[0] === 'procmem' ? JSON.stringify({ now: NOW, rows: Array.from({ length: 8 }, (_, i) => [NOW - (7 - i) * 900, [["dnsmasq", 10000 + i * 3000], ["uhttpd", 3000]]]) }) : args[0] === 'known' ? '{"now":1794786100,"rows":[["AA:BB:CC:DD:EE:01","x",1794700000]]}' : args[0] === 'mode' ? '{"mode":"full","step":15}' : args[0] === 'journal' ? JSON.stringify({ now: NOW, rows: [[ NOW - 120, 'outage', 120, 'нет интернета' ], [ NOW - 600, 'boot', 0, 'Загрузка роутера' ]] }) : '{}';
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
// LuCI's translate() result supports String.format(); emulate it only in this isolated test page.
if (!String.prototype.format) Object.defineProperty(String.prototype, 'format', {
	value: function() {
		const args = arguments; let i = 0;
		return String(this).replace(/%([%sdif])/g, (match, type) => {
			if (type === '%') return '%';
			const value = args[i++];
			if (value == null) return '';
			if (type === 'd' || type === 'i') return parseInt(value, 10);
			if (type === 'f') return parseFloat(value);
			return String(value);
		});
	},
	configurable: true
});
function SVG(tag, attrs, children) {
	const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const k in (attrs || {})) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
	const add = d => { if (d == null) return; if (Array.isArray(d)) d.forEach(add); else el.appendChild(d); };
	add(children);
	return el;
}
window.SVG = SVG;
const ok = v => Promise.resolve(v);
window.L = { resolveDefault: (p, d) => Promise.resolve(p).catch(() => d), require: n => /overview/.test(n) ? ok({ blockCard: () => ({ el: E('div', { class: 'cbi-section' }, [ E('h3', {}, 'Доступ в интернет'), E('div', {}, 'карточка') ]), start() {} }) }) : ok({ identify: () => null, parseUA: () => null }), bind: (f, o) => f.bind(o) };
const viewM = { extend: o => o };
const rpcM = { declare: spec => (...a) => ok(spec.object === 'system' ? { model: 'Тестовый роутер', hostname: 'test' } : spec.object === 'network.interface' ? { interface: [] } : spec.object === 'luci-rpc' ? {} : spec.expect && Array.isArray(spec.expect.results) ? [] : {}) };
const fsM = { exec: (c, a) => window.__exec(c, a || []).then(s => ({ code: 0, stdout: s, stderr: '' })), read: () => ok(''), stat: () => ok(null), lines: () => ok([]) };
const uiM = { addNotification() {}, showModal(t, c) { const d = document.createElement('div'); d.id = 'mock-modal'; d.append(t); [].concat(c).forEach(x => d.append(x)); document.body.append(d); }, hideModal() { const d = document.getElementById('mock-modal'); if (d) d.remove(); }, tabs: {}, createHandlerFn: f => f };
// Smoke-тест проверяет статичный набор фикстур. Таймер LuCI-поллинга здесь отключён:
// периодический rerender заменял DOM вкладок во время Playwright click и вызывал случайные таймауты.
// Polling остаётся управляемым: тест запускает один tick после каждого переключения вкладки.
const pollM = { fn: null, add(f) { this.fn = f; }, remove() {}, start() {}, stop() {} };
window.__runMonitorTick = () => pollM.fn ? pollM.fn() : Promise.resolve();
const netM = { getWifiNetworks: () => ok([]), getHostHints: () => ok({ getMACHints: () => [] }) };
const Charts = new Function('baseclass', CHARTS_SRC.replace(/^'require[^\\n]*\\n/gm, ''))({ extend: o => o });
window.__mod = (new Function('view', 'rpc', 'fs', 'poll', 'ui', 'network', 'DevId', 'Charts', SRC.replace(/^'require[^\\n]*\\n/gm, '')))(viewM, rpcM, fsM, pollM, uiM, netM, { identify: () => null }, Charts);
`;
(async () => {
	const b = await chromium.launch();
	const names = { wifi: 'Wi-Fi клиенты', devs: 'Доступ в интернет', apps: 'Трафик по категориям', diag: 'Диагностика сети', sec: 'Сводка безопасности', log: 'Журнал событий' };
	for (const [vn, vp] of [
		[ 'desktop', { width: 1280, height: 900 } ],
		[ 'mobile', { width: 390, height: 800 } ],
		[ 'iphone-15-pro-max', { width: 430, height: 932 } ],
		[ 'iphone-16-pro-max', { width: 440, height: 956 } ]
	]) {
		const mobile = vn !== 'desktop';
		const p = await b.newPage({ viewport: vp, isMobile: mobile, hasTouch: mobile });
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
		await p.addScriptTag({ content: 'const SRC = ' + JSON.stringify(SRC) + ';\nconst CHARTS_SRC = ' + JSON.stringify(CHARTS_SRC) + ';\n' + BOOT });
		await p.evaluate(async () => { const m = window.__mod; const d = await m.load(); document.getElementById('m').appendChild(m.render(d)); });
		await p.waitForTimeout(2500);
		const tabs = await p.$$eval('.nfm-tab.nfm-ti', els => els.map(e => e.getAttribute('data-ic')));
		for (const k of [ 'overview', 'net', 'wifi', 'devs', 'apps', 'procs', 'svcs', 'diag', 'sec', 'log', 'hist', 'tg' ]) if (!tabs.includes(k)) bad(vn + ': нет вкладки ' + k);
		for (const k of [ 'overview', 'procs', 'wifi', 'devs', 'apps', 'diag', 'sec', 'log', 'net', 'hist', 'tg' ]) {
			await p.click(`.nfm-tab.nfm-ti[data-ic="${k}"]`); await p.evaluate(() => window.__runMonitorTick()); await p.waitForTimeout(k === 'sec' || k === 'log' ? 3000 : 1500);
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
				const severity = await p.evaluate(() => ({
					err: document.querySelectorAll('.nfm-rlog-item > .nfm-ev-i.crit').length,
					warn: document.querySelectorAll('.nfm-rlog-item > .nfm-ev-i.warn').length,
					detail: !!document.querySelector('.nfm-rlog-item > .nfm-ev-i.crit + .nfm-log-detail'),
					controls: !!document.querySelector('.nfm-log-tools') && !!document.querySelector('.nfm-log-summary')
				}));
				if (severity.err < 1) bad(vn + ': уровень kern.err не выделен как ошибка');
				if (severity.warn < 1) bad(vn + ': метка steer[warn] не распознана как предупреждение');
				const cronDispatch = await p.evaluate(() => Array.from(document.querySelectorAll('.nfm-rlog-item')).some(e => e.textContent.includes('backend.sh zm_watch') && !!e.querySelector('.nfm-log-level.notice')));
				if (!cronDispatch) bad(vn + ': обычный запуск cron ошибочно классифицирован как ошибка');
				if (!severity.detail || !severity.controls) bad(vn + ': не отображаются подробности или инструменты журнала');
				const intelligence = await p.evaluate(() => ({
					wan: Array.from(document.querySelectorAll('.nfm-log-diagnostic')).some(e => e.textContent.includes('WAN / интернет')),
					dns: Array.from(document.querySelectorAll('.nfm-log-diagnostic')).some(e => e.textContent.includes('DNS')),
					repeat: Array.from(document.querySelectorAll('.nfm-log-repeat')).some(e => e.textContent.includes('× 3'))
				}));
				if (!intelligence.wan || !intelligence.dns) bad(vn + ': диагностика не выявила тестовые WAN/DNS события');
				if (!intelligence.repeat) bad(vn + ': одинаковые сообщения не сгруппированы');
				const repeatedGroup = p.locator('.nfm-rlog-item:has(.nfm-log-repeat)').first();
				const repeatedKey = await repeatedGroup.getAttribute('data-log-key');
				await repeatedGroup.locator('summary').click();
				await p.waitForTimeout(100);
				await p.evaluate(() => window.__runMonitorTick());
				const stayedOpen = await p.evaluate(key => { const el = Array.from(document.querySelectorAll('.nfm-rlog-item')).find(x => x.getAttribute('data-log-key') === key); return !!el && el.open; }, repeatedKey);
				if (!stayedOpen) bad(vn + ': раскрытая группа повторов свернулась после обновления интерфейса');
				const currentRepeated = p.locator('.nfm-rlog-item[data-log-key]').filter({ has: p.locator('.nfm-log-repeat') }).first();
				await currentRepeated.locator('summary').click();
				await p.waitForTimeout(100);
				await p.evaluate(() => window.__runMonitorTick());
				const stayedClosed = await p.evaluate(key => { const el = Array.from(document.querySelectorAll('.nfm-rlog-item')).find(x => x.getAttribute('data-log-key') === key); return !!el && !el.open; }, repeatedKey);
				if (!stayedClosed) bad(vn + ': закрытая группа самопроизвольно раскрылась после обновления интерфейса');
				await p.locator('.nfm-log-diagnostic').filter({ hasText: 'WAN / интернет' }).click();
				await p.waitForTimeout(200);
				const focused = await p.evaluate(() => ({
					text: Array.from(document.querySelectorAll('.nfm-rlog-item')).map(e => e.textContent).join('|'),
					active: Array.from(document.querySelectorAll('.nfm-log-diagnostic.on')).map(e => e.textContent).join('|')
				}));
				if (!focused.active.includes('WAN / интернет') || !focused.text.includes('netifd') || focused.text.includes('dropbear') || focused.text.includes('dnsmasq')) bad(vn + ': фильтр WAN не ограничил записи: ' + focused.text.slice(0, 160));
				await p.locator('.nfm-log-diagnostic.on').filter({ hasText: 'WAN / интернет' }).click();
				await p.click('button:has-text("Повторы: сгруппированы")');
				await p.waitForTimeout(200);
				if (await p.locator('.nfm-log-repeat').count()) bad(vn + ': отключение группировки не показало отдельные записи');
				await p.click('button:has-text("Повторы: отдельно")');
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
			if (k === 'tg') {
				const tt = await p.evaluate(() => document.querySelector('.nfm-tg-page')?.textContent || '');
				for (const w of [ 'Telegram-бот', 'Маршрут подключения к Telegram', 'Системный маршрут', 'Через прокси', 'Через VPN', 'Сохранить настройки Telegram' ])
					if (!tt.includes(w)) bad(vn + ': во вкладке TG Bot нет «' + w + '»');
				const tgIcon = await p.$eval('.nfm-tab[data-ic="tg"]', el => {
					const css = getComputedStyle(el, '::before');
					return css.maskImage || css.webkitMaskImage || css.getPropertyValue('--ic');
				});
				if (!tgIcon || tgIcon === 'none') bad(vn + ': у вкладки TG Bot отсутствует SVG-значок');
				if (!tt.includes('Маршрут ядра активен')) bad(vn + ': не показано фактическое состояние активного маршрута');
				const selectedRoute = await p.locator('.nfm-tg-output-choice[aria-pressed="true"]').getAttribute('data-output');
				if (selectedRoute !== 'steer:zm_vpn2') bad(vn + ': интерфейс TG Bot не сохранил ранее выбранный steer:zm_vpn2: ' + selectedRoute);
				await p.click('button:has-text(\"Сохранить настройки Telegram\")'); await p.waitForTimeout(200);
				const savedTgConfig = CFG_SET_CALLS[CFG_SET_CALLS.length - 1] || [];
				if (!savedTgConfig.includes('TG_ROUTE_MODE=vpn') || !savedTgConfig.includes('TG_ROUTE_OUTPUT=steer:zm_vpn2'))
					bad(vn + ': сохранение настроек TG Bot перезаписало или потеряло steer:zm_vpn2: ' + savedTgConfig.filter(x => /TG_ROUTE_(MODE|OUTPUT)=/.test(x)).join(', '));
				if (!tt.includes('zm_vpn2') || !tt.includes('wg2')) bad(vn + ': статус TG Bot не показывает активный выход zm_vpn2 / wg2');
				if (!tt.includes('Готов · Steer') || !tt.includes('Не готов')) bad(vn + ': список VPN-выходов не показывает их фактическую готовность');
				const unavailable = await p.locator('.nfm-tg-output-choice:disabled').count();
				if (unavailable !== 1) bad(vn + ': неготовый VPN-выход должен быть видимым и недоступным для выбора');
				const tgSwitches = await p.evaluate(() => Array.from(document.querySelectorAll('.nfm-tg-page .nfm-cfg-toggle input.nfm-toggle'))
					.filter(el => el.getClientRects().length > 0).map(el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; }));
				if (tgSwitches.length !== 7) bad(vn + ': TG Bot должен показывать семь видимых переключателей, найдено=' + tgSwitches.length);
				if (tgSwitches.some(x => Math.abs(x.width - 40) > 1 || Math.abs(x.height - 23) > 1))
					bad(vn + ': переключатели TG Bot имеют неправильный размер: ' + JSON.stringify(tgSwitches));
				await p.screenshot({ path: path.join(OUT, 'monitor-tg-' + vn + '.png'), fullPage: true });
			}
			if (k === 'hist') {
				const ht = await p.evaluate(() => document.body.textContent);
				for (const w of [ 'Сводка за день', 'Сводка недели', 'Трафик по месяцам', 'Сравнение периодов', 'Тепловая карта по часам', 'Процессор, память, температура', 'Интернет: задержка', 'Качество связи', 'Скорость интернета (WAN)', 'Хранение истории и износ флеш-памяти', 'Экспорт данных в CSV', 'Накопители', 'Настройки предупреждений' ])
					if (!ht.includes(w)) bad(vn + ': во вкладке «История» нет «' + w + '»');
				if (/NaN|undefined|не число Б/.test(ht)) bad(vn + ': во вкладке «История» отображается некорректное числовое значение');
				const geometry = await p.evaluate(() => {
					const cards = Array.from(document.querySelectorAll('.nfm-grid > *')).map(el => {
						const r = el.getBoundingClientRect();
						return { right: r.right, width: r.width, scroll: el.scrollWidth, client: el.clientWidth };
					});
					const charts = Array.from(document.querySelectorAll('.nfm-history .nfm-chart')).map(el => {
						const r = el.getBoundingClientRect();
						return { width: r.width, height: r.height };
					});
					const switches = Array.from(document.querySelectorAll('.nfm-cfg-toggle input.nfm-toggle')).filter(el => el.getClientRects().length > 0).map(el => {
						const r = el.getBoundingClientRect();
						return { width: r.width, height: r.height };
					});
					return { viewportWidth: window.innerWidth, cards, charts, switches, cfgGroups: document.querySelectorAll('.nfm-cfg-layout > .nfm-cfg-g').length };
				});
				if (geometry.charts.length < 3 || geometry.charts.some(x => x.width < 80 || x.height < 60)) bad(vn + ': графики истории не получили корректный размер; найдено=' + geometry.charts.length + ', размеры=' + JSON.stringify(geometry.charts.map(x => ({ width: Math.round(x.width), height: Math.round(x.height) }))));
				if (geometry.cards.some(x => x.right > geometry.viewportWidth + 1 || x.scroll > x.client + 3)) bad(vn + ': карточка истории выходит за границы или обрезает содержимое');
				if (geometry.cfgGroups !== 6) bad(vn + ': сетка настроек истории должна содержать шесть основных групп');
				if (geometry.switches.some(x => Math.abs(x.width - 40) > 1 || Math.abs(x.height - 23) > 1)) bad(vn + ': переключатели настроек имеют неправильный размер');
				for (const dark of [ false, true ]) {
					await p.evaluate(d => d ? document.documentElement.setAttribute('data-darkmode', 'true') : document.documentElement.removeAttribute('data-darkmode'), dark);
					await p.evaluate(isDark => {
						const root = document.documentElement.style;
						root.setProperty('--nf-accent', '#1688f8');
						root.setProperty('--nf-card', isDark ? '#202631' : '#ffffff');
						root.setProperty('--nf-card-alt', isDark ? '#293342' : '#f1f4f8');
						root.setProperty('--nf-stroke', isDark ? '#424a58' : '#d6dce5');
						root.setProperty('--text-color-highest', isDark ? '#f5f7fb' : '#20242b');
						root.setProperty('--text-color-medium', isDark ? '#aab2c0' : '#687181');
						root.setProperty('--nf-radius', '12px');
					}, dark);
					const chartCount = await p.locator('.nfm-history .nfm-chart').count();
					if (chartCount < 3) bad(vn + ': графики исчезли в ' + (dark ? 'тёмном' : 'светлом') + ' режиме');
				}
				await p.evaluate(() => { for (const k of [ '--nf-accent', '--nf-card', '--nf-card-alt', '--nf-stroke', '--text-color-highest', '--text-color-medium', '--nf-radius' ]) document.documentElement.style.removeProperty(k); document.documentElement.removeAttribute('data-darkmode'); });
				await p.screenshot({ path: path.join(OUT, 'monitor-history-' + vn + '.png'), fullPage: true });
				if (vn === 'desktop') {
					for (const [id, label, preset] of PRESETS) {
						const darkPreset = preset.mode === 'dark';
						const accent = preset.accent || (darkPreset ? '#60cdff' : '#0067c0');
						const bg = preset.cusBg || (darkPreset ? '#2b2b2b' : '#fcfcfc');
						const card = preset.cusCard || (darkPreset ? '#333333' : '#f3f3f3');
						const text = preset.cusText || (darkPreset ? '#f2f2f2' : '#202020');
						const radius = preset.cusRadius != null ? preset.cusRadius : preset.radius === 'round' ? 16 : preset.radius === 'sharp' ? 4 : 8;
						await p.evaluate(v => {
							const root = document.documentElement, style = root.style;
							if (v.dark) root.setAttribute('data-darkmode', 'true'); else root.removeAttribute('data-darkmode');
							style.setProperty('--nf-accent', v.accent);
							style.setProperty('--nf-card', v.card);
							style.setProperty('--nf-card-alt', v.bg);
						style.setProperty('--nf-stroke', v.dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.12)');
						style.setProperty('--text-color-highest', v.text);
						style.setProperty('--text-color-medium', v.dark ? '#aab2c0' : '#687181');
						style.setProperty('--nf-radius', v.radius + 'px');
						}, { dark: darkPreset, accent, card, bg, text, radius });
						const result = await p.evaluate(() => {
							const root = getComputedStyle(document.querySelector('.nfm'));
							const cards = Array.from(document.querySelectorAll('.nfm-grid > *')).map(el => {
								const r = el.getBoundingClientRect(); return { right: r.right, scroll: el.scrollWidth, client: el.clientWidth };
							});
							return { viewportWidth: window.innerWidth, card: root.getPropertyValue('--nfm-card').trim(), text: root.getPropertyValue('--nfm-text').trim(), accent: root.getPropertyValue('--nfm-accent').trim(), cards };
						});
						if (!result.card || !result.text || !result.accent) bad('тема ' + label + ' (' + id + '): не применились переменные Nightfall');
						if (result.cards.some(x => x.right > result.viewportWidth + 1 || x.scroll > x.client + 3)) bad('тема ' + label + ' (' + id + '): карточки истории выходят за границы');
					}
					await p.evaluate(() => { for (const k of [ '--nf-accent', '--nf-card', '--nf-card-alt', '--nf-stroke', '--text-color-highest', '--text-color-medium', '--nf-radius' ]) document.documentElement.style.removeProperty(k); document.documentElement.removeAttribute('data-darkmode'); });
				}
			}
			if (k === 'devs') {
				const dt = await p.evaluate(() => document.body.textContent);
				for (const w of [ 'Кто дома', 'Необычная активность' ]) if (!dt.includes(w)) bad(vn + ': в «Устройствах» нет «' + w + '»');
			}
			if (k === 'apps') {
				const at = await p.evaluate(() => document.body.textContent);
				for (const w of [ 'Трафик приложений', 'Трафик по категориям', 'Распределение по категориям', 'Социальные сети', 'CDN и инфраструктура', 'Не распознано', 'VPN', 'Напрямую' ]) if (!at.includes(w)) bad(vn + ': во вкладке «Трафик» нет «' + w + '»');
				const donut = await p.evaluate(() => {
					const el = document.querySelector('.nfm-app-donut');
					return el ? getComputedStyle(el).backgroundImage : '';
				});
				if (!donut.includes('conic-gradient')) bad(vn + ': диаграмма категорий не отрисовалась');
				await p.evaluate(() => document.documentElement.setAttribute('data-darkmode', 'true'));
				const darkDonut = await p.evaluate(() => getComputedStyle(document.querySelector('.nfm-app-donut')).backgroundImage);
				if (!darkDonut.includes('conic-gradient')) bad(vn + ': диаграмма исчезла в тёмной теме');
				await p.evaluate(() => document.documentElement.removeAttribute('data-darkmode'));
				await p.click('.nfm-app-category summary >> nth=0');
				await p.evaluate(() => window.__runMonitorTick());
				if (!(await p.$eval('.nfm-app-category', el => el.open))) bad(vn + ': раскрытая категория закрылась при обычном обновлении монитора');
				await p.selectOption('select[aria-label="Устройство для статистики приложений"]', '192.168.1.20');
				await p.selectOption('select[aria-label="Период статистики приложений"]', '7');
				await p.waitForTimeout(250);
				const geometry = await p.evaluate(() => {
					const panel = document.querySelector('.nfm-app-distribution');
					const donut = document.querySelector('.nfm-app-donut');
					const legend = document.querySelector('.nfm-app-legend');
					const a = panel.getBoundingClientRect(), d = donut.getBoundingClientRect(), l = legend.getBoundingClientRect();
					return { panelRight: a.right, viewport: innerWidth, donutTop: d.top, donutBottom: d.bottom, donutRight: d.right, legendTop: l.top, legendLeft: l.left, legendWidth: l.width, panelWidth: a.width };
				});
				if (geometry.panelRight > geometry.viewport + 1) bad(vn + ': панель распределения выходит за ширину экрана');
				if (mobile && geometry.legendTop < geometry.donutBottom - 12) bad(vn + ': легенда не расположена под диаграммой на телефоне');
				if (!mobile && geometry.legendLeft < geometry.donutRight - 12) bad(vn + ': легенда не расположена справа от диаграммы на десктопе');
				await p.screenshot({ path: path.join(OUT, 'monitor-app-traffic-' + vn + '.png'), fullPage: true });
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
				if (/NaN|undefined|не число Б/.test(mt)) bad(vn + ': карточка устройства содержит нечисловой трафик');
				if (!/МБ|ГБ|КБ|Б/.test(mt)) bad(vn + ': карточка устройства не отформатировала объём трафика');
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
