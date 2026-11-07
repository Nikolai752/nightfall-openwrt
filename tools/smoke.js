// Дымовой тест: открывает тестовую страницу с темой, раскрывает панель «Персонализация»,
// проверяет, что оформление применилось, и сохраняет снимок в tools/out/.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const N = path.join(__dirname, '..', 'luci-theme-nightfall/htdocs/luci-static/nightfall');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const page = '<!doctype html><html lang="ru"><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href="/nightfall/cascade.css"><link rel=stylesheet href="/nightfall/mobile.css"><script>window.L={env:{sessionid:"S1",ubuspath:"/ubus/"}}</script><script src="/nightfall/nightfall.js"></script></head><body><header><div class="nf-pers"><span>P</span></div></header><div id="view"><h2>Обзор</h2></div></body></html>';
let fail = 0; const bad = m => { console.log('ОШИБКА: ' + m); fail = 1; };
(async () => {
	const b = await chromium.launch();
	for (const [name, vp] of [['desktop', { width: 1100, height: 800 }], ['mobile', { width: 390, height: 780 }]]) {
		const p = await b.newPage({ viewport: vp, hasTouch: name === 'mobile', isMobile: name === 'mobile' });
		p.on('pageerror', e => bad(name + ': ' + e.message));
		await p.route('**/*', r => {
			const u = new URL(r.request().url());
			if (u.pathname === '/page') return r.fulfill({ contentType: 'text/html', body: page });
			if (u.pathname === '/ubus/') return r.fulfill({ contentType: 'application/json', body: '{"jsonrpc":"2.0","id":1,"result":[0,{"code":0,"stdout":"{}"}]}' });
			const f = path.join(N, u.pathname.replace('/nightfall', ''));
			if (u.hostname === 't.local' && fs.existsSync(f) && fs.statSync(f).isFile())
				return r.fulfill({ body: fs.readFileSync(f), contentType: f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
			return r.fulfill({ status: 404, body: '' });
		});
		await p.goto('http://t.local/page'); await p.waitForTimeout(800);
		await p.evaluate(() => document.querySelector('.nf-pers-main').click()); await p.waitForTimeout(300);
		const st = await p.evaluate(() => {
			const t = document.querySelector('.nf-tabs [data-t]'), pop = document.querySelector('.nf-pop');
			return { pop: pop && getComputedStyle(pop).display, tabs: !!t, radius: t && getComputedStyle(t).borderRadius, bg: pop && getComputedStyle(pop).backgroundColor };
		});
		if (!st.pop || st.pop === 'none') bad(name + ': панель не открылась');
		if (!st.tabs) bad(name + ': нет вкладок панели');
		if (!st.radius || st.radius === '0px') bad(name + ': у вкладок нет оформления (CSS усечён?)');
		await p.screenshot({ path: path.join(OUT, name + '.png') });
		await p.close();
	}
	await b.close();
	console.log(fail ? 'ДЫМОВОЙ ТЕСТ НЕ ПРОЙДЕН' : 'ДЫМОВОЙ ТЕСТ ПРОЙДЕН'); process.exit(fail);
})();
