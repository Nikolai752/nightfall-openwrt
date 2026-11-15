// Браузерный тест «Монитора ресурсов»: подставляет вместо LuCI имитацию и запускает настоящие скрипты роутера
// (nightfall-stats, nightfall-sec, nightfall-diag) на заглушках; открывает каждую вкладку и проверяет, что она рисуется без ошибок.
const { chromium } = require('playwright'); const fs = require('fs'); const os = require('os'); const path = require('path'); const cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'luci-app-nightfall-monitor/root/usr/libexec');
const SRC = fs.readFileSync(path.join(ROOT, 'luci-app-nightfall-monitor/htdocs/luci-static/resources/view/nightfall/monitor.js'), 'utf8');
const CSS = path.join(ROOT, 'luci-theme-nightfall/htdocs/luci-static/nightfall/cascade.css');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'nfmon-'));
cp.execFileSync('sh', [path.join(__dirname, 'sec-fixtures.sh'), T]);
const ENV = Object.assign({}, process.env, { NF_LOGREAD: path.join(T, 'logread'), NF_PROC: path.join(T, 'proc'), NF_KNOWN: path.join(T, 'known'), NF_UCI: path.join(T, 'uci'), NF_UPDATEBIN: path.join(T, 'upd') });
const run = (script, args) => { try { return cp.execFileSync('sh', [path.join(LIB, script)].concat(args), { env: ENV, timeout: 20000 }).toString(); } catch (e) { return String(e.stdout || ''); } };
let fail = 0; const bad = m => { console.log('ОШИБКА: ' + m); fail = 1; };
const EXEC = (cmd, args) => {
	const n = path.basename(cmd);
	if (n === 'nightfall-stats') return run('nightfall-stats', args);
	if (n === 'nightfall-sec' || n === 'nightfall-diag') return run(n, args);
	if (n === 'nightfall-history') return args[0] === 'mode' ? '{"mode":"full","step":15}' : args[0] === 'journal' ? '{"now":1794786100,"rows":[[1794785000,"outage",120,"нет интернета"],[1794780000,"boot",0,"Загрузка роутера"]]}' : '{}';
	if (n === 'nightfall-block') return args[0] === 'log' ? '{"ok":true,"log":[[1794786000,"aa:bb","Камера","on","вручную (интерфейс)"],[1794786050,"aa:bb","Камера","off","по расписанию"]]}' : '{"ok":true}';
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
const uiM = { addNotification() {}, showModal() {}, hideModal() {}, tabs: {}, createHandlerFn: f => f };
const pollM = { add(f) { window.setInterval(f, 400); }, remove() {}, start() {}, stop() {} };
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
		for (const k of [ 'wifi', 'devs', 'diag', 'sec', 'log', 'net', 'hist' ]) {
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
			if (k === 'diag') {
				await p.click('text=Проверить всё: шлюз, интернет, DNS'); await p.waitForTimeout(6000);
				const o = await p.evaluate(() => document.querySelector('.nfm-diag-out').textContent);
				if (!/Шлюз|Маршрут по умолчанию/.test(o)) bad(vn + ': проверка диагностики ничего не вывела: ' + o);
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
