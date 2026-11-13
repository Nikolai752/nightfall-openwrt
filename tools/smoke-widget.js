// Проверка виджетов бота (Bot API 10.4): рисует их в Chromium с подставным TelegramWidget в светлой и тёмной теме,
// проверяет данные, цвета колец, размеры и сохраняет снимки в tools/out/. Настоящая среда Telegram (QuickJS) строже,
// поэтому здесь ещё и запрещены сеть и внешние ресурсы.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
const DIR = path.join(__dirname, '..', 'luci-app-nightfall-monitor/root/usr/share/nightfall/widgets');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
let fail = 0; const bad = m => { console.log('ОШИБКА: ' + m); fail = 1; };
const D1 = { h: 'Cudy-WR3000U', c: 12, m: 60, r: 38, t: 61.5, p: 12, d: 10.4, u: 1.2, w: 273000 };
const D2 = { h: 'Cudy-WR3000U', c: 95, m: 88, r: 92, t: 88, p: -1, d: 0, u: 0, w: 273006 };
const themes = {
	light: { scheme: 'light', bg: '#ffffff', text: '#000000', hint: '#6d6d72' },
	dark: { scheme: 'dark', bg: '#1c1c1e', text: '#ffffff', hint: '#98989f' },
};
(async () => {
	const b = await chromium.launch();
	for (const file of fs.readdirSync(DIR).filter(f => f.endsWith('.html'))) {
		const html = fs.readFileSync(path.join(DIR, file), 'utf8');
		const z = zlib.deflateSync(Buffer.from(html), { level: 9 }).length;
		if (Buffer.byteLength(html) > 32768 || z > 4096) bad(file + ': размер ' + Buffer.byteLength(html) + ' (сжатый ' + z + ') выше лимита Telegram');
		if (/https?:\/\/(?!www\.w3\.org)|<link|<iframe|@import|fetch\(|XMLHttpRequest|WebSocket/.test(html)) bad(file + ': внешние ресурсы или сеть недоступны в песочнице виджета');
		for (const [tn, th] of Object.entries(themes)) {
			const p = await b.newPage({ viewport: { width: 360, height: 400 }, deviceScaleFactor: 2, colorScheme: th.scheme });
			const errs = []; p.on('pageerror', e => errs.push(e.message));
			let calls = 0;
			await p.addInitScript(([d1, d2, th]) => {
				window.__calls = [];
				window.TelegramWidget = {
					profile: 1, isActive: true, colorScheme: th.scheme, chatData: JSON.stringify(d1), ready() {},
					onEvent() {}, isProfileAtLeast() { return true; },
					request(q) { window.__calls.push(q); return Promise.resolve({ result: JSON.stringify(window.__n ? d2 : d1) }); },
				};
				const st = document.createElement('style');   // тема Telegram: переменные на корневом элементе
				st.textContent = ':root{--tg-theme-text-color:' + th.text + ';--tg-theme-hint-color:' + th.hint + ';background:' + th.bg + '}';
				document.addEventListener('DOMContentLoaded', () => document.head.appendChild(st));
			}, [D1, D2, th]);
			await p.route('http://w.local/', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset=utf-8></head><body>' + html + '</body></html>' }));
			await p.goto('http://w.local/'); await p.waitForTimeout(400);
			const s1 = await p.evaluate(() => ({
				c: document.getElementById('cv').textContent, t: document.getElementById('t').textContent, p: document.getElementById('p').textContent,
				dn: document.getElementById('dn').textContent, host: document.getElementById('hn').textContent, f: document.getElementById('f').textContent,
				col: document.getElementById('c').getAttribute('stroke'), dot: document.getElementById('d').className,
				calls: window.__calls.length, w: document.documentElement.scrollWidth, h: document.body.scrollHeight,
			}));
			if (s1.c !== '12%') bad(file + ' ' + tn + ': кольцо процессора показывает ' + s1.c);
			if (s1.t !== '62 °C') bad(file + ' ' + tn + ': температура ' + s1.t);
			if (s1.p !== '12 мс') bad(file + ' ' + tn + ': пинг ' + s1.p);
			if (s1.host !== 'Cudy-WR3000U') bad(file + ' ' + tn + ': имя ' + s1.host);
			if (s1.col !== '#34c759') bad(file + ' ' + tn + ': цвет при нормальной нагрузке ' + s1.col);
			if (!/^Работает 3 д 3 ч/.test(s1.f)) bad(file + ' ' + tn + ': время работы «' + s1.f + '»');
			if (s1.calls < 1) bad(file + ' ' + tn + ': виджет не запросил данные при появлении');
			if (s1.w > 360) bad(file + ' ' + tn + ': горизонтальная прокрутка (' + s1.w + ' px)');
			if (s1.h > 600) bad(file + ' ' + tn + ': высота ' + s1.h + ' px больше 600');
			await p.screenshot({ path: path.join(OUT, 'widget-' + file.replace('.html', '') + '-' + tn + '.png') });
			await p.evaluate(() => { window.__n = 1; }); await p.mouse.click(180, 100); await p.waitForTimeout(300);
			const s2 = await p.evaluate(() => ({ col: document.getElementById('c').getAttribute('stroke'), dot: document.getElementById('d').className, p: document.getElementById('p').textContent }));
			if (s2.col !== '#ff453a') bad(file + ' ' + tn + ': высокая нагрузка не покраснела (' + s2.col + ')');
			if (s2.p !== 'нет' || !/x/.test(s2.dot)) bad(file + ' ' + tn + ': нет связи не показана');
			await p.screenshot({ path: path.join(OUT, 'widget-' + file.replace('.html', '') + '-' + tn + '-alert.png') });
			if (errs.length) bad(file + ' ' + tn + ': ошибки JS: ' + errs.join('; '));
			await p.close();
		}
	}
	await b.close();
	console.log(fail ? 'ТЕСТ ВИДЖЕТОВ НЕ ПРОЙДЕН' : 'ТЕСТ ВИДЖЕТОВ ПРОЙДЕН'); process.exit(fail);
})();
