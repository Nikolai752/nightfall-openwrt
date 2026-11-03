'use strict';
'require view';
'require ui';

/*
 * Nightfall: страница со всеми элементами интерфейса (Система → «Nightfall: все элементы»).
 * Нужна, чтобы быстро проверить тему на телефоне и компьютере в светлом и тёмном режиме после любой правки:
 * вкладки, кнопки, формы, таблицы (в том числе список Wi-Fi клиентов), уведомления, окна.
 * Внизу есть имитация опроса LuCI: блок пересоздаётся раз в 5 секунд, как на страницах «Статус» и «Wi-Fi»,
 * и сразу видно, дёргается ли страница.
 */

const nf = new Intl.NumberFormat('ru-RU');
const CLIENTS = [
	[ 'Точка доступа "2.4 GHz" (phy0-ap0)', '60:3D:61:C4:8A:A4', 'Yandex-Station3.lan (192.168.1.132, fd61:bde8:2d8d::805)', -71, '72.2 Мбит/с, 20 МГц, MCS 7, Короткий GI' ],
	[ 'Точка доступа "2.4 GHz" (phy0-ap0)', '3A:09:E7:7F:81:FE', '192.168.1.174', -73, '65 Мбит/с, 20 МГц, MCS 7' ],
	[ 'Точка доступа "5 GHz" (phy1-ap0)', '24:55:9A:72:CB:07', 'BULAT.lan (192.168.1.113, fe80::c2:a4b2:8ad0:6c64)', -44, '1200.9 Мбит/с, 80 МГц, HE-MCS 11, HE-NSS 2' ]
];

function section(title, nodes) {
	return E('div', { 'class': 'cbi-section' }, [ E('h3', {}, title) ].concat(nodes));
}

function row(title, widget, descr) {
	return E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title' }, title),
		E('div', { 'class': 'cbi-value-field' }, [ widget, descr ? E('div', { 'class': 'cbi-value-description' }, descr) : '' ])
	]);
}

function table(cols, rows, cls) {
	return E('div', { 'class': 'table ' + (cls || 'cbi-section-table') }, [
		E('div', { 'class': 'tr table-titles cbi-section-table-titles' }, cols.map(c => E('div', { 'class': 'th cbi-section-table-cell' }, c))),
		...rows.map(r => E('div', { 'class': 'tr cbi-section-table-row' }, r.map(c => E('div', { 'class': 'td cbi-section-table-cell' }, c))))
	]);
}

function clientsTable(jitter) {
	return table([ 'Сеть', 'MAC-адрес', 'Хост', 'Сигнал / Шум', 'Скорость приёма / Скорость передачи', '' ],
		CLIENTS.map(c => [
			E('span', { 'class': 'ifacebadge' }, c[0]), c[1], c[2],
			E('span', { 'class': 'ifacebadge' }, (c[3] + (jitter ? Math.round(Math.random() * 6 - 3) : 0)) + ' / -92 дБм'),
			c[4],
			E('button', { 'class': 'cbi-button cbi-button-remove' }, 'Отключить')
		]), 'assoclist');
}

