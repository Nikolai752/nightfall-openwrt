// Проверка экрана входа: «Запомнить имя» должно сохранять имя, возвращать его при следующем входе и не сохранять пароль.
// Модуль login.js запускается с заглушками LuCI (ui, view, E, _) на странице той же разметки, что отдаёт sysauth.ut.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'luci-theme-nightfall/htdocs/luci-static/resources/view/nightfall/login.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'luci-theme-nightfall/htdocs/luci-static/nightfall/cascade.css'), 'utf8');
let failed = 0; const bad = m => { failed++; console.error('ОШИБКА: ' + m); };
const page = user => '<!doctype html><html lang="ru"><head><meta charset=utf-8><style>' + CSS + '</style></head><body class="nf-blank modal-overlay-active"><div id="view" data-host="OpenWrt" data-model="Test"></div><section hidden><form method="post" class="cbi-map"><div class="cbi-value"><input name="luci_username" type="text" value="' + user + '"></div><div class="cbi-value"><div class="cbi-value-field"><input name="luci_password" type="password"></div></div></form><hr><button class="btn cbi-button-positive important">Войти</button></section></body></html>';
const SHIM = `
window.__submits = 0; HTMLFormElement.prototype.submit = function () { window.__submits++; }; HTMLFormElement.prototype.requestSubmit = function () { window.__submits++; window.__submitVisible = !!document.querySelector('input[type=password]').offsetParent; };
window._ = s => s;
window.E = function (tag, attrs, kids) {
	const n = document.createElement(tag);
	if (attrs && (attrs.nodeType || Array.isArray(attrs) || typeof attrs === 'string')) { kids = attrs; attrs = null; }
	for (const k in (attrs || {})) { const v = attrs[k]; if (typeof v === 'function') n.addEventListener(k, v); else if (k === 'class') n.className = v; else if (k === 'hidden') n.hidden = !!v; else n.setAttribute(k, v); }
	const add = c => { if (c == null) return; if (Array.isArray(c)) c.forEach(add); else n.appendChild(c.nodeType ? c : document.createTextNode(c)); };
	add(kids); return n;
};
const ui = { showModal(t, kids, cls) { const o = document.createElement('div'); o.id = 'modal_overlay'; o.className = 'active'; const m = document.createElement('div'); m.className = 'modal ' + (cls || ''); const h = document.createElement('h4'); h.textContent = t; m.appendChild(h); kids.forEach(k => m.appendChild(k)); o.appendChild(m); document.body.appendChild(o); return m; } };
const view = { extend: o => o };
window.__mod = new Function('ui', 'view', 'E', '_', window.__SRC.replace(/^\\s*'require [^']*';\\s*$/gm, '').replace('return view.extend', 'return view.extend'))(ui, view, window.E, window._);
window.__mod.render();`;
(async () => {
	const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
	await ctx.route('http://r.local/**', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: page('root') }));
	const open = async () => { const p = await ctx.newPage(); p.on('pageerror', e => bad('ошибка скрипта: ' + e.message)); await p.goto('http://r.local/'); await p.evaluate(src => { window.__SRC = src; }, SRC); await p.evaluate(SHIM); await p.waitForTimeout(150); return p; };
	let p = await open();
	if (await p.isChecked('#nf-remember')) bad('при первом входе флажок уже отмечен');
	await p.check('#nf-remember'); await p.fill('input[type=text]', 'admin'); await p.fill('input[type=password]', 'secret');
	await p.evaluate(() => document.querySelector('button.important').click());
	if (await p.evaluate(() => window.__submits) !== 1) bad('форма не отправлена');
	if (!await p.evaluate(() => window.__submitVisible)) bad('поля скрыты в момент отправки формы (менеджер паролей не увидит вход)');
	await p.waitForTimeout(150);
	if (!await p.evaluate(() => !!document.querySelector('.modal .spinning'))) bad('после отправки не показан индикатор входа');
	const ls = await p.evaluate(() => JSON.stringify(Object.entries(localStorage)));
	if (!ls.includes('"admin"')) bad('имя не сохранено: ' + ls);
	if (ls.includes('secret')) bad('пароль попал в localStorage');
	await p.close();
	p = await open();   // следующий визит: сервер подставляет root
	if (!await p.isChecked('#nf-remember')) bad('флажок «Запомнить» не восстановился');
	const u = await p.inputValue('input[type=text]');
	if (u !== 'admin') bad('имя не подставилось: «' + u + '»');
	// снять флажок: имя забывается
	await p.uncheck('#nf-remember'); await p.evaluate(() => document.querySelector('button.important').click());
	if ((await p.evaluate(() => JSON.stringify(Object.entries(localStorage)))).includes('admin')) bad('имя не забыто после снятия флажка');
	// Enter в поле пароля тоже сохраняет
	await p.close(); p = await open(); await p.check('#nf-remember'); await p.fill('input[type=text]', 'user2'); await p.press('input[type=password]', 'Enter');
	if (!(await p.evaluate(() => JSON.stringify(Object.entries(localStorage)))).includes('user2')) bad('Enter в поле пароля не сохраняет имя');
	await b.close();
	if (failed) { console.error('ТЕСТ ВХОДА НЕ ПРОЙДЕН'); process.exit(1); }
	console.log('ТЕСТ ВХОДА ПРОЙДЕН');
})();
