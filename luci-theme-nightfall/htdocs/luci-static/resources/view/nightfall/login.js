'use strict';
'require ui';
'require view';

/*
 * Nightfall: экран входа.
 * Кроме стандартного окна LuCI: сводка о роутере (из data-* шаблона),
 * запоминание имени пользователя, подсказки про Caps Lock и раскладку,
 * подсказка «Забыли пароль?». Пароль темой нигде не сохраняется (его может запомнить браузер).
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
	zh: {
		net: '互联网', up: '运行时间', fw: '固件', speed: '网速', test: '测速', mbit: 'Mbps', temp: '温度', cpu: '处理器', mem: '内存', cl: '设备', dec: '.',
		online: '在线', offline: '无连接', nodata: '无数据', ms: '毫秒',
		d: '天', h: '小时', m: '分',
		remember: '记住用户名', forgot: '忘记密码？',
		caps: '大写锁定已开启', layout: '输入了中文字符——请检查输入法',
		bad: '用户名或密码错误。请检查输入法和大写锁定。',
		helpTitle: '如何在没有密码的情况下登录',
		help: [
			[ '有 SSH 访问权限', '连接后执行：passwd' ],
			[ '没有访问权限', '重启路由器，在启动初期指示灯快速闪烁时按下 reset（按键位置因型号而异）。用网线连接 192.168.1.1，通过 telnet 执行：mount_root; passwd; reboot' ],
			[ '都不行', '按住 reset 按钮约 10 秒恢复出厂设置。所有设置将丢失。' ]
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
		const T = /^zh/i.test(lang) ? TEXT.zh : /^ru|^uk|^be/i.test(lang) ? TEXT.ru : TEXT.en;
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

		/* сводку (карточки) рисует nightfall.js: он всегда свежий, а этот модуль браузер может держать в кэше */

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
			const msg = caps ? T.caps : /[\u0400-\u04FF\u4e00-\u9fff]/.test(pw.value) ? T.layout : '';
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

		let busy = false;
		btn.addEventListener('click', () => {
			if (busy)
				return;
			busy = true;
			store((s) => remember.checked ? s.setItem(KEY, user.value) : s.removeItem(KEY));

			/* настоящая отправка формы (с событием submit, пока поля видны): так браузер и менеджер паролей замечают вход
			   и предлагают сохранить пароль. Раньше поля прятались до отправки, и предложение «Сохранить пароль?» не появлялось. */
			if (form.requestSubmit)
				form.requestSubmit();
			else
				form.submit();

			window.setTimeout(() => {
				dlg.querySelectorAll('*').forEach((node) => {
					node.style.display = 'none';
				});
				dlg.appendChild(E('div', {
					class: 'spinning'
				}, _('Logging in…')));
			}, 50);
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