return view.extend({
	render() {
		let simTimer = null, simTicks = 0;
		const simBox = E('div'), simInfo = E('div', { 'class': 'cbi-value-description' });

		const simTick = () => {
			simTicks++;
			simInfo.textContent = 'Обновлений: ' + simTicks + '. Если страница дёргается, значит, что-то перерисовывается заметно.';
			/* как у LuCI: каждый раз новые узлы, включая класс fade-in и заголовки таблицы */
			simBox.replaceChildren(E('div', { 'class': 'cbi-section fade-in' }, [ E('h3', {}, 'Подключённые клиенты (имитация опроса)'), clientsTable(true) ]));
		};
		const simToggle = on => {
			window.clearInterval(simTimer); simTimer = null;
			if (on) { simTick(); simTimer = window.setInterval(simTick, 5000); }
			else { simBox.replaceChildren(); simInfo.textContent = 'Выключено.'; }
		};
		const simCb = E('input', { type: 'checkbox', change: ev => simToggle(ev.target.checked) });

		const tabs = E('ul', { 'class': 'cbi-tabmenu' }, [
			E('li', { 'class': 'cbi-tab' }, E('a', { href: '#' }, 'Активная')),
			E('li', { 'class': 'cbi-tab-disabled' }, E('a', { href: '#' }, 'Вторая')),
			E('li', { 'class': 'cbi-tab-disabled' }, E('a', { href: '#' }, 'Блокировка рекламы')),
			E('li', { 'class': 'cbi-tab-disabled' }, E('a', { href: '#' }, 'DNS over HTTPS')),
			E('li', { 'class': 'cbi-tab-disabled' }, E('a', { href: '#' }, 'Удалённый доступ')),
			E('li', { 'class': 'cbi-tab-disabled' }, E('a', { href: '#' }, 'Монитор ресурсов'))
		]);
		tabs.addEventListener('click', ev => {
			const li = ev.target.closest && ev.target.closest('li');
			if (!li) return;
			ev.preventDefault();
			tabs.querySelectorAll('li').forEach(x => { x.className = x === li ? 'cbi-tab' : 'cbi-tab-disabled'; });
		});

		const dd = new ui.Dropdown('b', { a: 'Первый вариант', b: 'Второй вариант', c: 'Третий вариант, подлиннее' }, {});
		const sel = new ui.Select('b', { a: 'Автоматически', b: '2.4 ГГц', c: '5 ГГц' }, {});

		return E('div', {}, [
			E('h2', { name: 'content' }, 'Nightfall: все элементы интерфейса'),
			E('div', { 'class': 'cbi-map-descr' }, 'Откройте эту страницу на телефоне и на компьютере, в светлой и тёмной теме, и прокрутите до конца. Всё должно быть читаемо, без обрезанных и налезающих элементов.'),

			section('Вкладки', [ tabs, E('p', {}, 'Нажмите на вкладку: активная подсвечивается акцентным цветом.') ]),

			section('Уведомления', [
				E('div', { 'class': 'alert-message info' }, [ E('h4', {}, 'Информация'), E('p', {}, 'Обычное сообщение для пользователя.') ]),
				E('div', { 'class': 'alert-message warning' }, [ E('h4', {}, 'Предупреждение'), E('p', {}, 'Что-то требует внимания, но не критично.') ]),
				E('div', { 'class': 'alert-message danger' }, [ E('h4', {}, 'Ошибка'), E('p', {}, 'Действие не удалось выполнить.') ]),
				E('div', {}, [
					E('button', { 'class': 'cbi-button', click: () => ui.addNotification(null, E('p', {}, 'Тестовое уведомление'), 'info') }, 'Показать уведомление'),
					' ',
					E('button', { 'class': 'cbi-button', click: () => ui.showModal('Тестовое окно', [ E('p', {}, 'Так выглядят модальные окна.'), E('div', { 'class': 'right' }, E('button', { 'class': 'btn', click: ui.hideModal }, 'Закрыть')) ]) }, 'Показать окно')
				])
			]),

			section('Кнопки', [
				E('div', {}, [
					E('button', { 'class': 'cbi-button' }, 'Обычная'), ' ',
					E('button', { 'class': 'cbi-button cbi-button-action important' }, 'Главная'), ' ',
					E('button', { 'class': 'cbi-button cbi-button-positive' }, 'Сохранить'), ' ',
					E('button', { 'class': 'cbi-button cbi-button-negative' }, 'Удалить'), ' ',
					E('button', { 'class': 'cbi-button', disabled: true }, 'Недоступна')
				])
			]),

			section('Форма', [
				row('Текстовое поле', new ui.Textfield('значение', { placeholder: 'Введите текст' }).render(), 'Подпись под полем.'),
				row('Пароль', new ui.Textfield('secret', { password: true }).render()),
				row('Список (select)', sel.render()),
				row('Выпадающий список', dd.render()),
				row('Переключатель', new ui.Checkbox(true, { value_enabled: '1', value_disabled: '0' }).render()),
				row('Выбор одного', E('label', {}, [ E('input', { type: 'radio', name: 'g', checked: true }), ' Один  ', E('input', { type: 'radio', name: 'g' }), ' Два' ])),
				row('Многострочное поле', new ui.Textarea('строка 1\nстрока 2', { rows: 3 }).render()),
				row('Полоса', E('div', { 'class': 'cbi-progressbar', title: '42%' }, E('div', { style: 'width:42%' })))
			]),

			section('Таблица', [
				table([ 'Имя', 'Адрес', 'Состояние' ], [
					[ 'lan', '192.168.1.1/24', 'работает' ],
					[ 'wan', 'очень-длинное-имя-устройства-без-пробелов.example.org', 'нет связи' ],
					[ 'wg0', 'fd61:bde8:2d8d:0:2d8:4d03:f7b:da35', 'работает' ]
				])
			]),

			section('Подключённые клиенты (как на странице Wi-Fi)', [ clientsTable(false) ]),

			section('Имитация опроса (проверка дёргания)', [
				row('Обновлять каждые 5 секунд', simCb, 'Включите и наблюдайте 20–30 секунд: страница не должна мигать и подпрыгивать.'),
				simInfo, simBox
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
