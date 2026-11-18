// Браузерный тест страницы «Статус → Обзор» (v1.26.0): запускает настоящий nightfall-overview.js с имитацией LuCI и проверяет
// строку-вывод, меню «Вид», режим раскладки (значки перетаскивания видны только в нём) и свёрнутые карточки.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'luci-theme-nightfall/htdocs/luci-static/resources/nightfall-overview.js'), 'utf8');
const CSS = path.join(ROOT, 'luci-theme-nightfall/htdocs/luci-static/nightfall/cascade.css');
const LIB = path.join(ROOT, 'luci-app-nightfall-monitor/root/usr/libexec');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
let fail = 0; const bad = m => { console.log('ОШИБКА: ' + m); fail = 1; };
const EXEC = (cmd, args) => {
	const n = path.basename(cmd);
	if (n === 'nightfall-stats') { try { return cp.execFileSync('sh', [path.join(LIB, 'nightfall-stats')].concat(args), { timeout: 20000 }).toString(); } catch (e) { return ''; } }
	if (n === 'nightfall-history' && args[0] === 'alerts') return '{"now":' + Math.floor(Date.now() / 1000) + ',"active":[],"rows":[]}';
	if (n === 'nightfall-apps' && args[0] === 'status') return JSON.stringify({ ok: true, lite: 0, enabled: 1, dnslog: 1024, dnsmap: 100, acct: '1' });
	if (n === 'nightfall-history' && args[0] === 'apps') return JSON.stringify({
		now: Math.floor(Date.now() / 1000), enabled: 1, dnsmap: 100, today: String(new Date().getFullYear()) + String(new Date().getMonth() + 1).padStart(2, '0') + String(new Date().getDate()).padStart(2, '0'),
		day: [
			[ '192.168.1.10', 'Яндекс', 3600000000, 10000000 ],
			[ '192.168.1.10', 'Apple', 800000000, 4000000 ],
			[ '192.168.1.10', 'Telegram', 67000000, 1000000 ],
			[ '192.168.1.10', 'Microsoft', 63000000, 1000000 ],
			[ '192.168.1.10', 'Google', 58000000, 1000000 ],
			[ '192.168.1.10', 'ВКонтакте', 36000000, 500000 ],
			[ '192.168.1.10', 'Cloudflare', 3800000, 100000 ],
			[ '192.168.1.10', 'Facebook', 190000, 7000 ],
			[ '192.168.1.10', 'Amazon', 96000, 23000 ],
			[ '192.168.1.10', 'Прочее · youtube.com', 6000000000, 100000000 ]
		], hist: []
	});
	return '{}';
};
const BOOT = `
function E(tag, attr, data) {
	const el = document.createElement(tag);
	if (attr != null && (typeof attr !== 'object' || Array.isArray(attr) || attr instanceof Node)) { data = attr; attr = {}; }
	for (const k in (attr || {})) { const v = attr[k];
		if (typeof v === 'function') el.addEventListener(k, v); else if (k === 'class') el.className = v; else if (v === true || v === '') el.setAttribute(k, ''); else if (v === false || v == null) continue; else el.setAttribute(k, v); }
	const add = d => { if (d == null || d === false) return; if (Array.isArray(d)) d.forEach(add); else if (d instanceof Node) el.appendChild(d); else el.appendChild(document.createTextNode(String(d))); };
	add(data); return el;
}
window.E = E; window._ = s => s;
const ok = v => Promise.resolve(v);
window.L = { env: { dispatchpath: [ 'admin', 'status', 'overview' ] }, require: () => ok({}), resolveDefault: (p, d) => Promise.resolve(p).catch(() => d) };
window.Nightfall = { set() {}, layout() {}, prefs: () => ({}) };
const baseclass = { extend: o => o };
const fs = { exec: (c, a) => window.__exec(c, a || []).then(s => ({ code: 0, stdout: s, stderr: '' })), read: () => ok(''), stat: () => ok(null), lines: () => ok([]) };
const rpc = { declare: spec => (...a) => ok(spec.method === 'dump' ? { interface: [] } : {}) };
const mod = (new Function('baseclass', 'fs', 'rpc', 'NfQr', SRC.replace(/^'require[^\\n]*\\n/gm, '')))(baseclass, fs, rpc, {});
window.__mod = mod; mod.__init__();
`;
(async () => {
	const b = await chromium.launch();
	for (const [vn, vp] of [ [ 'desktop', { width: 1280, height: 1000 } ], [ 'mobile', { width: 390, height: 900 } ] ]) {
		const p = await b.newPage({ viewport: vp, isMobile: vn === 'mobile', hasTouch: vn === 'mobile' });
		const errs = []; p.on('pageerror', e => errs.push(e.message));
		await p.exposeFunction('__exec', (c, a) => EXEC(c, a));
		await p.route('**/*', r => {
			const u = new URL(r.request().url());
			if (u.pathname === '/page') return r.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ru" data-nf-theme="dark"><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href="/c.css"></head><body><main><div id="view"><h2>Статус</h2>' +
				[ 'Система', 'Память', 'Сеть', 'Wi-Fi' ].map(t => '<div class="cbi-section"><div class="cbi-title"><h3>' + t + '</h3></div><div class="table"><div class="tr"><div class="td left">Строка</div><div class="td left">значение</div></div></div></div>').join('') +
				'<div class="ifacebox"><div class="ifacebox-head">lan1</div><div class="ifacebox-body"><img src="/icons/port_down.svg"><br>no link</div></div>' +
				'</div></main></body></html>' });
			if (u.pathname === '/c.css') return r.fulfill({ contentType: 'text/css', body: fs.readFileSync(CSS) });
			return r.fulfill({ status: 404, body: '' });
		});
		await p.goto('http://t.local/page');
		await p.addScriptTag({ content: 'const SRC = ' + JSON.stringify(SRC) + ';\n' + BOOT });
		await p.waitForTimeout(3500);
		const appRows = p.locator('.nf-apps-r');
		await appRows.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
		const appText = await p.locator('.nf-apps').textContent().catch(() => '');
		if (!appText.includes('Прочее')) bad(vn + ': категория «Прочее» скрылась за лимитом строк');
		if (!appText.includes('youtube.com')) bad(vn + ': домен YouTube не показан в деталях «Прочее»');
		if ((await appRows.count()) !== 9) bad(vn + ': ожидалось 8 приложений + «Прочее», получено ' + await appRows.count());
		if (!/Всего\\s+\\d/.test(appText)) bad(vn + ': итоговый объём не отображается в карточке приложений');
		if (await p.locator('.ifacebox .nf-port-edit').count() !== 1) bad(vn + ': не появилась кнопка переименования порта с текстовым заголовком LuCI');
		await p.evaluate(() => { window.prompt = () => 'Тестовый порт'; });
		await p.click('.ifacebox .nf-port-edit');
		const portName = await p.locator('.ifacebox .nf-port-title').textContent().catch(() => '');
		if (portName !== 'Тестовый порт') bad(vn + ': пользовательская подпись порта не применилась');
		if (await p.evaluate(() => JSON.parse(localStorage.getItem('nightfall-port-labels-v1') || '{}').lan1) !== 'Тестовый порт') bad(vn + ': подпись порта не сохранилась в localStorage');
		const t0 = await p.evaluate(() => document.body.textContent);
		if (!/Всё в порядке|Есть замечания|Требует внимания/.test(t0)) bad(vn + ': нет строки-вывода');
		if (!t0.includes('⚙ Вид')) bad(vn + ': нет меню «Вид»');
		const vis = sel => p.evaluate(s => Array.from(document.querySelectorAll(s)).filter(e => e.offsetParent !== null || getComputedStyle(e).display !== 'none').length, sel);
		if (await p.evaluate(() => document.querySelectorAll('.nf-grip').length) === 0) bad(vn + ': карточки не получили значков перемещения (проверка бессмысленна)');
		const shown = () => p.evaluate(() => Array.from(document.querySelectorAll('.nf-grip')).filter(e => getComputedStyle(e).display !== 'none').length);
		if (await shown() !== 0) bad(vn + ': значки перемещения видны вне режима раскладки');
		await p.click('.nf-viewmenu > summary'); await p.waitForTimeout(200);
		if (!(await p.evaluate(() => document.querySelector('.nf-viewmenu').open))) bad(vn + ': меню «Вид» не открылось');
		await p.screenshot({ path: path.join(OUT, 'overview-menu-' + vn + '.png') });
		await p.click('.nf-editbtn'); await p.waitForTimeout(300);
		if (await shown() === 0) bad(vn + ': в режиме раскладки значки перемещения не появились');
		if (!(await p.evaluate(() => document.documentElement.hasAttribute('data-nf-edit')))) bad(vn + ': режим раскладки не включился');
		await p.screenshot({ path: path.join(OUT, 'overview-edit-' + vn + '.png') });
		await p.click('.nf-viewmenu > summary'); await p.click('.nf-editbtn');
		await p.waitForTimeout(300);
		if (await shown() !== 0) bad(vn + ': после «Готово» значки остались');
		const folds = await p.evaluate(() => Array.from(document.querySelectorAll('.nf-fold')).map(e => ({ t: (e.querySelector('h3') || {}).textContent, open: e.classList.contains('nf-open'), bodyHidden: Array.from(e.children).filter(c => !c.classList.contains('cbi-title') && !c.classList.contains('nf-rs')).every(c => getComputedStyle(c).display === 'none') })));
		if (folds.length < 3) bad(vn + ': свёрнутых карточек ' + folds.length + ', ждали 3');
		for (const f of folds) if (f.open || !f.bodyHidden) bad(vn + ': карточка «' + f.t + '» не свёрнута по умолчанию');
		if (folds.length) { await p.click('.nf-fold > .cbi-title >> nth=0'); await p.waitForTimeout(200);
			if (!(await p.evaluate(() => document.querySelector('.nf-fold').classList.contains('nf-open')))) bad(vn + ': свёрнутая карточка не раскрылась по нажатию'); }
		await p.screenshot({ path: path.join(OUT, 'overview-' + vn + '.png'), fullPage: true });
		if (errs.length) bad(vn + ': ошибки страницы: ' + errs.slice(0, 3).join(' | '));
		await p.close();
	}
	await b.close();
	console.log(fail ? 'ТЕСТ ОБЗОРА НЕ ПРОЙДЕН' : 'ТЕСТ ОБЗОРА ПРОЙДЕН'); process.exit(fail);
})();
