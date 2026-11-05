/*
 * Nightfall theme: personalisation (mode, accent colour, motion).
 * Loaded from <head> so that the preferences are applied before first paint.
 * Preferences live in localStorage of the current browser, like Windows
 * "Personalization" lives in the current user profile.
 */
(function () {
	'use strict';

	var KEY = 'nightfall-prefs-v1';
	var root = document.documentElement;
	var DEFAULTS = { mode: 'auto', accent: '', motion: true, liteAuto: true, loginCells: [ 'net', 'up', 'fw' ], loginLogo: false, ovWide: false, bg: 'mica', bgScale: 100,
		density: 'normal', font: 'md', radius: 'md', glass: 'on', loginClock: true, loginInfo: true, loginBg: 'mica', ovLive: true, ovBadges: true,
		style: '', preset: 'win11', navMini: false, schedule: false, nightFrom: '20:00', dayFrom: '07:00', netBar: true, constLogin: true, constApp: false, constKind: 'net',
		updCheck: true, ovSize: 'md', glassTone: 'auto', glassBlur: 28, glassAlpha: 100, hints: true, ovTop: true, ovApps: true, ovBlock: true, ovWifi: true, ovEvents: true, ovHealth: true, ovQuick: true };

	var PRESETS = [
		[ 'win11', 'Windows 11', { style: '', accent: '', bg: 'mica', density: 'normal', font: 'md', radius: 'md', glass: 'on', motion: true } ],
		[ 'glass', 'Liquid Glass', { style: 'glass', accent: '#0a84ff', bg: 'mica', density: 'normal', font: 'md', radius: 'round', glass: 'on', motion: true } ]
	];
	var BGS = [ [ 'mica', 'Mica' ], [ 'flat', 'Плоский' ], [ 'dots', 'Точки' ], [ 'grid', 'Сетка' ], [ 'stars', 'Звёзды' ], [ 'aurora', 'Аврора' ], [ 'waves', 'Волны' ] ];

	var ACCENTS = [
		[ '', 'Синий (по умолчанию)', '#0067c0' ],
		[ '#4f6bed', 'Индиго' ], [ '#8764b8', 'Фиолетовый' ], [ '#b146c2', 'Орхидея' ],
		[ '#e3008c', 'Розовый' ], [ '#d13438', 'Красный' ], [ '#ca5010', 'Оранжевый' ],
		[ '#c19c00', 'Золотой' ], [ '#498205', 'Олива' ], [ '#107c10', 'Зелёный' ],
		[ '#038387', 'Бирюзовый' ], [ '#69797e', 'Графит' ]
	];

	function load() {
		try {
			var p = JSON.parse(window.localStorage.getItem(KEY) || 'null');
			return Object.assign({}, DEFAULTS, p && typeof p === 'object' ? p : {});
		} catch (e) {
			return Object.assign({}, DEFAULTS);
		}
	}

	function save() {
		try { window.localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) { /* private mode */ }
		if (!fromRouter) { setLocalT(Date.now()); push(); }
	}

	/* ---------- копия настроек на роутере ----------
	 * Настройки лежат в localStorage, а он у каждого браузера (и у ярлыка на экране «Домой») свой и может очищаться.
	 * Поэтому после входа копия пишется на роутер (/etc/nightfall-prefs.json, раздаётся как prefs.json),
	 * а при открытии страницы, в том числе экрана входа, подтягивается более новая версия. */
	var TKEY = 'nightfall-prefs-t';
	var fromRouter = false, pushTimer = 0, dirty = false;
	var BASE = (function () { var s = document.currentScript; return s && s.src ? s.src.replace(/[^\/]*$/, '') : '/luci-static/nightfall/'; })();
	function localT() { try { return +window.localStorage.getItem(TKEY) || 0; } catch (e) { return 0; } }
	function setLocalT(t) { try { window.localStorage.setItem(TKEY, String(t)); } catch (e) { /* ignore */ } }
	function sid() { var l = window.L; return l && l.env && l.env.sessionid ? l.env : null; }
	function pushNow() {
		clearTimeout(pushTimer); pushTimer = 0;
		var env = sid();
		if (!dirty || !env || !window.fetch) return;
		dirty = false;
		var data = JSON.stringify({ t: localT() || Date.now(), p: prefs });
		window.fetch(env.ubuspath || '/ubus/', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [ env.sessionid, 'file', 'exec',
				{ command: '/usr/libexec/nightfall-config', params: [ 'prefs-set', data ] } ] }) }).catch(function () { dirty = true; });
	}
	function push() {
		dirty = true;
		clearTimeout(pushTimer);
		pushTimer = setTimeout(pushNow, 15000);      /* ползунки не должны писать на флеш на каждый шаг */
	}
	function pull() {
		if (!window.fetch) return;
		window.fetch(BASE + 'prefs.json?' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
			var lt = localT(), hasLocal = false;
			try { hasLocal = !!window.localStorage.getItem(KEY); } catch (e) { /* ignore */ }
			if (d && typeof d.t === 'number' && d.p && typeof d.p === 'object') {
				if (d.t > lt) {
					fromRouter = true;
					prefs = Object.assign({}, DEFAULTS, d.p);
					try { window.localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
					setLocalT(d.t); fromRouter = false;
					applyAll(); refreshPanel();
					return;
				}
				if (d.t === lt) return;
			}
			if (hasLocal && sid()) { if (!lt) setLocalT(Date.now()); dirty = true; pushNow(); }   /* на роутере нет или старее: сохраняем текущие */
		}).catch(function () { /* нет копии на роутере — работаем с локальной */ });
	}
	document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') pushNow(); });
	window.addEventListener('pagehide', pushNow);
	window.addEventListener('load', function () { window.setTimeout(function () { pull(); window.setTimeout(fetchLogo, 700); }, 200); window.setTimeout(loadVer, 600); });

	var prefs = load();
	var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: false };
	var mqMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

	/* ---------- colour helpers ---------- */
	function hexToRgb(h) {
		h = String(h || '').replace('#', '');
		if (h.length === 3) h = h.replace(/(.)/g, '$1$1');
		if (!/^[0-9a-f]{6}$/i.test(h)) return null;
		return [ parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16) ];
	}

	function rgbToHex(c) {
		return '#' + c.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }).join('');
	}

	function rgbToHsl(c) {
		var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
		var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
		if (max !== min) {
			var d = max - min;
			s = l > .5 ? d / (2 - max - min) : d / (max + min);
			h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
			h *= 60;
		}
		return [ h, s * 100, l * 100 ];
	}

	function hslToRgb(c) {
		var h = c[0] / 360, s = c[1] / 100, l = c[2] / 100;
		function f(p, q, t) {
			if (t < 0) t += 1; if (t > 1) t -= 1;
			if (t < 1 / 6) return p + (q - p) * 6 * t;
			if (t < 1 / 2) return q;
			if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
			return p;
		}
		if (s === 0) return [ l * 255, l * 255, l * 255 ];
		var q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
		return [ f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255 ];
	}

	function lum(c) {
		var a = c.map(function (v) { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); });
		return .2126 * a[0] + .7152 * a[1] + .0722 * a[2];
	}

	function contrast(a, b) {
		var la = lum(a), lb = lum(b);
		return (Math.max(la, lb) + .05) / (Math.min(la, lb) + .05);
	}

	function hsl(h, s, l) { return rgbToHex(hslToRgb([ h, s, Math.max(0, Math.min(100, l)) ])); }

	/* ---------- apply ---------- */
	var VARS = [ '--nf-accent', '--nf-accent-hover', '--nf-accent-press', '--nf-on-accent',
		'--primary-color-high', '--primary-color-medium', '--primary-color-low', '--on-primary-color' ];

	function mins(v, def) {
		var m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ''));
		return m ? (+m[1]) * 60 + (+m[2]) : def;
	}

	function scheduleDark() {
		var d = new Date(), t = d.getHours() * 60 + d.getMinutes();
		var night = mins(prefs.nightFrom, 1200), day = mins(prefs.dayFrom, 420);

		if (night === day) return false;
		return night > day ? (t >= night || t < day) : (t >= night && t < day);
	}

	function isDark() {
		if (root.hasAttribute('data-nf-fixed'))
			return root.getAttribute('data-darkmode') === 'true';

		if (prefs.schedule) return scheduleDark();

		return prefs.mode === 'dark' || (prefs.mode !== 'light' && !!mq.matches);
	}

	function applyAccent() {
		var st = root.style, rgb = hexToRgb(prefs.accent);

		if (!rgb) {
			VARS.forEach(function (n) { st.removeProperty(n); });
			root.removeAttribute('data-nf-accent');
			return;
		}

		var c = rgbToHsl(rgb), dark = isDark(), l = c[2], n = 0;

		if (dark) {
			l = Math.max(l, 62);
		} else {
			while (n++ < 24 && contrast(hslToRgb([ c[0], c[1], l ]), [ 255, 255, 255 ]) < 3.6 && contrast(hslToRgb([ c[0], c[1], l ]), [ 0, 0, 0 ]) < 4.5)
				l -= 2;
		}

		var base = hslToRgb([ c[0], c[1], l ]);
		var on = contrast(base, [ 255, 255, 255 ]) >= 3.6 && !dark ? '#ffffff' : (contrast(base, [ 0, 0, 0 ]) >= 4.5 ? '#000000' : '#ffffff');
		var accent = rgbToHex(base), hover = hsl(c[0], c[1], l + (dark ? 5 : 7)), press = hsl(c[0], c[1], l + (dark ? -8 : 13));

		st.setProperty('--nf-accent', accent);
		st.setProperty('--nf-accent-hover', hover);
		st.setProperty('--nf-accent-press', press);
		st.setProperty('--nf-on-accent', on);
		st.setProperty('--primary-color-high', accent);
		st.setProperty('--primary-color-medium', hsl(c[0], c[1], l - 6));
		st.setProperty('--primary-color-low', hsl(c[0], c[1], l - 12));
		st.setProperty('--on-primary-color', on);
		root.setAttribute('data-nf-accent', '1');
	}

	function applyMode() {
		if (!root.hasAttribute('data-nf-fixed'))
			root.setAttribute('data-darkmode', String(isDark()));

		applyAccent();
	}

	/* ---- своя картинка на экране входа: копия в localStorage (быстро) и на роутере (logo.json, для других браузеров) ---- */
	var LOGOKEY = 'nightfall-logo-v1';
	function applyLogo() {
		var d = null;
		try { d = window.localStorage.getItem(LOGOKEY); } catch (e) { /* ignore */ }
		if (prefs.loginLogo && d && /^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+\/=]+$/.test(d)) {
			root.style.setProperty('--nf-logo', 'url("' + d + '")');
			root.setAttribute('data-nf-logo', 'custom');
		}
		else {
			root.style.removeProperty('--nf-logo');
			root.setAttribute('data-nf-logo', 'default');
		}
	}
	function fetchLogo() {
		if (!prefs.loginLogo || !window.fetch) return;
		try { if (window.localStorage.getItem(LOGOKEY)) return; } catch (e) { return; }
		window.fetch(BASE + 'logo.json?' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
			if (d && typeof d.d === 'string') { try { window.localStorage.setItem(LOGOKEY, d.d); } catch (e) { /* ignore */ } applyLogo(); }
		}).catch(function () { /* нет картинки на роутере */ });
	}
	function routerExec(args) {
		var env = sid();
		if (!env || !window.fetch) return Promise.reject(new Error('нет сессии'));
		return window.fetch(env.ubuspath || '/ubus/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [ env.sessionid, 'file', 'exec', { command: '/usr/libexec/nightfall-config', params: args } ] }) })
			.then(function (r) { return r.json(); }).then(function (j) {
				var o = j && j.result && j.result[1] ? j.result[1] : {};
				var out = {}; try { out = JSON.parse(o.stdout || '{}'); } catch (e) { /* ignore */ }
				if (!out.ok) throw new Error(out.error || 'роутер не принял картинку (после обновления выйдите и войдите в LuCI снова)');
			});
	}
	function readLogo(file, done) {
		var img = new Image(), url = window.URL.createObjectURL(file);
		img.onload = function () {
			var side = 256, out = '';
			for (var i = 0; i < 5; i++) {
				var sc = Math.min(1, side / Math.max(img.width, img.height) );
				var cv = document.createElement('canvas');
				cv.width = Math.max(1, Math.round(img.width * sc)); cv.height = Math.max(1, Math.round(img.height * sc));
				cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
				out = cv.toDataURL('image/webp', .9);
				if (out.indexOf('data:image/webp') !== 0) out = cv.toDataURL('image/png');
				if (out.length <= 60000) break;
				side = Math.round(side * .7);
			}
			window.URL.revokeObjectURL(url);
			done(out.length <= 80000 ? out : null);
		};
		img.onerror = function () { window.URL.revokeObjectURL(url); done(null); };
		img.src = url;
	}


	/* ---------- карточки со сводкой на экране входа ----------
	 * Рисуются здесь, а не в login.js: этот файл подключается с номером сборки и обновляется сразу,
	 * а модули LuCI браузер может держать в кэше после обновления темы. */
	var LTXT = {
		ru: { net: 'Интернет', up: 'Работает', fw: 'Прошивка', speed: 'Скорость', test: 'Замер скорости', mbit: 'Мбит/с', temp: 'Температура', cpu: 'Процессор', mem: 'Память', cl: 'Устройств',
			online: 'есть', offline: 'нет связи', nodata: 'нет данных', ms: 'мс', d: 'д', h: 'ч', m: 'мин', dec: ',' },
		en: { net: 'Internet', up: 'Uptime', fw: 'Firmware', speed: 'Speed', test: 'Speed test', mbit: 'Mbit/s', temp: 'Temperature', cpu: 'CPU', mem: 'Memory', cl: 'Devices',
			online: 'online', offline: 'offline', nodata: 'no data', ms: 'ms', d: 'd', h: 'h', m: 'min', dec: '.' }
	};
	function loginCell(key, d, T) {
		var num = function (k) { var v = d[k]; return v === '' || v === undefined || isNaN(parseFloat(v)) ? null : parseFloat(v); };
		var fmt = function (n) { return (Math.round(n * 10) / 10).toString().replace('.', T.dec); };
		var mbit = function (bps) { return fmt(parseFloat(bps) * 8 / 1e6); };
		var box = function (cls, label, val, kids, title) {
			var b = h('b', {}, kids || []); if (!kids) b.textContent = val;
			var a = { 'class': 'nf-st' + (cls ? ' ' + cls : '') }; if (title) a.title = title;
			return h('div', a, [ h('span', { text: label }), b ]);
		};
		var v;
		switch (key) {
		case 'net':
			return box('nf-st-' + (d.net || 'none'), T.net, '', [ h('i', { 'class': 'nf-dot' }), document.createTextNode(d.net === 'up' ? (d.ms !== '' ? d.ms + ' ' + T.ms : T.online) : d.net === 'down' ? T.offline : T.nodata) ]);
		case 'speed':
			v = num('rx');
			return box('nf-st-speed', T.speed, v === null ? T.nodata : '↓' + mbit(v) + ' ↑' + mbit(num('tx') || 0), null, T.mbit);
		case 'test':
			v = num('spd');
			return box('', T.test, v === null ? T.nodata : Math.round(v) + ' ' + T.mbit);
		case 'up':
			v = parseInt(d.up, 10);
			if (isNaN(v)) return null;
			var dd = Math.floor(v / 86400), hh = Math.floor(v % 86400 / 3600), mm = Math.floor(v % 3600 / 60);
			return box('', T.up, dd > 0 ? dd + T.d + ' ' + hh + T.h : hh > 0 ? hh + T.h + ' ' + mm + T.m : mm + ' ' + T.m);
		case 'fw':
			return d.rel ? box('', T.fw, d.rel) : null;
		case 'temp':
			v = num('temp');
			return box('', T.temp, v === null || v < 0 ? T.nodata : Math.round(v) + ' °C');
		case 'cpu':
			v = num('cpu');
			return box('', T.cpu, v === null || v < 0 ? T.nodata : Math.round(v) + ' %');
		case 'mem':
			v = num('mem');
			return box('', T.mem, v === null || v < 0 ? T.nodata : Math.round(v) + ' %');
		case 'clients':
			v = num('cl');
			return box('', T.cl, v === null ? T.nodata : String(v));
		}
		return null;
	}
	function renderLoginStats() {
		var info = document.getElementById('view'), plate = document.querySelector('.modal.login .nf-plate');
		if (!info || !plate || info.dataset.local !== '1') return;
		var keys = Array.isArray(prefs.loginCells) ? prefs.loginCells.slice(0, 3) : [ 'net', 'up', 'fw' ];
		var T = /^ru|^uk|^be/i.test(document.documentElement.lang || '') ? LTXT.ru : LTXT.en;
		var cells = keys.map(function (k) { return loginCell(k, info.dataset, T); }).filter(Boolean);
		var sig = keys.join(',') + '|' + Object.keys(info.dataset).map(function (k) { return info.dataset[k]; }).join(',');
		var old = plate.parentNode.querySelector('.nf-stats');
		if (old && old.getAttribute('data-sig') === sig) return;
		if (old) old.remove();
		if (!cells.length) return;
		var box = h('div', { 'class': 'nf-stats', 'data-n': String(cells.length), 'data-sig': sig }, cells);
		plate.parentNode.insertBefore(box, plate.nextSibling);
	}
	document.addEventListener('DOMContentLoaded', function () {
		if (!document.body || !document.body.classList.contains('nf-blank')) return;
		renderLoginStats();
		new MutationObserver(renderLoginStats).observe(document.body, { childList: true, subtree: true });
		document.addEventListener('nf-prefs', renderLoginStats);
	});

	/* слабое устройство: мало памяти или ядер; тогда анимации выключаются сами (можно отключить это в «Персонализации») */
	function weakDevice() {
		try { return (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2); } catch (e) { return false; }
	}

	/* часть суток для фона входа: утро 5–10, день 10–17, вечер 17–21, ночь 21–5 */
	function todPart() {
		var hr = new Date().getHours();
		return hr >= 5 && hr < 10 ? 'dawn' : hr >= 10 && hr < 17 ? 'day' : hr >= 17 && hr < 21 ? 'dusk' : 'night';
	}

	function applyMotion() {
		var off = !prefs.motion || mqMotion.matches || (prefs.liteAuto !== false && weakDevice());

		if (off) root.setAttribute('data-nf-motion', 'off');
		else root.removeAttribute('data-nf-motion');
	}

	/* ---- mobile: bottom tab bar + bottom sheet built from the main menu ---- */
	var TAB_ICONS = {
		status: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
		system: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
		services: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
		network: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
		vpn: '<path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/>',
		logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
		docker: '<path d="M3 12h18v2a6 6 0 0 1-6 6H8a5 5 0 0 1-5-5z"/><path d="M6 12V9h3v3M10 12V9h3v3M14 12V9h3v3M10 9V6h3v3"/>',
		modem: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 17h.01M11 17h.01M8 9a6 6 0 0 1 8 0M10.5 6a2.8 2.8 0 0 1 3 0"/>',
		more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>'
	};
	function tabIcon(k) {
		var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
		s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
		s.innerHTML = TAB_ICONS[k] || '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 12h6"/>';
		return s;
	}
	function initTabbar() {
		var menu = document.getElementById('topmenu');
		if (!menu || document.getElementById('nf-tabbar')) return;
		var bar = h('nav', { id: 'nf-tabbar', 'aria-label': 'Разделы' });
		var sheet = h('div', { id: 'nf-sheet', 'aria-hidden': 'true' });
		var panel = h('div', { 'class': 'nf-sheet-p', role: 'dialog' });
		sheet.appendChild(panel);
		document.body.appendChild(bar); document.body.appendChild(sheet);

		function close() { sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true'); Array.prototype.forEach.call(bar.children, function (b) { b.classList.remove('sel'); }); }
		function links(li) { return Array.prototype.slice.call(li.querySelectorAll('ul a[href]')).filter(function (a) { return a.getAttribute('href') !== '#'; }); }
		function fill(items, headers) {
			panel.textContent = '';
			items.forEach(function (li) {
				var here = location.pathname + location.search;
				var own = li.firstElementChild, ls = links(li);
				/* пункт без подменю (например «Выйти») — просто ссылка */
				if (!ls.length && own && own.getAttribute('href') && own.getAttribute('href') !== '#') {
					var one = h('a', { href: own.getAttribute('href'), 'class': 'nf-sheet-single', text: own.textContent });
					if (li.classList.contains('active')) one.className += ' cur';
					panel.appendChild(one);
					return;
				}
				if (headers) panel.appendChild(h('div', { 'class': 'nf-sheet-h', text: own.textContent }));
				ls.forEach(function (a) {
					var l = h('a', { href: a.getAttribute('href'), text: a.textContent });
					if (a.parentNode.classList.contains('active') || a.classList.contains('active') || (a.pathname + a.search) === here) l.className = 'cur';
					panel.appendChild(l);
				});
			});
		}
		function open(btn, items, headers) {
			if (sheet.classList.contains('open') && btn.classList.contains('sel')) return close();
			close(); fill(items, headers); btn.classList.add('sel');
			sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false');
		}
		sheet.addEventListener('click', function (ev) { if (ev.target === sheet || ev.target.tagName === 'A') close(); });
		bar.addEventListener('click', function () { buzz(8); }, true);
		/* свайп вниз закрывает шторку (когда она прокручена к началу) */
		(function () {
			var y0 = null, dy = 0;
			panel.addEventListener('touchstart', function (ev) { y0 = panel.scrollTop <= 0 ? ev.touches[0].clientY : null; dy = 0; panel.style.transition = 'none'; }, { passive: true });
			panel.addEventListener('touchmove', function (ev) {
				if (y0 === null) return;
				dy = ev.touches[0].clientY - y0;
				if (dy > 0) panel.style.transform = 'translateY(' + dy + 'px)';
			}, { passive: true });
			panel.addEventListener('touchend', function () {
				panel.style.transition = ''; panel.style.transform = '';
				if (y0 !== null && dy > 90) { buzz(10); close(); }
				y0 = null; dy = 0;
			});
		})();
		document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') close(); });

		function build() {
			var lis = Array.prototype.filter.call(menu.children, function (li) { return li.tagName === 'LI' && !li.classList.contains('nf-nores') && li.firstElementChild; });
			if (!lis.length) return false;
			bar.textContent = '';
			var shown = lis.length > 5 ? lis.slice(0, 4) : lis, rest = lis.length > 5 ? lis.slice(4) : [];
			shown.forEach(function (li) {
				var b = h('button', { type: 'button' }, [ tabIcon(li.getAttribute('data-name')), h('span', { text: li.firstElementChild.textContent }) ]);
				if (li.classList.contains('active')) b.setAttribute('aria-current', 'page');
				b.addEventListener('click', function () {
					var ls = links(li);
					if (ls.length) open(b, [ li ], false); else if (li.firstElementChild.getAttribute('href') !== '#') location.href = li.firstElementChild.getAttribute('href');
				});
				bar.appendChild(b);
			});
			if (rest.length) {
				var m = h('button', { type: 'button' }, [ tabIcon('more'), h('span', { text: 'Ещё' }) ]);
				if (rest.some(function (li) { return li.classList.contains('active'); })) m.setAttribute('aria-current', 'page');
				m.addEventListener('click', function () { open(m, rest, true); });
				bar.appendChild(m);
			}
			document.body.classList.add('nf-has-tabbar');
			return true;
		}
		if (!build()) {
			var mo = new MutationObserver(function () { if (build()) mo.disconnect(); });
			mo.observe(menu, { childList: true });
		}
	}

	/* ярлык «Перезапустить Wi-Fi»: открывается обзор, кнопка подсвечивается, действие подтверждается как обычно */
	function initHashAction() {
		if (location.hash !== '#nf-wifi') return;
		var tries = 0, t = setInterval(function () {
			var btns = Array.prototype.slice.call(document.querySelectorAll('.nf-qa'));
			var b = btns.filter(function (x) { return /wi-?fi/i.test(x.textContent); })[0];
			if (b) { clearInterval(t); b.scrollIntoView({ block: 'center', behavior: 'smooth' }); b.classList.add('nf-pulse'); setTimeout(function () { b.classList.remove('nf-pulse'); }, 4500); }
			else if (++tries > 40) clearInterval(t);
		}, 250);
	}

	/* ---- мобильные жесты и быстрая работа ---- */
	function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }
	var mqPhone = window.matchMedia('(max-width: 899px)');

	/* потянуть вниз — обновить страницу (только у верхнего края и без открытых окон) */
	function initPull() {
		var ind = h('div', { id: 'nf-ptr', 'aria-hidden': 'true' }, [ h('span') ]);
		document.body.appendChild(ind);
		var y0 = null, pull = 0, busy = false, LIM = 84;
		function blocked(t) { return !!(t.closest && t.closest('.nf-pop, #nf-sheet, .modal, input, select, textarea, .cbi-dropdown, .nf-tabscroll, .nf-live-grid, table')); }
		document.addEventListener('touchstart', function (ev) {
			y0 = null;
			if (!mqPhone.matches || busy || window.scrollY > 0 || document.body.classList.contains('modal-overlay-active') || blocked(ev.target)) return;
			y0 = ev.touches[0].clientY; pull = 0;
		}, { passive: true });
		document.addEventListener('touchmove', function (ev) {
			if (y0 === null) return;
			var d = ev.touches[0].clientY - y0;
			if (d <= 0 || window.scrollY > 0) { pull = 0; ind.style.setProperty('--pull', 0); ind.classList.remove('on'); return; }
			pull = Math.min(d * .5, LIM + 20);
			ind.classList.add('on'); ind.classList.toggle('ready', pull >= LIM);
			ind.style.setProperty('--pull', pull + 'px');
		}, { passive: true });
		document.addEventListener('touchend', function () {
			if (y0 === null) return;
			var go = pull >= LIM; y0 = null;
			if (go) { busy = true; buzz(12); ind.classList.add('spin'); setTimeout(function () { location.reload(); }, 150); }
			else { ind.classList.remove('on', 'ready'); ind.style.setProperty('--pull', 0); }
		});
	}

	/* таблицы мониторинга: подписи столбцов в каждой ячейке, чтобы строки стали карточками */
	function labelTables() {
		Array.prototype.forEach.call(document.querySelectorAll('.nfm-table'), function (t) {
			var heads = Array.prototype.map.call(t.querySelectorAll('thead th'), function (th) { return th.textContent.replace(/\s*[↓↑]\s*$/, '').trim(); });
			Array.prototype.forEach.call(t.querySelectorAll('tbody tr'), function (tr) {
				Array.prototype.forEach.call(tr.children, function (td, i) { if (heads[i] && td.getAttribute('data-l') !== heads[i]) td.setAttribute('data-l', heads[i]); });
			});
		});
	}
	function initMobile() {
		initPull();
		var raf = 0;
		new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; labelTables(); }); })
			.observe(document.body, { childList: true, subtree: true });
		labelTables();
		/* лёгкая вибрация на быстрых действиях обзора */
		document.addEventListener('click', function (ev) { if (ev.target.closest && ev.target.closest('.nf-qa')) buzz(10); }, true);
	}

	/* ---- подсказки по терминам ---- */
	var installEvt = null;
	window.addEventListener('beforeinstallprompt', function (ev) { ev.preventDefault(); installEvt = ev; if (refs.install) refs.install.hidden = false; });

	var GLOSS = [
		[ 'MTU', 'MTU', 'Максимальный размер одного пакета в байтах. Обычно 1500, для PPPoE 1492. Слишком большое значение ломает часть сайтов.' ],
		[ 'DHCP', 'DHCP', 'Служба, которая автоматически выдаёт устройствам IP-адрес, шлюз и DNS при подключении к сети.' ],
		[ 'DNS', 'DNS', 'Переводит имена сайтов в IP-адреса. Если DNS не отвечает, сайты не открываются, хотя интернет есть.' ],
		[ 'NAT', 'NAT', 'Трансляция адресов: все устройства дома выходят в интернет под одним внешним адресом роутера.' ],
		[ 'SSID', 'SSID', 'Имя Wi‑Fi сети, которое видно в списке сетей на телефоне и ноутбуке.' ],
		[ 'WPA3', 'WPA3', 'Новый стандарт защиты Wi‑Fi. Надёжнее WPA2, но старые устройства могут его не поддерживать.' ],
		[ 'WPA2', 'WPA2', 'Распространённый стандарт защиты Wi‑Fi паролем. Подходит почти всем устройствам.' ],
		[ 'VLAN', 'VLAN', 'Логическое разделение сети на изолированные сегменты на одних и тех же кабелях и портах.' ],
		[ 'MAC', 'MAC-адрес', 'Уникальный адрес сетевой карты устройства. По нему роутер отличает одно устройство от другого.' ],
		[ 'IPv6', 'IPv6', 'Новая версия адресов в интернете с гораздо большим пространством, чем IPv4.' ],
		[ 'TTL', 'TTL', 'Сколько «прыжков» через роутеры может пройти пакет, прежде чем будет отброшен.' ],
		[ 'QoS', 'QoS', 'Приоритизация трафика: например, звонки и игры получают канал раньше загрузок.' ],
		[ 'SQM', 'SQM', 'Умное управление очередями, снижает задержку под нагрузкой (bufferbloat).' ],
		[ 'WAN', 'WAN', 'Внешняя сеть: подключение роутера к провайдеру и интернету.' ],
		[ 'LAN', 'LAN', 'Локальная сеть дома: устройства, подключённые к роутеру кабелем или по Wi‑Fi.' ],
		[ 'PPPoE', 'PPPoE', 'Способ подключения к провайдеру по логину и паролю. Часто встречается у DSL и некоторых оптоволоконных провайдеров.' ],
		[ 'DMZ', 'DMZ', 'Устройство, для которого открыты все входящие соединения. Используйте с осторожностью.' ],
		[ 'DFS', 'DFS', 'Каналы 5 ГГц, которые нужно освобождать при обнаружении радара. Могут быть чище, но иногда переключаются сами.' ],
		[ 'ARP', 'ARP', 'Сопоставляет IP-адреса и MAC-адреса устройств в локальной сети.' ],
		[ 'NTP', 'NTP', 'Синхронизация времени через интернет. Нужна для журналов и сертификатов.' ],
		[ 'SSH', 'SSH', 'Защищённый удалённый доступ к командной строке роутера.' ],
		[ 'шлюз', 'Шлюз', 'Адрес устройства, через которое трафик уходит за пределы вашей сети, обычно роутер провайдера.' ],
		[ 'маска', 'Маска подсети', 'Определяет, какая часть IP-адреса относится к сети, а какая к устройству. Чаще всего 255.255.255.0.' ],
		[ 'мост', 'Мост', 'Объединяет несколько портов или сетей в одну, как будто они подключены к одному коммутатору.' ],
		[ 'Bridge', 'Мост (bridge)', 'Объединяет несколько портов или сетей в одну, как будто они подключены к одному коммутатору.' ],
		[ 'Beamforming', 'Beamforming', 'Роутер направляет сигнал Wi‑Fi в сторону устройства, улучшая скорость и дальность.' ],
		[ 'Mesh', 'Mesh', 'Несколько точек доступа образуют одну Wi‑Fi сеть с бесшовным переходом между ними.' ],
		[ 'DDNS', 'DDNS', 'Постоянное имя для роутера, даже если провайдер меняет внешний IP-адрес.' ],
		[ 'Firewall', 'Файрвол', 'Межсетевой экран: решает, какой трафик пропускать, а какой блокировать.' ],
		[ 'Межсетевой экран', 'Межсетевой экран', 'Решает, какой трафик пропускать, а какой блокировать.' ]
	].map(function (g) {
		var w = g[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return { re: new RegExp('(^|[^\\p{L}\\d])' + w + '(?![\\p{L}\\d])', 'iu'), t: g[1], d: g[2] };
	});
	var tip = null, tipOwner = null;

	function showTip(el) {
		if (!el.getAttribute('data-t') || document.body.classList.contains('nf-blank')) return;
		if (!tip) { tip = document.createElement('div'); tip.id = 'nf-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
		tip.textContent = '';
		tip.appendChild(h('b', { text: el.getAttribute('data-t') }));
		tip.appendChild(document.createTextNode(el.getAttribute('data-d')));
		var r = el.getBoundingClientRect();
		tip.style.left = '0px'; tip.style.top = '0px';
		var w = tip.offsetWidth, hh = tip.offsetHeight;
		var x = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
		var y = r.bottom + 8 + hh > window.innerHeight ? r.top - hh - 8 : r.bottom + 8;
		tip.style.left = x + 'px'; tip.style.top = Math.max(8, y) + 'px';
		tip.classList.add('on'); tipOwner = el;
	}
	function hideTip() { if (tip) tip.classList.remove('on'); tipOwner = null; }

	function addHints() {
		if (prefs.hints === false) return;
		var list = document.querySelectorAll('#maincontent .cbi-value-title:not([data-nfh]), #maincontent .table .th:not([data-nfh])');
		Array.prototype.forEach.call(list, function (el) {
			el.setAttribute('data-nfh', '1');
			var txt = el.textContent || '';
			if (txt.length > 90) return;
			for (var i = 0; i < GLOSS.length; i++) {
				if (GLOSS[i].re.test(txt)) {
					el.appendChild(h('i', { 'class': 'nf-hint', tabindex: '0', role: 'note', 'data-t': GLOSS[i].t, 'data-d': GLOSS[i].d, 'aria-label': GLOSS[i].t + ': ' + GLOSS[i].d, text: '?' }));
					break;
				}
			}
		});
	}
	/* Вызываем сразу из MutationObserver (до отрисовки кадра): LuCI пересоздаёт таблицы при каждом опросе,
	   и значок «?», добавленный позже по таймеру, каждый раз сдвигал заголовки и дёргал страницу. */
	function scheduleHints() { addHints(); }
	document.addEventListener('DOMContentLoaded', function () {
		scheduleHints();
		new MutationObserver(scheduleHints).observe(document.body, { childList: true, subtree: true });
		document.addEventListener('mouseover', function (ev) { var t = ev.target.closest && ev.target.closest('.nf-hint'); if (t) showTip(t); });
		document.addEventListener('mouseout', function (ev) { var t = ev.target.closest && ev.target.closest('.nf-hint'); if (t) hideTip(); });
		document.addEventListener('focusin', function (ev) { var t = ev.target.closest && ev.target.closest('.nf-hint'); if (t) showTip(t); });
		document.addEventListener('focusout', hideTip);
		document.addEventListener('click', function (ev) {
			var t = ev.target.closest && ev.target.closest('.nf-hint');
			if (t) { ev.preventDefault(); ev.stopPropagation(); if (tipOwner === t) hideTip(); else showTip(t); } else hideTip();
		}, true);
		window.addEventListener('scroll', hideTip, true);
	});

	/* ---- icons in card titles (Overview, Monitor): one set, drawn per style in CSS ---- */
	var TITLE_ICONS = [
		[ /интернет/i, 'globe' ], [ /порт/i, 'port' ], [ /беспровод|wi.?fi|радио|эфир/i, 'wifi' ], [ /состояние роутера|здоров/i, 'pulse' ],
		[ /^сеть|сетев|интерфейс|адрес|шлюз/i, 'net' ], [ /процессор|нагрузка|системн|^система|^cpu/i, 'cpu' ], [ /памят|озу|ram/i, 'mem' ],
		[ /хранил|диск|накопит|flash|флеш/i, 'disk' ], [ /dhcp|аренд|клиент|устройств/i, 'users' ], [ /событ|журнал|лог/i, 'bell' ],
		[ /быстр|действ/i, 'bolt' ], [ /топ|трафик|скорост|график|статистик/i, 'chart' ], [ /соединен|conntrack/i, 'link' ],
		[ /маршрут/i, 'route' ], [ /брандмауэр|firewall|защит|зон/i, 'shield' ], [ /температур|охлажд/i, 'temp' ], [ /процесс/i, 'cpu' ]
	];
	function iconFor(text) {
		for (var i = 0; i < TITLE_ICONS.length; i++) if (TITLE_ICONS[i][0].test(text)) return TITLE_ICONS[i][1];
		return 'grid';
	}
	function addIcons() {
		Array.prototype.forEach.call(document.querySelectorAll('#maincontent .nf-ttl:not([data-ic]), #maincontent .nfm-card-title:not([data-ic])'), function (t) {
			var grip = t.querySelector(':scope > .nf-grip');
			var text = (t.textContent || '').replace(/[⋮\s]+/g, ' ').trim();
			if (!text) return;
			t.setAttribute('data-ic', '1');
			var ic = h('span', { 'class': 'nf-ic', 'data-ic': iconFor(text), 'aria-hidden': 'true' });
			if (grip) t.insertBefore(ic, grip.nextSibling); else t.insertBefore(ic, t.firstChild);
		});
	}
	/* то же для иконок в заголовках карточек: без задержки, чтобы заголовок не подпрыгивал после опроса */
	function scheduleIcons() { addIcons(); }

	/* ---- the active menu item is a pill that glides to the item under the cursor and back ---- */
	function initPill() {
		var menu = document.getElementById('topmenu');
		if (!menu || menu.querySelector('.nf-pill') || !window.requestAnimationFrame) return;
		var pill = h('span', { 'class': 'nf-pill', 'aria-hidden': 'true' });
		menu.insertBefore(pill, menu.firstChild);
		document.body.classList.add('nf-pill-on');
		var hover = null, raf = 0;
		function current() { return menu.querySelector('li.open .dropdown-menu li.active > a') || menu.querySelector(':scope > li.active > a'); }
		function place() {
			raf = 0;
			var a = hover || current();
			if (!a || !a.offsetWidth) { pill.style.opacity = '0'; return; }
			var m = menu.getBoundingClientRect(), r = a.getBoundingClientRect();
			pill.style.opacity = '1';
			pill.classList.toggle('hov', !!hover && a !== current());
			pill.style.transform = 'translate(' + Math.round(r.left - m.left) + 'px,' + Math.round(r.top - m.top) + 'px)';
			pill.style.width = Math.round(r.width) + 'px'; pill.style.height = Math.round(r.height) + 'px';
		}
		function sched() { if (!raf) raf = window.requestAnimationFrame(place); }
		menu.addEventListener('mouseover', function (ev) { var a = ev.target.closest && ev.target.closest('a'); if (a && menu.contains(a)) { hover = a; sched(); } });
		menu.addEventListener('mouseleave', function () { hover = null; sched(); });
		menu.addEventListener('transitionend', sched);
		new MutationObserver(sched).observe(menu, { subtree: true, attributes: true, attributeFilter: [ 'class' ], childList: true });
		if (window.ResizeObserver) new ResizeObserver(sched).observe(menu);
		window.addEventListener('resize', sched);
		window.setTimeout(sched, 350);
		sched();
	}


	function applyBg() {
		var ok = BGS.some(function (b) { return b[0] === prefs.bg; });
		root.setAttribute('data-nf-bg', ok ? prefs.bg : 'mica');
		root.style.setProperty('--nf-bgs', String(Math.max(40, Math.min(250, +prefs.bgScale || 100)) / 100));
	}

	/* ---------- constellation background (animated dots that connect and gather near the cursor) ---------- */
	var cst = null;

	function accentRgb() {
		var a = hexToRgb(getComputedStyle(root).getPropertyValue('--nf-accent').trim()) || [ 0, 103, 192 ];
		return isDark() ? a.map(function (v) { return Math.round(v + (255 - v) * .35); }) : a;
	}

	function stopConst() {
		if (!cst) return;
		window.cancelAnimationFrame(cst.raf);
		window.removeEventListener('resize', cst.size);
		window.removeEventListener('pointermove', cst.move);
		window.removeEventListener('pointerleave', cst.leave);
		if (cst.cv.parentNode) cst.cv.parentNode.removeChild(cst.cv);
		cst = null;
	}

	var CONST_KINDS = [ 'net', 'fire', 'bubbles', 'snow', 'meteors' ];

	function startConst(mode, kind) {
		var cv = document.createElement('canvas'), ctx = cv.getContext && cv.getContext('2d');
		if (!ctx) return;
		cv.id = 'nf-const';
		cv.setAttribute('aria-hidden', 'true');
		document.body.insertBefore(cv, document.body.firstChild);

		var W = 0, H = 0, pts = [], streaks = [], mouse = { x: -1e4, y: -1e4 }, col = accentRgb(), colAt = 0, nextStreak = 0;
		var LINK = 120, PULL = 190, login = mode === 'login', rnd = Math.random;
		var S = cst = { cv: cv, mode: mode, kind: kind, raf: 0 };

		function mk(first) {
			var x = rnd() * W, y = rnd() * H;
			if (kind === 'fire') return { x: x, y: y, ang: rnd() * 6.28, sp: .15 + rnd() * .35, ph: rnd() * 6.28, tw: .6 + rnd() * 1.4, r: 3 + rnd() * 6 };
			if (kind === 'bubbles') return { x: x, y: first ? y : H + 40, r: 5 + rnd() * (login ? 30 : 22), vy: .25 + rnd() * .7, ph: rnd() * 6.28, wob: .25 + rnd() * .6 };
			if (kind === 'snow') { var r = .8 + rnd() * 2.4; return { x: x, y: first ? y : -10, r: r, vy: .3 + r * .28, ph: rnd() * 6.28, sw: .3 + rnd() * .6 }; }
			if (kind === 'meteors') return { x: x, y: y, r: .6 + rnd() * 1.4, ph: rnd() * 6.28, tw: .5 + rnd() * 1.6 };
			return { x: x, y: y, vx: (rnd() - .5) * .3, vy: (rnd() - .5) * .3, r: .9 + rnd() * 1.5 };
		}

		S.size = function () {
			var dpr = Math.min(window.devicePixelRatio || 1, 2);
			W = window.innerWidth; H = window.innerHeight;
			cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			var area = W * H, n;
			if (kind === 'fire') n = Math.max(18, Math.min(44, Math.round(area / 40000)));
			else if (kind === 'bubbles') n = Math.max(12, Math.min(34, Math.round(area / 55000)));
			else if (kind === 'snow') n = Math.max(50, Math.min(170, Math.round(area / 12000)));
			else if (kind === 'meteors') n = Math.max(40, Math.min(130, Math.round(area / 16000)));
			else n = Math.max(28, Math.min(login ? 110 : 55, Math.round(area / 15000)));
			while (pts.length < n) pts.push(mk(true));
			pts.length = n;
		};
		S.move = function (ev) { mouse.x = ev.clientX; mouse.y = ev.clientY; };
		S.leave = function () { mouse.x = mouse.y = -1e4; };

		function frameNet() {
			var i, j, a, b, dx, dy, d, k;
			for (i = 0; i < pts.length; i++) {
				a = pts[i];
				dx = mouse.x - a.x; dy = mouse.y - a.y; d = Math.sqrt(dx * dx + dy * dy);
				if (d < PULL && d > 1) { k = (1 - d / PULL) * .035; a.vx += dx / d * k; a.vy += dy / d * k; }
				a.vx *= .995; a.vy *= .995;
				var sp = Math.sqrt(a.vx * a.vx + a.vy * a.vy);
				if (sp > 1.4) { a.vx *= 1.4 / sp; a.vy *= 1.4 / sp; }
				if (sp < .08) { a.vx += (rnd() - .5) * .02; a.vy += (rnd() - .5) * .02; }
				a.x += a.vx; a.y += a.vy;
				if (a.x < -10) a.x = W + 10; else if (a.x > W + 10) a.x = -10;
				if (a.y < -10) a.y = H + 10; else if (a.y > H + 10) a.y = -10;
			}
			var rgb = col.join(','), la = login ? .5 : .22;
			ctx.lineWidth = 1;
			for (i = 0; i < pts.length; i++) {
				a = pts[i];
				for (j = i + 1; j < pts.length; j++) {
					b = pts[j]; dx = a.x - b.x; dy = a.y - b.y;
					if (dx > LINK || dx < -LINK || dy > LINK || dy < -LINK) continue;
					d = Math.sqrt(dx * dx + dy * dy);
					if (d >= LINK) continue;
					ctx.strokeStyle = 'rgba(' + rgb + ',' + ((1 - d / LINK) * la).toFixed(3) + ')';
					ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
				}
			}
			ctx.fillStyle = 'rgba(' + rgb + ',' + (login ? .85 : .5) + ')';
			for (i = 0; i < pts.length; i++) { a = pts[i]; ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, 6.2832); ctx.fill(); }
		}

		/* fireflies: soft glowing dots that drift, pulse and lean toward the cursor */
		function frameFire(t) {
			var rgb = col.join(','), i, a, dx, dy, d, g, al;
			for (i = 0; i < pts.length; i++) {
				a = pts[i];
				a.ang += Math.sin(t * .0004 + a.ph) * .03;
				dx = mouse.x - a.x; dy = mouse.y - a.y; d = Math.sqrt(dx * dx + dy * dy);
				if (d < 220 && d > 1) { a.x += dx / d * .35; a.y += dy / d * .35; }
				a.x += Math.cos(a.ang) * a.sp; a.y += Math.sin(a.ang) * a.sp;
				if (a.x < -20) a.x = W + 20; else if (a.x > W + 20) a.x = -20;
				if (a.y < -20) a.y = H + 20; else if (a.y > H + 20) a.y = -20;
				al = .25 + .75 * Math.pow(Math.sin(t * .001 * a.tw + a.ph) * .5 + .5, 2);
				g = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, a.r * 3.2);
				g.addColorStop(0, 'rgba(' + rgb + ',' + (al * (login ? .95 : .55)).toFixed(3) + ')');
				g.addColorStop(.35, 'rgba(' + rgb + ',' + (al * .28).toFixed(3) + ')');
				g.addColorStop(1, 'rgba(' + rgb + ',0)');
				ctx.fillStyle = g; ctx.beginPath(); ctx.arc(a.x, a.y, a.r * 3.2, 0, 6.2832); ctx.fill();
			}
		}

		/* bubbles: translucent rings rise with a gentle sway; the cursor pushes them away */
		function frameBubbles(t) {
			var rgb = col.join(','), i, a, dx, dy, d;
			for (i = 0; i < pts.length; i++) {
				a = pts[i];
				a.y -= a.vy; a.x += Math.sin(t * .0008 * a.wob + a.ph) * .4;
				dx = a.x - mouse.x; dy = a.y - mouse.y; d = Math.sqrt(dx * dx + dy * dy);
				if (d < a.r + 70 && d > 1) { a.x += dx / d * 1.6; a.y += dy / d * 1.2; }
				if (a.y < -a.r - 10) { pts[i] = mk(false); pts[i].x = rnd() * W; continue; }
				ctx.fillStyle = 'rgba(' + rgb + ',' + (login ? .07 : .045) + ')';
				ctx.strokeStyle = 'rgba(' + rgb + ',' + (login ? .5 : .28) + ')';
				ctx.lineWidth = 1.2;
				ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, 6.2832); ctx.fill(); ctx.stroke();
				ctx.strokeStyle = 'rgba(255,255,255,' + (login ? .55 : .3) + ')';
				ctx.beginPath(); ctx.arc(a.x, a.y, a.r * .7, 3.6, 4.5); ctx.stroke();
			}
		}

		/* snow: soft flakes, bigger ones fall faster */
		function frameSnow(t) {
			var rgb = isDark() ? '255,255,255' : col.join(','), i, a, dx;
			for (i = 0; i < pts.length; i++) {
				a = pts[i];
				a.y += a.vy; a.x += Math.sin(t * .0006 * a.sw + a.ph) * .45;
				dx = a.x - mouse.x; if (Math.abs(dx) < 60 && Math.abs(a.y - mouse.y) < 60) a.x += dx > 0 ? .6 : -.6;
				if (a.y > H + 10) { pts[i] = mk(false); pts[i].y = -10; continue; }
				if (a.x < -10) a.x = W + 10; else if (a.x > W + 10) a.x = -10;
				ctx.fillStyle = 'rgba(' + rgb + ',' + ((login ? .85 : .55) * Math.min(1, .35 + a.r / 2.6)).toFixed(3) + ')';
				ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, 6.2832); ctx.fill();
			}
		}

		/* twinkling stars with an occasional shooting star */
		function frameMeteors(t) {
			var rgb = isDark() ? '255,255,255' : col.join(','), i, a, s;
			for (i = 0; i < pts.length; i++) {
				a = pts[i];
				ctx.fillStyle = 'rgba(' + rgb + ',' + ((.15 + .65 * (Math.sin(t * .001 * a.tw + a.ph) * .5 + .5)) * (login ? 1 : .7)).toFixed(3) + ')';
				ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, 6.2832); ctx.fill();
			}
			if (t > nextStreak) {
				nextStreak = t + 1800 + rnd() * 3500;
				var ang = .6 + rnd() * .35, v = 9 + rnd() * 6;
				streaks.push({ x: rnd() * W * 1.1, y: -20, vx: -Math.cos(ang) * v, vy: Math.sin(ang) * v, life: 1 });
			}
			for (i = streaks.length - 1; i >= 0; i--) {
				s = streaks[i]; s.x += s.vx; s.y += s.vy; s.life -= .012;
				if (s.life <= 0 || s.y > H + 40) { streaks.splice(i, 1); continue; }
				var g = ctx.createLinearGradient(s.x, s.y, s.x - s.vx * 9, s.y - s.vy * 9);
				g.addColorStop(0, 'rgba(' + rgb + ',' + (s.life * (login ? .95 : .6)).toFixed(3) + ')');
				g.addColorStop(1, 'rgba(' + rgb + ',0)');
				ctx.strokeStyle = g; ctx.lineWidth = 1.6;
				ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx * 9, s.y - s.vy * 9); ctx.stroke();
			}
		}

		var DRAW = { net: frameNet, fire: frameFire, bubbles: frameBubbles, snow: frameSnow, meteors: frameMeteors }[kind] || frameNet;

		function frame(t) {
			S.raf = window.requestAnimationFrame(frame);
			if (document.hidden) return;
			if (t - colAt > 1500) { col = accentRgb(); colAt = t; }
			ctx.clearRect(0, 0, W, H);
			DRAW(t);
		}

		S.size();
		window.addEventListener('resize', S.size);
		window.addEventListener('pointermove', S.move, { passive: true });
		window.addEventListener('pointerleave', S.leave);
		S.raf = window.requestAnimationFrame(frame);
	}

	function syncConst() {
		if (!document.body) return;

		var want = null;
		if (!root.hasAttribute('data-nf-motion')) {
			if (document.body.classList.contains('nf-blank') && prefs.constLogin !== false) want = 'login';
			else if (document.body.classList.contains('nf-app') && prefs.constApp) want = 'app';
		}

		var kind = pick(prefs.constKind, CONST_KINDS, 'net');
		if (cst && (cst.mode !== want || cst.kind !== kind)) stopConst();
		if (want && !cst) startConst(want, kind);
	}

	document.addEventListener('DOMContentLoaded', syncConst);

	/* Entrance animations are for the first paint only. LuCI re-creates whole blocks on every
	   poll (status pages every 5 s), and replaying the fade/rise each time made the panel twitch. */
	document.addEventListener('DOMContentLoaded', function () {
		window.setTimeout(function () { root.setAttribute('data-nf-settled', '1'); }, 2500);
	});

	var FONT = { sm: .92, md: 1, lg: 1.1 };
	function pick(v, list, def) { return list.indexOf(v) >= 0 ? v : def; }

	function applyLook() {
		var d = pick(prefs.density, [ 'normal', 'compact' ], 'normal'), f = pick(prefs.font, [ 'sm', 'md', 'lg' ], 'md');
		var r = pick(prefs.radius, [ 'sharp', 'md', 'round' ], 'md'), g = pick(prefs.glass, [ 'on', 'off' ], 'on');
		var on = function (v) { return v === false ? 'off' : 'on'; };

		root.setAttribute('data-nf-density', d);
		root.setAttribute('data-nf-radius', r);
		root.setAttribute('data-nf-glass', g);
		root.setAttribute('data-nf-login-clock', on(prefs.loginClock));
		root.setAttribute('data-nf-login-info', on(prefs.loginInfo));
		root.setAttribute('data-nf-login-bg', pick(prefs.loginBg, [ 'mica', 'flat', 'aurora', 'waves', 'tod' ], 'mica'));
		root.setAttribute('data-nf-tod', todPart());
		root.setAttribute('data-nf-ov-wide', prefs.ovWide ? 'on' : 'off');
		applyLogo();
		root.setAttribute('data-nf-ov-live', on(prefs.ovLive));
		root.setAttribute('data-nf-ov-badges', on(prefs.ovBadges));
		root.setAttribute('data-nf-ov-size', pick(prefs.ovSize, [ 'sm', 'md', 'lg' ], 'md'));
		[ 'Top', 'Apps', 'Block', 'Wifi', 'Events', 'Health', 'Quick' ].forEach(function (k) { root.setAttribute('data-nf-ov-' + k.toLowerCase(), on(prefs['ov' + k])); });
		root.setAttribute('data-nf-hints', on(prefs.hints));
		root.setAttribute('data-nf-gtone', pick(prefs.glassTone, [ 'auto', 'light', 'dark' ], 'auto'));
		root.style.setProperty('--nf-gblur', Math.max(0, Math.min(60, +prefs.glassBlur || 0)) + 'px');
		root.style.setProperty('--nf-gk', String(Math.max(30, Math.min(170, +prefs.glassAlpha || 100)) / 100));
		root.setAttribute('data-nf-style', pick(prefs.style, [ '', 'glass' ], ''));
		root.setAttribute('data-nf-nav', prefs.navMini ? 'mini' : 'full');
		root.setAttribute('data-nf-netbar', on(prefs.netBar));
		root.setAttribute('data-nf-const', prefs.constApp ? 'app' : 'login');
		root.style.setProperty('--nf-fsz', String(FONT[f]));
	}

	function applyAll() { applyMode(); applyMotion(); applyBg(); applyLook(); syncConst(); try { document.dispatchEvent(new CustomEvent('nf-prefs')); } catch (e) { /* старый браузер */ } }

	function set(key, value) {
		prefs[key] = value;
		if (key !== 'preset' && key !== 'schedule' && key !== 'nightFrom' && key !== 'dayFrom' && key !== 'mode' && key !== 'navMini' && key !== 'netBar' && key.indexOf('login') !== 0 && key.indexOf('const') !== 0 && key.indexOf('ov') !== 0) prefs.preset = '';
		save();
		applyAll();
		refreshPanel();
	}

	if (mq.addEventListener) mq.addEventListener('change', applyMode);
	if (mqMotion.addEventListener) mqMotion.addEventListener('change', applyMotion);

	/* changes made in another tab */
	window.addEventListener('storage', function (ev) {
		if (ev.key === KEY) { prefs = load(); applyAll(); refreshPanel(); }
	});

	applyAll();
	window.setInterval(function () { if (prefs.schedule) applyMode(); }, 30000);

	/* ---------- personalisation panel ---------- */
	var pop = null, btn = null;

	function h(tag, attrs, kids) {
		var el = document.createElement(tag);
		Object.keys(attrs || {}).forEach(function (k) {
			if (k === 'text') el.textContent = attrs[k];
			else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
			else el.setAttribute(k, attrs[k]);
		});
		(kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
		return el;
	}

	var refs = {};

	function buildPanel() {
		refs.mode = {};
		refs.sw = [];

		var seg = h('div', { 'class': 'nf-seg', role: 'group', 'aria-label': 'Режим' }, [
			[ 'auto', 'Авто' ], [ 'light', 'Светлая' ], [ 'dark', 'Тёмная' ]
		].map(function (m) {
			return refs.mode[m[0]] = h('button', { type: 'button', text: m[1], onclick: function () { set('mode', m[0]); } });
		}));

		var grid = h('div', { 'class': 'nf-swatches' }, ACCENTS.map(function (a) {
			var b = h('button', { type: 'button', 'class': 'nf-sw', title: a[1], 'aria-label': a[1], style: '--c:' + (a[2] || a[0]),
				onclick: function () { set('accent', a[0]); } });
			refs.sw.push([ a[0], b ]);
			return b;
		}));

		refs.color = h('input', { type: 'color', 'class': 'nf-color', 'aria-label': 'Свой цвет',
			oninput: function (ev) { set('accent', ev.target.value); } });

		refs.bg = {};
		var bgseg = h('div', { 'class': 'nf-seg nf-seg-wrap', role: 'group', 'aria-label': 'Фон' }, BGS.map(function (b) {
			return refs.bg[b[0]] = h('button', { type: 'button', text: b[1], onclick: function () { set('bg', b[0]); } });
		}));
		refs.scale = h('input', { type: 'range', min: '40', max: '250', step: '10', 'aria-label': 'Масштаб узора',
			oninput: function (ev) { set('bgScale', +ev.target.value); } });

		function seg2(key, label, items, grid) {
			var m = refs[key] = {};
			var el = h('div', { 'class': 'nf-seg' + (grid ? ' nf-seg-grid' : ''), role: 'group', 'aria-label': label }, items.map(function (i) {
				return m[i[0]] = h('button', { type: 'button', text: i[1], onclick: function () { set(key, i[0]); } });
			}));
			return [ h('div', { 'class': 'nf-pop-l', text: label }), el ];
		}
		function sw(key, label) {
			var c = refs[key] = h('input', { type: 'checkbox', onchange: function (ev) { set(key, ev.target.checked); } });
			return h('label', { 'class': 'nf-pop-row' }, [ h('span', { text: label }), h('span', { 'class': 'cbi-checkbox' }, [ c ]) ]);
		}
		refs.preset = {};
		var presets = h('div', { 'class': 'nf-seg nf-presets', role: 'group', 'aria-label': 'Стиль' }, PRESETS.map(function (pr) {
			return refs.preset[pr[0]] = h('button', { type: 'button', text: pr[1], onclick: function () {
				Object.assign(prefs, pr[2], { preset: pr[0] }); save(); applyAll(); refreshPanel();
			} });
		}));
		refs.schedule = h('input', { type: 'checkbox', onchange: function (ev) { set('schedule', ev.target.checked); } });
		var tin = function (key) {
			return refs[key] = h('input', { type: 'time', 'class': 'nf-time', 'aria-label': key === 'nightFrom' ? 'Тёмная с' : 'Светлая с',
				oninput: function (ev) { if (/^\d\d:\d\d$/.test(ev.target.value)) set(key, ev.target.value); } });
		};
		var sched = h('div', { 'class': 'nf-pop-sec' }, [
			h('label', { 'class': 'nf-pop-row' }, [ h('span', { text: 'Тёмная по расписанию' }), h('span', { 'class': 'cbi-checkbox' }, [ refs.schedule ]) ]),
			h('div', { 'class': 'nf-pop-times', 'data-sched': '' }, [ h('span', { text: 'Тёмная с' }), tin('nightFrom'), h('span', { text: 'светлая с' }), tin('dayFrom') ])
		]);
		function rng(label, input, unit) {
			input.setAttribute('data-unit', unit);
			return h('label', { 'class': 'nf-rng' }, [ h('span', { 'class': 'nf-rng-t' }, [ h('span', { text: label }), h('output', { 'class': 'nf-rng-v' }) ]), input ]);
		}
		refs.gblur = h('input', { type: 'range', min: '0', max: '48', step: '2', 'aria-label': 'Размытие стекла', oninput: function (ev) { set('glassBlur', +ev.target.value); } });
		refs.galpha = h('input', { type: 'range', min: '40', max: '160', step: '10', 'aria-label': 'Плотность стекла', oninput: function (ev) { set('glassAlpha', +ev.target.value); } });
		refs.install = h('button', { type: 'button', 'class': 'nf-pop-reset', hidden: '', text: 'Установить как приложение', onclick: function () {
			if (!installEvt) return; installEvt.prompt(); installEvt = null; refs.install.hidden = true;
		} });
		var look = [].concat(
			seg2('density', 'Плотность', [ [ 'normal', 'Обычная' ], [ 'compact', 'Компактная' ] ]),
			seg2('font', 'Размер текста', [ [ 'sm', 'Мельче' ], [ 'md', 'Обычный' ], [ 'lg', 'Крупнее' ] ]),
			seg2('radius', 'Скругление углов', [ [ 'sharp', 'Острые' ], [ 'md', 'Средние' ], [ 'round', 'Круглые' ] ]),
			seg2('glass', 'Стекло и размытие', [ [ 'on', 'Включено' ], [ 'off', 'Выключено' ] ]),
			seg2('glassTone', 'Тон стекла', [ [ 'auto', 'Авто' ], [ 'light', 'Светлое' ], [ 'dark', 'Тёмное' ] ]),
			[ rng('Размытие', refs.gblur, 'px'), rng('Плотность стекла', refs.galpha, '%') ]
		);
		/* что показывать в карточках на входе и своя картинка вместо логотипа */
		var CELL_OPTS = [ [ 'net', 'Интернет (пинг)' ], [ 'speed', 'Скорость сейчас' ], [ 'test', 'Последний замер' ], [ 'up', 'Время работы' ], [ 'fw', 'Прошивка' ], [ 'temp', 'Температура' ], [ 'cpu', 'Процессор' ], [ 'mem', 'Память' ], [ 'clients', 'Устройств в сети' ], [ 'none', '— пусто —' ] ];
		function loginExtras() {
			var arr = [ h('div', { 'class': 'nf-pop-l', text: 'Карточки на входе' }) ];
			refs.cells = [];
			[ 0, 1, 2 ].forEach(function (i) {
				var sel = h('select', { 'class': 'nf-sel', 'aria-label': 'Карточка ' + (i + 1), onchange: function (ev) {
					var c = (Array.isArray(prefs.loginCells) ? prefs.loginCells : [ 'net', 'up', 'fw' ]).slice(); while (c.length < 3) c.push('none');
					c[i] = ev.target.value; set('loginCells', c);
				} }, CELL_OPTS.map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
				refs.cells.push(sel);
				arr.push(h('label', { 'class': 'nf-pop-row' }, [ h('span', { text: 'Карточка ' + (i + 1) }), sel ]));
			});
			refs.logoNote = h('div', { 'class': 'nf-pop-note', text: '' });
			var file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml,image/gif', hidden: true, onchange: function (ev) {
				var f = ev.target.files && ev.target.files[0]; ev.target.value = '';
				if (!f) return;
				refs.logoNote.textContent = 'Обрабатываю картинку…';
				readLogo(f, function (d) {
					if (!d) { refs.logoNote.textContent = 'Не получилось прочитать картинку. Попробуйте PNG или JPG поменьше.'; return; }
					try { window.localStorage.setItem(LOGOKEY, d); } catch (e) { /* private mode */ }
					routerExec([ 'logo-set', d ]).then(function () { refs.logoNote.textContent = 'Картинка сохранена и на роутере: она видна на входе в любом браузере.'; })
						.catch(function (e) { refs.logoNote.textContent = 'Картинка работает в этом браузере. На роутер не сохранена: ' + e.message; });
					set('loginLogo', true);
				});
			} });
			arr.push(h('div', { 'class': 'nf-pop-l', text: 'Своя картинка на входе' }));
			arr.push(h('div', { 'class': 'nf-logo-row' }, [
				h('button', { type: 'button', 'class': 'cbi-button', text: 'Выбрать картинку', onclick: function () { file.click(); } }),
				h('button', { type: 'button', 'class': 'cbi-button', text: 'Убрать', onclick: function () {
					try { window.localStorage.removeItem(LOGOKEY); } catch (e) { /* ignore */ }
					routerExec([ 'logo-set', 'off' ]).catch(function () { /* нечего удалять */ });
					refs.logoNote.textContent = '';
					set('loginLogo', false);
				} }), file ]));
			arr.push(refs.logoNote);
			return arr;
		}
		var more = h('div', { 'class': 'nf-pop-sec' }, [
			h('div', { 'class': 'nf-pop-l', text: 'Экран входа' }),
			sw('loginClock', 'Часы и дата'), sw('loginInfo', 'Сводка о роутере'), sw('constLogin', 'Анимированный фон')
		].concat(seg2('constKind', 'Вид анимации', [ [ 'net', 'Созвездия' ], [ 'fire', 'Светлячки' ], [ 'bubbles', 'Пузыри' ], [ 'snow', 'Снег' ], [ 'meteors', 'Звёзды' ] ], true)).concat(seg2('loginBg', 'Фон входа', [ [ 'mica', 'Как у темы' ], [ 'flat', 'Однотонный' ], [ 'aurora', 'Аврора' ], [ 'waves', 'Волны' ], [ 'tod', 'По времени суток' ] ], true)).concat(loginExtras()));
		var ov = h('div', { 'class': 'nf-pop-sec' }, [
			h('div', { 'class': 'nf-pop-l', text: 'Обзор' }),
			sw('ovLive', 'Полоса «Сейчас»'), sw('ovBadges', 'Цветные метки'),
			sw('ovTop', 'Топ клиентов'), sw('ovApps', 'Трафик по приложениям'), sw('ovBlock', 'Доступ в интернет'), sw('ovWifi', 'Wi‑Fi сейчас'), sw('ovHealth', 'Состояние роутера'), sw('ovEvents', 'Лента событий'), sw('ovQuick', 'Быстрые действия'),
		sw('ovWide', 'Один столбец (карточки на всю ширину)')
		].concat(seg2('ovSize', 'Размер карточек', [ [ 'sm', 'Компактные' ], [ 'md', 'Обычные' ], [ 'lg', 'Крупные' ] ], true)).concat([
			h('div', { 'class': 'nf-pop-l', text: 'Интерфейс' }), sw('navMini', 'Свёрнутое меню (значки)'), sw('constApp', 'Анимация на фоне страниц'), sw('netBar', 'Полоса состояния интернета'), sw('hints', 'Подсказки по терминам'), refs.install,
			h('div', { 'class': 'nf-pop-note', text: 'Приложение: в Chrome и Edge установка работает по HTTPS, на iPhone — «Поделиться → На экран Домой».' })
		]));

		refs.motion = h('input', { type: 'checkbox', onchange: function (ev) { set('motion', ev.target.checked); } });
		refs.liteAuto = h('input', { type: 'checkbox', onchange: function (ev) { set('liteAuto', ev.target.checked); } });

		pop = h('div', { 'class': 'nf-pop', role: 'dialog', 'aria-label': 'Персонализация' }, [
			h('div', { 'class': 'nf-pop-h' }, [ h('span', { text: 'Персонализация' }), h('button', { type: 'button', 'class': 'nf-pop-x', 'aria-label': 'Закрыть', title: 'Закрыть', text: '×', onclick: function () { toggle(false); } }) ]),
			h('div', { 'class': 'nf-pop-l', text: 'Стиль' }), presets,
			h('div', { 'class': 'nf-pop-l', text: 'Режим' }), seg, sched,
			h('div', { 'class': 'nf-pop-l', text: 'Цвет акцента' }), grid,
				h('div', { 'class': 'nf-pop-l', text: 'Фон' }), bgseg,
				rng('Масштаб узора', refs.scale, '%'),
			h('label', { 'class': 'nf-pop-c' }, [ h('span', { text: 'Свой цвет' }), refs.color ]),
			h('div', { 'class': 'nf-pop-sec' }, look),
			h('label', { 'class': 'nf-pop-row' }, [ h('span', { text: 'Анимации' }), h('span', { 'class': 'cbi-checkbox' }, [ refs.motion ]) ]),
			h('label', { 'class': 'nf-pop-row' }, [ h('span', { text: 'Выключать анимации на слабых телефонах' }), h('span', { 'class': 'cbi-checkbox' }, [ refs.liteAuto ]) ]),
			more, ov,
			h('div', { 'class': 'nf-pop-io' }, [
				h('button', { type: 'button', text: 'Сохранить в файл', onclick: exportPrefs }),
				h('button', { type: 'button', text: 'Загрузить из файла', onclick: function () { refs.file.click(); } }),
				refs.file = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: function (ev) { importPrefs(ev.target.files && ev.target.files[0]); ev.target.value = ''; } })
			]),
			refs.ioNote = h('div', { 'class': 'nf-pop-ionote', role: 'status' }),
			h('div', { 'class': 'nf-pop-sec nf-pop-about' }, [
				h('div', { 'class': 'nf-pop-l', text: 'О теме' }),
				refs.ver = h('div', { 'class': 'nf-ver' }),
				h('label', { 'class': 'nf-pop-row' }, [ h('span', { text: 'Проверять обновления раз в неделю' }), h('span', { 'class': 'cbi-checkbox' }, [ refs.upd = h('input', { type: 'checkbox', onchange: function (ev) { set('updCheck', ev.target.checked); } }) ]) ]),
				h('div', { 'class': 'nf-pop-io' }, [
					h('button', { type: 'button', text: 'Проверить сейчас', onclick: function () { checkUpdate(true); } }),
					h('a', { 'class': 'nf-pop-btn', href: 'https://github.com/' + REPO + '/releases', target: '_blank', rel: 'noopener', text: 'Страница релизов' })
				]),
				refs.updNote = h('div', { 'class': 'nf-pop-ionote', role: 'status' })
			]),
			h('button', { type: 'button', 'class': 'nf-pop-reset', text: 'Сбросить', onclick: function () {
				prefs = Object.assign({}, DEFAULTS); save(); applyAll(); refreshPanel();
			} })
		]);

		pop.addEventListener('input', function (ev) { if (ev.target.type === 'range') paintRange(ev.target); });
		document.body.appendChild(pop);
		refreshPanel();
	}

	/* ---------- экспорт и импорт настроек вида одним файлом ---------- */
	function ioNote(text, bad) {
		if (!refs.ioNote) return;
		refs.ioNote.textContent = text; refs.ioNote.classList.toggle('bad', !!bad);
		window.clearTimeout(ioNote.t); ioNote.t = window.setTimeout(function () { refs.ioNote.textContent = ''; }, 6000);
	}
	function exportPrefs() {
		var out = {};
		Object.keys(DEFAULTS).forEach(function (k) { out[k] = prefs[k]; });
		var blob = new Blob([ JSON.stringify({ app: 'nightfall', v: 1, prefs: out }, null, 2) ], { type: 'application/json' });
		var a = h('a', { href: URL.createObjectURL(blob), download: 'nightfall-settings.json' });
		a.addEventListener('click', function (ev) { ev.stopPropagation(); });   /* иначе панель решит, что кликнули снаружи, и закроется */
		document.body.appendChild(a); a.click();
		window.setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
		ioNote('Файл nightfall-settings.json сохранён.');
	}
	/* из файла берём только известные ключи с тем же типом значения, цвета и время проверяем по шаблону */
	function cleanPrefs(src) {
		var out = {}, n = 0;
		Object.keys(DEFAULTS).forEach(function (k) {
			if (!Object.prototype.hasOwnProperty.call(src, k)) return;
			var v = src[k], d = DEFAULTS[k];
			if (typeof v !== typeof d) return;
			if (typeof v === 'string') {
				if (v.length > 32) return;
				if (k === 'accent' && v !== '' && !/^#[0-9a-fA-F]{6}$/.test(v)) return;
				if ((k === 'nightFrom' || k === 'dayFrom') && !/^\d\d:\d\d$/.test(v)) return;
				if (k !== 'accent' && k !== 'nightFrom' && k !== 'dayFrom' && !/^[A-Za-z0-9_-]*$/.test(v)) return;
			}
			if (typeof v === 'number' && (!isFinite(v) || v < 0 || v > 1000)) return;
			out[k] = v; n++;
		});
		return n ? out : null;
	}
	function importPrefs(file) {
		if (!file) return;
		if (file.size > 65536) { ioNote('Файл слишком большой для файла настроек.', true); return; }
		var rd = new FileReader();
		rd.onload = function () {
			var d = null;
			try { d = JSON.parse(String(rd.result)); } catch (e) { /* ниже сообщим */ }
			var src = d && typeof d === 'object' ? (d.prefs || d.p || d) : null;
			var clean = src && typeof src === 'object' ? cleanPrefs(src) : null;
			if (!clean) { ioNote('Это не файл настроек Nightfall.', true); return; }
			prefs = Object.assign({}, DEFAULTS, clean); save(); applyAll(); refreshPanel();
			ioNote('Настройки загружены.');
		};
		rd.onerror = function () { ioNote('Не удалось прочитать файл.', true); };
		rd.readAsText(file);
	}

	/* ---------- версия темы и проверка обновлений ----------
	 * Версия лежит в version.json рядом с темой (её пишет сборка релиза). Раз в неделю браузер (не роутер) спрашивает у GitHub,
	 * какой релиз последний, и сравнивает номера. Ставить ничего не будет: только подсказка. Отключается в панели. */
	var REPO = 'Nikolai752/nightfall-openwrt', UKEY = 'nightfall-upd-v', verInfo = null;
	function vnum(s) { return String(s || '').replace(/^v/i, '').split('.').map(function (n) { return parseInt(n, 10) || 0; }); }
	function isNewer(a, b) {   /* b новее a? */
		var x = vnum(a), y = vnum(b);
		for (var i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) > (x[i] || 0); }
		return false;
	}
	function updCache() { try { return JSON.parse(window.localStorage.getItem(UKEY) || 'null'); } catch (e) { return null; } }
	function updAvail() { var c = updCache(); return verInfo && c && c.tag && isNewer(verInfo.version, c.tag) ? c.tag : ''; }
	function paintVer() {
		var tag = updAvail();
		if (refs.ver) refs.ver.textContent = verInfo ? 'Nightfall v' + verInfo.version + (verInfo.build ? ' · сборка ' + verInfo.build : '') : 'Версия не определена (файл version.json не найден)';
		if (refs.updNote && tag) { refs.updNote.textContent = 'Доступна ' + fullTag(tag) + '. '; refs.updNote.classList.remove('bad'); refs.updNote.appendChild(h('a', { href: '#', text: 'Обновить', onclick: function (ev) { ev.preventDefault(); offerUpdate(true); } })); }
		document.querySelectorAll('.nf-pers-main').forEach(function (b) { b.classList.toggle('nf-has-upd', !!tag); });
	}
	function loadVer() {
		if (!window.fetch) return;
		window.fetch(BASE + 'version.json?' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
			verInfo = d && typeof d.version === 'string' ? d : null; paintVer(); checkWhatsNew(); offerUpdate(false);
			var c = updCache();
			if (verInfo && prefs.updCheck && !document.body.classList.contains('nf-blank') && (!c || Date.now() - c.t > 7 * 864e5)) window.setTimeout(function () { checkUpdate(false); }, 4000);
		}).catch(function () { /* без версии просто не показываем */ });
	}
	/* Номер последнего релиза берём сначала из latest.json в репозитории (raw.githubusercontent.com, лимитов нет;
	 * файл обновляет сборка релиза), а если не вышло — из API GitHub (у него лимит 60 запросов в час на адрес). */
	function getLatestTag() {
		function ok(t) { return typeof t === 'string' && /^v?\d+(\.\d+){0,2}$/.test(t) ? t : ''; }
		return window.fetch('https://raw.githubusercontent.com/' + REPO + '/main/latest.json?' + Math.floor(Date.now() / 300000), { cache: 'no-store' })
			.then(function (r) { if (!r.ok) throw new Error('raw'); return r.json(); })
			.then(function (d) { var t = ok(d && d.version); if (!t) throw new Error('raw-tag'); return t; })
			.catch(function () {
				return window.fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' })
					.then(function (r) { if (!r.ok) throw new Error('api'); return r.json(); })
					.then(function (d) { var t = ok(d && d.tag_name); if (!t) throw new Error('api-tag'); return t; });
			});
	}
	function checkUpdate(manual) {
		if (!window.fetch) return;
		if (manual && refs.updNote) { refs.updNote.textContent = 'Проверяю…'; refs.updNote.classList.remove('bad'); }
		getLatestTag().then(function (tag) {
			try { window.localStorage.setItem(UKEY, JSON.stringify({ tag: tag, t: Date.now() })); } catch (e) { /* ignore */ }
			paintVer(); offerUpdate(false);
			if (manual && refs.updNote && !updAvail()) { refs.updNote.textContent = 'Установлена последняя версия (' + (/^v/i.test(tag) ? tag : 'v' + tag) + ').'; refs.updNote.classList.remove('bad'); }
		}).catch(function () {
			if (manual && refs.updNote) { refs.updNote.textContent = 'Не удалось проверить: GitHub не ответил или исчерпан лимит запросов. Попробуйте позже.'; refs.updNote.classList.add('bad'); }
		});
	}

	/* ---------- обновление из интерфейса ----------
	 * Окно «Доступна новая версия» -> роутер сам скачивает релиз и ставит его (/usr/libexec/nightfall-update,
	 * проверка sha256, откат при ошибке) -> окно «Установлено» и выход из сессии (права обновляются при входе) ->
	 * после входа окно «Что нового» из CHANGELOG.md. Для скачивания на роутере нужен curl (apk add curl). */
	var SKIPKEY = 'nightfall-upd-skip', SEENKEY = 'nightfall-seen-ver', updModal = null, updBusy = false;
	function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
	function lsSet(k, v) { try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
	function fullTag(t) { return /^v/i.test(t) ? t : 'v' + t; }
	function updExec(arg) {
		var env = sid();
		if (!env || !window.fetch) return Promise.reject(new Error('nosession'));
		return window.fetch(env.ubuspath || '/ubus/', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [ env.sessionid, 'file', 'exec', { command: '/usr/libexec/nightfall-update', params: [ arg ] } ] }) })
			.then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); })
			.then(function (d) {
				var res = d && d.result;
				if (!res || res[0] !== 0 || !res[1]) throw new Error('denied');
				try { return JSON.parse(res[1].stdout || ''); } catch (e) { throw new Error('parse'); }
			});
	}
	function closeUpd() { if (updModal) { updModal.remove(); updModal = null; } document.documentElement.classList.remove('nf-upd-open'); }
	function openUpd(title, kids, wide) {
		closeUpd();
		var box = h('div', { 'class': 'nf-upd-box' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [ h('h4', { text: title }) ].concat(kids));
		updModal = h('div', { 'class': 'nf-upd-modal' }, [ box ]);
		document.body.appendChild(updModal);
		document.documentElement.classList.add('nf-upd-open');
		return box;
	}
	/* CHANGELOG.md: разделы «## v1.0.9 ...», внутри пункты «- ...» и подзаголовки «### ...» */
	function parseChangelog(md) {
		var out = [], cur = null;
		String(md || '').split(/\r?\n/).forEach(function (ln) {
			var m = /^##\s+v?(\d+(?:\.\d+){0,2})\b\s*(.*)$/.exec(ln);
			if (m) { cur = { v: m[1], t: m[2].replace(/^[\-–—·:\s]+/, ''), lines: [] }; out.push(cur); }
			else if (cur && ln.trim()) cur.lines.push(ln.trim());
		});
		return out;
	}
	function renderChanges(sections) {
		var wrap = h('div', { 'class': 'nf-upd-log' });
		sections.forEach(function (s) {
			wrap.appendChild(h('h5', { text: 'v' + s.v + (s.t ? ' · ' + s.t : '') }));
			var ul = null;
			s.lines.forEach(function (ln) {
				if (/^[-*]\s+/.test(ln)) { if (!ul) { ul = h('ul'); wrap.appendChild(ul); } ul.appendChild(h('li', { text: ln.replace(/^[-*]\s+/, '') })); }
				else { ul = null; wrap.appendChild(h(/^###/.test(ln) ? 'h6' : 'p', { text: ln.replace(/^#+\s*/, '') })); }
			});
		});
		return wrap;
	}
	function loadChangelog(url) {
		return window.fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('nolog'); return r.text(); }).then(parseChangelog);
	}
	/* после входа: если версия изменилась, показываем, что нового */
	function checkWhatsNew() {
		if (!verInfo || document.body.classList.contains('nf-blank') || !window.fetch) return;
		var seen = lsGet(SEENKEY), cur = verInfo.version;
		if (seen === cur) return;
		lsSet(SEENKEY, cur);
		if (!seen || !isNewer(seen, cur)) return;       /* первый запуск или откат на старую: молча */
		loadChangelog(BASE + 'CHANGELOG.md?' + Date.now()).then(function (all) {
			var list = all.filter(function (s) { return isNewer(seen, s.v) && !isNewer(cur, s.v); }).slice(0, 4);
			if (!list.length) return;
			openUpd('Nightfall обновлён до v' + cur, [ renderChanges(list), h('div', { 'class': 'nf-upd-btns' }, [ h('button', { type: 'button', 'class': 'nf-upd-go', text: 'Понятно', onclick: closeUpd }) ]) ], true);
		}).catch(function () { /* нет файла — без окна */ });
	}
	function restartSession() {
		var env = window.L && window.L.env;
		lsSet(SKIPKEY, null);
		window.location.href = ((env && env.scriptname) || '/cgi-bin/luci') + '/admin/logout';
	}
	function runUpdate(tag) {
		if (updBusy) return;
		updBusy = true;
		var bar = h('i'), msg = h('p', { 'class': 'nf-upd-msg', text: 'Запуск…' });
		openUpd('Обновление Nightfall', [ h('div', { 'class': 'nf-upd-bar' }, [ bar ]), msg, h('p', { 'class': 'nf-upd-note', text: 'Не закрывайте страницу и не выключайте роутер.' }) ]);
		var errs = 0, t0 = Date.now(), lastPct = 0;
		function finish(ok, text, canRestart) {
			updBusy = false;
			var btns = [];
			if (canRestart) { lsSet(SEENKEY, verInfo ? verInfo.version : null); btns.push(h('button', { type: 'button', 'class': 'nf-upd-go', text: 'Перезапустить сессию', onclick: restartSession })); }
			else btns.push(h('button', { type: 'button', 'class': 'nf-upd-go', text: 'Закрыть', onclick: closeUpd }));
			openUpd(ok ? 'Всё установилось' : 'Обновление не выполнено', [ h('p', { 'class': 'nf-upd-msg' + (ok ? '' : ' bad'), text: text }), h('div', { 'class': 'nf-upd-btns' }, btns) ]);
			if (canRestart) window.setTimeout(function () { if (updModal) restartSession(); }, 4000);
		}
		function poll() {
			updExec('status').then(function (s) {
				errs = 0;
				if (s.state === 'done') return finish(true, (s.msg || 'Установлено.') + ' Сейчас сессия перезапустится, войдите снова, чтобы применились все изменения.', true);
				if (s.state === 'error' || s.state === 'rolledback') return finish(false, s.msg || 'Неизвестная ошибка.', false);
				if (s.state === 'idle' && Date.now() - t0 > 15000) return finish(false, 'Обновление не запустилось.', false);
				lastPct = Math.max(lastPct, +s.pct || 0);
				bar.style.width = lastPct + '%'; msg.textContent = s.msg || '…';
				window.setTimeout(poll, 1500);
			}).catch(function () {
				/* во время перезагрузки rpcd ответа может не быть: если установка уже шла, считаем её завершённой */
				errs++;
				if (errs >= 4 && lastPct >= 65) return finish(true, 'Обновление, судя по всему, установлено (роутер перезапустил службу). Войдите снова.', true);
				if (errs >= 8) return finish(false, 'Нет ответа от роутера. Обновите страницу и проверьте версию.', false);
				window.setTimeout(poll, 2000);
			});
		}
		lsSet(SEENKEY, verInfo ? verInfo.version : null);
		updExec('start').then(function () { window.setTimeout(poll, 1200); }).catch(function (e) {
			finish(false, e && e.message === 'denied' ? 'Нет прав на запуск обновления. Выйдите и войдите снова, затем повторите; если не помогло, обновите вручную (install-update.sh).' : 'Не удалось запустить обновление.', false);
		});
	}
	function offerUpdate(force) {
		var tag = updAvail();
		if (!tag || updBusy || document.body.classList.contains('nf-blank') || !sid()) return;
		if (!force && lsGet(SKIPKEY) === tag) return;
		var log = h('div');
		var box = openUpd('Доступна новая версия', [
			h('p', { 'class': 'nf-upd-msg', text: 'Nightfall ' + fullTag(tag) + (verInfo ? ' (сейчас v' + verInfo.version + ')' : '') + '. Роутер сам скачает и установит обновление, после чего потребуется войти заново.' }),
			log,
			h('div', { 'class': 'nf-upd-btns' }, [
				h('button', { type: 'button', text: 'Позже', onclick: function () { lsSet(SKIPKEY, tag); closeUpd(); } }),
				h('button', { type: 'button', 'class': 'nf-upd-go', text: 'Обновить', onclick: function () { runUpdate(tag); } })
			])
		]);
		/* «Что нового» в новой версии берём из CHANGELOG.md репозитория (если доступен) */
		loadChangelog('https://raw.githubusercontent.com/' + REPO + '/main/CHANGELOG.md?' + Math.floor(Date.now() / 300000)).then(function (all) {
			var list = all.filter(function (s) { return verInfo && isNewer(verInfo.version, s.v) && !isNewer(tag, s.v); }).slice(0, 3);
			if (list.length && updModal === box.parentNode) log.appendChild(renderChanges(list));
		}).catch(function () { /* без списка изменений */ });
	}

	function paintRange(el) {
		var lo = +el.min || 0, hi = +el.max || 100, p = hi > lo ? (el.value - lo) / (hi - lo) * 100 : 0;
		el.style.setProperty('--p', p + '%');
		var out = el.parentNode && el.parentNode.querySelector('.nf-rng-v');
		if (out) out.textContent = el.value + (el.getAttribute('data-unit') === 'px' ? ' px' : '%');
	}

	function refreshPanel() {
		refreshQuick();
		if (!pop) return;

		Object.keys(refs.mode).forEach(function (k) {
			refs.mode[k].setAttribute('aria-pressed', String(prefs.mode === k));
		});

		refs.sw.forEach(function (p) { p[1].setAttribute('aria-pressed', String(prefs.accent === p[0])); });
		Object.keys(refs.bg).forEach(function (k) { refs.bg[k].setAttribute('aria-pressed', String(prefs.bg === k)); });
		refs.scale.value = String(prefs.bgScale);
		refs.scale.disabled = prefs.bg === 'mica' || prefs.bg === 'flat' || prefs.bg === 'aurora' || prefs.bg === 'waves';
		refs.color.value = hexToRgb(prefs.accent) ? prefs.accent : '#0067c0';
		[ [ 'density', 'normal' ], [ 'font', 'md' ], [ 'radius', 'md' ], [ 'glass', 'on' ], [ 'loginBg', 'mica' ], [ 'constKind', 'net' ], [ 'glassTone', 'auto' ], [ 'ovSize', 'md' ] ].forEach(function (k) {
			Object.keys(refs[k[0]]).forEach(function (v) { refs[k[0]][v].setAttribute('aria-pressed', String((prefs[k[0]] || k[1]) === v)); });
		});
		Object.keys(refs.preset).forEach(function (k) { refs.preset[k].setAttribute('aria-pressed', String(prefs.preset === k)); });
		refs.schedule.checked = !!prefs.schedule;
		if (refs.upd) refs.upd.checked = prefs.updCheck !== false;
		paintVer();
		refs.nightFrom.value = prefs.nightFrom || '20:00';
		refs.dayFrom.value = prefs.dayFrom || '07:00';
		pop.querySelector('.nf-pop-times').toggleAttribute('data-on', !!prefs.schedule);
		[ 'loginClock', 'loginInfo', 'ovLive', 'ovBadges', 'navMini', 'netBar', 'constLogin', 'constApp', 'hints', 'ovTop', 'ovApps', 'ovBlock', 'ovWifi', 'ovEvents', 'ovHealth', 'ovQuick' ].forEach(function (k) { refs[k].checked = k === 'constApp' ? !!prefs[k] : prefs[k] !== false; });
		refs.motion.checked = !!prefs.motion;
		refs.liteAuto.checked = prefs.liteAuto !== false;
		refs.ovWide.checked = !!prefs.ovWide;
		var cc = Array.isArray(prefs.loginCells) ? prefs.loginCells : [ 'net', 'up', 'fw' ];
		refs.cells.forEach(function (sel, i) { sel.value = cc[i] || 'none'; });
		refs.gblur.value = String(prefs.glassBlur == null ? 28 : prefs.glassBlur);
		refs.galpha.value = String(prefs.glassAlpha || 100);
		refs.gblur.disabled = refs.galpha.disabled = prefs.style !== 'glass';
		refs.motion.disabled = !!mqMotion.matches;
		Array.prototype.forEach.call(pop.querySelectorAll('input[type="range"]'), paintRange);
		pop.querySelector('.nf-seg[aria-label="Режим"]').toggleAttribute('data-fixed', root.hasAttribute('data-nf-fixed') || !!prefs.schedule);
	}

	function toggle(open) {
		if (!pop) buildPanel();

		var show = open == null ? !pop.classList.contains('open') : open;
		pop.classList.toggle('open', show);
		if (btn) btn.setAttribute('aria-expanded', String(show));
	}

	var MODE_NEXT = { auto: 'light', light: 'dark', dark: 'auto' };
	var MODE_NAME = { auto: 'Авто', light: 'Светлая', dark: 'Тёмная' };
	var qbtn = null;

	function refreshQuick() {
		if (!qbtn) return;
		qbtn.setAttribute('data-mode', prefs.mode);
		var nm = prefs.schedule ? 'По расписанию' : MODE_NAME[prefs.mode];
		qbtn.setAttribute('title', 'Тема: ' + nm + ' (нажмите, чтобы сменить)');
		qbtn.firstChild.textContent = 'Тема: ' + nm;
		qbtn.disabled = root.hasAttribute('data-nf-fixed');
	}

	document.addEventListener('DOMContentLoaded', function () {
		btn = document.querySelector('.nf-pers');
		if (!btn) return;

		/* quick Auto / Light / Dark switch */
		qbtn = h('button', { type: 'button', 'class': 'nf-pers nf-qmode', onclick: function () { if (prefs.schedule) set('schedule', false); else set('mode', MODE_NEXT[prefs.mode] || 'auto'); } }, [ h('span') ]);
		btn.parentNode.insertBefore(qbtn, btn);
		btn.classList.remove('nf-pers'); btn.classList.add('nf-pers-main', 'nf-pers');
		btn = document.querySelector('.nf-pers-main');
		refreshQuick();

		initTabbar();
		initMobile();
		initHashAction();
		initPill();
		scheduleIcons();
		new MutationObserver(scheduleIcons).observe(document.body, { childList: true, subtree: true });

		/* collapse the menu to icons */
		var nb = h('button', { type: 'button', 'class': 'nf-navbtn', title: 'Свернуть / развернуть меню', onclick: function () { set('navMini', !prefs.navMini); } }, [ h('span', { text: 'Свернуть меню' }) ]);
		qbtn.parentNode.insertBefore(nb, qbtn);

		/* Ctrl/Cmd+K or "/" focuses the menu search */
		document.addEventListener('keydown', function (ev) {
			var t = ev.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
			var hit = ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') || (ev.key === '/' && !typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey);
			var f = document.getElementById('nf-find');
			if (!hit || !f) return;
			ev.preventDefault();
			document.body.classList.add('nf-nav-open');
			f.focus(); f.select();
		});

		btn.addEventListener('click', function (ev) { ev.stopPropagation(); toggle(); });
		document.addEventListener('click', function (ev) {
			if (pop && pop.classList.contains('open') && !pop.contains(ev.target)) toggle(false);
		});
		document.addEventListener('keydown', function (ev) {
			if (ev.key === 'Escape' && pop && pop.classList.contains('open')) { toggle(false); btn.focus(); }
		});
	});

	window.Nightfall = { prefs: function () { return Object.assign({}, prefs); }, set: set, accents: ACCENTS };
})();
