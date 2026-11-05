'use strict';
'require ui';
'require view';

/*
 * Nightfall: экран входа.
 * Кроме стандартного окна LuCI: сводка о роутере (из data-* шаблона),
 * запоминание имени пользователя, подсказки про Caps Lock и раскладку,
 * подсказка «Забыли пароль?». Пароль нигде не сохраняется.
 */

const KEY = 'nightfall-login-user';

const TEXT = {
	ru: {
		net: 'Интернет', up: 'Работает', fw: 'Прошивка', speed: 'Скорость', test: 'Замер скорости', mbit: 'Мбит/с', temp: 'Температура', cpu: 'Процессор', mem: 'Память', cl: 'Устройств', dec: ',',
		online: 'есть', offline: 'нет связи', nodata: 'нет данных', ms: 'мс',
		d: 'д', h: 'ч', m: 'мин',
		remember: 'Запомнить имя', forgot: 'Забыли пароль?',
		caps: 'Включён Caps Lock', layout: 'Введены русские буквы — проверьте раскладку',
		bad: 'Неверное имя или пароль. Проверьте раскладку и Caps Lock.',
		helpTitle: 'Как войти без пароля',
		help: [
			[ 'Есть SSH-доступ', 'Подключитесь и выполните: passwd' ],
			[ 'Доступа нет', 'Перезагрузите роутер, в начале загрузки, пока быстро мигает индикатор, нажмите reset (кнопка зависит от модели). Подключитесь по кабелю к 192.168.1.1 через telnet и выполните: mount_root; passwd; reboot' ],
			[ 'Ничего не помогло', 'Сброс к заводским настройкам кнопкой reset (около 10 секунд). Все настройки будут потеряны.' ]
		]
	},
	en: {
		net: 'Internet', up: 'Uptime', fw: 'Firmware', speed: 'Speed', test: 'Speed test', mbit: 'Mbit/s', temp: 'Temperature', cpu: 'CPU', mem: 'Memory', cl: 'Devices', dec: '.',
		online: 'online', offline: 'offline', nodata: 'no data', ms: 'ms',
		d: 'd', h: 'h', m: 'min',
		remember: 'Remember username', forgot: 'Forgot password?',
		caps: 'Caps Lock is on', layout: 'Non-Latin letters typed — check your keyboard layout',
		bad: 'Wrong username or password. Check keyboard layout and Caps Lock.',
		helpTitle: 'Getting in without a password',
		help: [
			[ 'You have SSH access', 'Connect and run: passwd' ],
			[ 'No access', 'Reboot the router and press reset while the LED blinks fast at the start of boot (the button depends on the model). Connect by cable to 192.168.1.1 via telnet and run: mount_root; passwd; reboot' ],
			[ 'Nothing worked', 'Factory reset with the reset button (about 10 seconds). All settings will be lost.' ]
		]
	}
};

function store(fn) {
	try { return fn(window.localStorage); } catch (e) { return null; }
}

return view.extend({
	render() {
		const form = document.querySelector('form');
		const btn = document.querySelector('button');
		const lang = document.documentElement.lang || 'en';
		const T = /^ru|^uk|^be/i.test(lang) ? TEXT.ru : TEXT.en;
		const info = document.getElementById('view');
		const user = form.querySelector('input[type="text"]');
		const failed = !!document.querySelector('section .alert-message');

		const dlg = ui.showModal(
			_('Authorization Required'),
			Array.from(document.querySelectorAll('section > *')),
			'login'
		);

		/* --- шапка: имя и модель --- */
		const h = dlg.querySelector('h4');
		const plate = E('div', { 'class': 'nf-plate' }, [
			E('b', {}, (info && info.dataset.host) || ''),
			E('span', {}, (info && info.dataset.model) || '')
		]);
		dlg.insertBefore(plate, h ? h.nextSibling : dlg.firstChild);

		/* --- сводка (только локальная сеть, данные пришли с сервера): какие три карточки показывать, выбирается в «Персонализации» --- */
		let statsBox = null;
		const fmt = (n) => (Math.round(n * 10) / 10).toString().replace('.', T.dec);
		const mbit = (bps) => fmt(parseFloat(bps) * 8 / 1e6);
		const num = (k) => { const v = info.dataset[k]; return v === '' || v === undefined || isNaN(parseFloat(v)) ? null : parseFloat(v); };

		const cell = (key) => {
			const d = info.dataset;
			switch (key) {
			case 'net': {
				const net = d.net, ms = d.ms;
				const txt = net === 'up' ? (ms !== '' ? ms + ' ' + T.ms : T.online) : net === 'down' ? T.offline : T.nodata;
				return E('div', { 'class': 'nf-st nf-st-' + (net || 'none') }, [ E('span', {}, T.net), E('b', {}, [ E('i', { 'class': 'nf-dot' }), txt ]) ]);
			}
			case 'speed': {
				const rx = num('rx'), tx = num('tx');
				return E('div', { 'class': 'nf-st nf-st-speed', title: T.mbit }, [ E('span', {}, T.speed), E('b', {}, rx === null ? T.nodata : '↓' + mbit(rx) + ' ↑' + mbit(tx)) ]);
			}
			case 'test': {
				const v = num('spd');
				return E('div', { 'class': 'nf-st' }, [ E('span', {}, T.test), E('b', {}, v === null ? T.nodata : Math.round(v) + ' ' + T.mbit) ]);
			}
			case 'up': {
				const sec = parseInt(d.up, 10);
				if (isNaN(sec)) return null;
				const dd = Math.floor(sec / 86400), hh = Math.floor(sec % 86400 / 3600), mm = Math.floor(sec % 3600 / 60);
				return E('div', { 'class': 'nf-st' }, [ E('span', {}, T.up), E('b', {}, dd > 0 ? dd + T.d + ' ' + hh + T.h : hh > 0 ? hh + T.h + ' ' + mm + T.m : mm + ' ' + T.m) ]);
			}
			case 'fw':
				return d.rel ? E('div', { 'class': 'nf-st' }, [ E('span', {}, T.fw), E('b', {}, d.rel) ]) : null;
			case 'temp': {
				const v = num('temp');
				return E('div', { 'class': 'nf-st' }, [ E('span', {}, T.temp), E('b', {}, v === null || v < 0 ? T.nodata : Math.round(v) + ' °C') ]);
			}
			case 'cpu': {
				const v = num('cpu');
				return E('div', { 'class': 'nf-st' }, [ E('span', {}, T.cpu), E('b', {}, v === null || v < 0 ? T.nodata : Math.round(v) + ' %') ]);
			}
			case 'mem': {
				const v = num('mem');
				return E('div', { 'class': 'nf-st' }, [ E('span', {}, T.mem), E('b', {}, v === null || v < 0 ? T.nodata : Math.round(v) + ' %') ]);
			}
			case 'clients': {
				const v = num('cl');
				return E('div', { 'class': 'nf-st' }, [ E('span', {}, T.cl), E('b', {}, v === null ? T.nodata : String(v)) ]);
			}
			}
			return null;
		};

		const renderStats = () => {
			if (!info || info.dataset.local !== '1') return;
			let keys = [ 'net', 'up', 'fw' ];
			try {
				const p = JSON.parse(window.localStorage.getItem('nightfall-prefs-v1') || 'null');
				if (p && Array.isArray(p.loginCells)) keys = p.loginCells.slice(0, 3);
			} catch (e) { /* настройки по умолчанию */ }
			const cells = keys.map(cell).filter(Boolean);
			if (statsBox) statsBox.remove();
			statsBox = E('div', { 'class': 'nf-stats', 'data-n': String(cells.length) }, cells);
			if (cells.length) dlg.insertBefore(statsBox, plate.nextSibling);
		};

		renderStats();
		document.addEventListener('nf-prefs', renderStats);

		/* --- имя пользователя: запомнить --- */
		const saved = store((s) => s.getItem(KEY));
		const remember = E('input', { type: 'checkbox', id: 'nf-remember' });
		remember.checked = saved !== null;
		if (saved && (!user.value || user.value === 'root'))
			user.value = saved;

		/* --- подсказка под паролем --- */
		const pw = dlg.querySelector('input[type="password"]');
		const hint = E('div', { 'class': 'nf-lhint', 'aria-live': 'polite' });
		let caps = false;

		const showHint = () => {
			const msg = caps ? T.caps : /[\u0400-\u04FF]/.test(pw.value) ? T.layout : '';
			hint.textContent = msg;
			hint.classList.toggle('on', !!msg);
		};

		if (pw) {
			pw.parentNode.parentNode.appendChild(hint);
			const capsCheck = (ev) => {
				if (ev.getModifierState) {
					caps = ev.getModifierState('CapsLock');
					showHint();
				}
			};
			pw.addEventListener('keydown', capsCheck);
			pw.addEventListener('keyup', capsCheck);
			pw.addEventListener('input', showHint);
			pw.addEventListener('blur', () => { caps = false; showHint(); });
		}

		/* --- ряд: запомнить / забыли пароль --- */
		const helpBox = E('div', { 'class': 'nf-help', hidden: true }, [
			E('b', {}, T.helpTitle),
			E('dl', {}, T.help.map((r) => [ E('dt', {}, r[0]), E('dd', {}, r[1]) ]).flat())
		]);

		const forgot = E('button', { type: 'button', 'class': 'nf-link', 'aria-expanded': 'false',
			click: () => {
				const open = helpBox.hidden;
				helpBox.hidden = !open;
				forgot.setAttribute('aria-expanded', open);
			} }, T.forgot);

		const row = E('div', { 'class': 'nf-row' }, [
			E('label', { 'for': 'nf-remember' }, [ remember, E('span', {}, T.remember) ]),
			forgot
		]);

		const submitBtn = dlg.querySelector('button.important');
		dlg.insertBefore(row, submitBtn);
		dlg.appendChild(helpBox);

		/* --- ошибка входа: подсветка поля и фокус --- */
		if (failed) {
			const alertEl = dlg.querySelector('.alert-message');
			if (alertEl)
				alertEl.textContent = T.bad;
			dlg.classList.add('nf-shake');
			if (pw)
				pw.classList.add('nf-bad');
		}

		form.addEventListener('keypress', (ev) => {
			if (ev.key === 'Enter')
				btn.click();
		});

		btn.addEventListener('click', () => {
			store((s) => remember.checked ? s.setItem(KEY, user.value) : s.removeItem(KEY));

			dlg.querySelectorAll('*').forEach((node) => {
				node.style.display = 'none';
			});
			dlg.appendChild(E('div', {
				class: 'spinning'
			}, _('Logging in…')));

			form.submit();
		});

		/* --- часы экрана блокировки --- */
		const lock = E('div', { 'class': 'nf-lock' }, [ E('b'), E('span') ]);
		const loc = document.documentElement.lang || undefined;
		const tick = () => {
			const now = new Date();
			lock.firstChild.textContent = now.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
			lock.lastChild.textContent = now.toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long' });
		};

		tick();
		window.setInterval(tick, 10000);
		document.body.appendChild(lock);

		/* --- показать пароль --- */
		if (pw) {
			const eye = E('button', { type: 'button', 'class': 'nf-eye', title: _('Show password'), 'aria-label': _('Show password'),
				click: (ev) => {
					ev.preventDefault();
					const show = pw.type === 'password';
					pw.type = show ? 'text' : 'password';
					eye.classList.toggle('on', show);
					pw.classList.toggle('nf-pw-on', show);
					pw.focus();
				} });
			pw.parentNode.classList.add('nf-pw');
			pw.parentNode.appendChild(eye);

			/* имя уже известно — сразу в пароль; иначе в имя */
			if (user.value) {
				pw.focus();
				if (failed)
					pw.select();
			}
			else {
				user.focus();
			}
		}

		return '';
	},

	addFooter() {},

});
