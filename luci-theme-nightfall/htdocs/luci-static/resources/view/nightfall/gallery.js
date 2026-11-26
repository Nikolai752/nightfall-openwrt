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
	return table([ _( 'Сеть' ), _( 'MAC-адрес' ), _( 'Хост' ), _( 'Сигнал / Шум' ), _( 'Скорость приёма / Скорость передачи' ), '' ],
		CLIENTS.map(c => [
			E('span', { 'class': 'ifacebadge' }, _( c[0] )), c[1], c[2],
			E('span', { 'class': 'ifacebadge' }, (c[3] + (jitter ? Math.round(Math.random() * 6 - 3) : 0)) + _( ' / -92 дБм' )),
			_( c[4] ),
			E('button', { 'class': 'cbi-button cbi-button-remove' }, _( 'Отключить' ))
		]), 'assoclist');
}

return view.extend({
	render() {
		let simTimer = null, simTicks = 0;
		const simBox = E('div'), simInfo = E('div', { 'class': 'cbi-value-description' });

		const simTick = () => {
			simTicks++;
			simInfo.textContent = _( 'Обновлений: %s. Если страница дёргается, значит, что-то перерисовывается заметно.' ).format( simTicks );
			/* как у LuCI: каждый раз новые узлы, включая класс fade-in и заголовки таблицы */
			simBox.replaceChildren(E('div', { 'class': 'cbi-section fade-in' }, [ E('h3', {}, _( 'Подключённые клиенты (имитация опроса)' )), clientsTable(true) ]));
		};
		const simToggle = on => {
			window.clearInterval(simTimer); simTimer = null;
			if (on) { simTick(); simTimer = window.setInterval(simTick, 5000); }
			else { simBox.replaceChildren(); simInfo.textContent = _( 'Выключено.' ); }
		};
		const simCb = E('input', { type: 'checkbox', change: ev => simToggle(ev.target.checked) });

		const tabs = E('ul', { 'class': 'cbi-tabmenu' }, [
			E('li', { 'class': 'cbi-tab' }, E('a', { href: '#' }, _( 'Активная' ))),
			E('li', { 'class': 'cbi-tab-disabled' }, E('a', { href: '#' }, _( 'Вторая' ))),
			E('li', { 'class': 'cbi-tab-disabled' }, E('a', { href: '#' }, _( 'Блокировка рекламы' ))),
			E('li', { 'class': 'cbi-tab-disabled' }, E('a', { href: '#' }, 'DNS over HTTPS')),
			E('li', { 'class': 'cbi-tab-disabled' }, E('a', { href: '#' }, _( 'Удалённый доступ' ))),
			E('li', { 'class': 'cbi-tab-disabled' }, E('a', { href: '#' }, _( 'Монитор ресурсов' )))
		]);
		tabs.addEventListener('click', ev => {
			const li = ev.target.closest && ev.target.closest('li');
			if (!li) return;
			ev.preventDefault();
			tabs.querySelectorAll('li').forEach(x => { x.className = x === li ? 'cbi-tab' : 'cbi-tab-disabled'; });
		});

		const dd = new ui.Dropdown('b', { a: _( 'Первый вариант' ), b: _( 'Второй вариант' ), c: _( 'Третий вариант, подлиннее' ) }, {});
		const sel = new ui.Select('b', { a: _( 'Автоматически' ), b: _( '2.4 ГГц' ), c: _( '5 ГГц' ) }, {});

		return E('div', {}, [
			E('h2', { name: 'content' }, _( 'Nightfall: все элементы интерфейса' )),
			E('div', { 'class': 'cbi-map-descr' }, _( 'Откройте эту страницу на телефоне и на компьютере, в светлой и тёмной теме, и прокрутите до конца. Всё должно быть читаемо, без обрезанных и налезающих элементов.' )),

			section( _( 'Вкладки' ), [ tabs, E('p', {}, _( 'Нажмите на вкладку: активная подсвечивается акцентным цветом.' )) ]),

			section( _( 'Уведомления' ), [
				E('div', { 'class': 'alert-message info' }, [ E('h4', {}, _( 'Информация' )), E('p', {}, _( 'Обычное сообщение для пользователя.' )) ]),
				E('div', { 'class': 'alert-message warning' }, [ E('h4', {}, _( 'Предупреждение' )), E('p', {}, _( 'Что-то требует внимания, но не критично.' )) ]),
				E('div', { 'class': 'alert-message danger' }, [ E('h4', {}, _( 'Ошибка' )), E('p', {}, _( 'Действие не удалось выполнить.' )) ]),
				E('div', {}, [
					E('button', { 'class': 'cbi-button', click: () => ui.addNotification(null, E('p', {}, _( 'Тестовое уведомление' )), 'info') }, _( 'Показать уведомление' )),
					' ',
					E('button', { 'class': 'cbi-button', click: () => ui.showModal( _( 'Тестовое окно' ), [ E('p', {}, _( 'Так выглядят модальные окна.' )), E('div', { 'class': 'right' }, E('button', { 'class': 'btn', click: ui.hideModal }, _( 'Закрыть' ) )) ]) }, _( 'Показать окно' ))
				])
			]),

			section( _( 'Кнопки' ), [
				E('div', {}, [
					E('button', { 'class': 'cbi-button' }, _( 'Обычная' )), ' ',
					E('button', { 'class': 'cbi-button cbi-button-action important' }, _( 'Главная' )), ' ',
					E('button', { 'class': 'cbi-button cbi-button-positive' }, _( 'Сохранить' )), ' ',
					E('button', { 'class': 'cbi-button cbi-button-negative' }, _( 'Удалить' )), ' ',
					E('button', { 'class': 'cbi-button', disabled: true }, _( 'Недоступна' ))
				])
			]),

			section( _( 'Форма' ), [
				row( _( 'Текстовое поле' ), new ui.Textfield( _( 'значение' ), { placeholder: _( 'Введите текст' ) } ).render(), _( 'Подпись под полем.' )),
				row( _( 'Пароль' ), new ui.Textfield('secret', { password: true }).render()),
				row( _( 'Список (select)' ), sel.render()),
				row( _( 'Выпадающий список' ), dd.render()),
				row( _( 'Переключатель' ), new ui.Checkbox(true, { value_enabled: '1', value_disabled: '0' }).render()),
				row( _( 'Выбор одного' ), E('label', {}, [ E('input', { type: 'radio', name: 'g', checked: true }), _( ' Один  ' ), E('input', { type: 'radio', name: 'g' }), _( ' Два' ) ])),
				row( _( 'Многострочное поле' ), new ui.Textarea( _( 'строка 1\nстрока 2' ), { rows: 3 } ).render()),
				row( _( 'Полоса' ), E('div', { 'class': 'cbi-progressbar', title: '42%' }, E('div', { style: 'width:42%' })))
			]),

			section( _( 'Таблица' ), [
				table([ _( 'Имя' ), _( 'Адрес' ), _( 'Состояние' ) ], [
					[ 'lan', '192.168.1.1/24', _( 'работает' ) ],
					[ 'wan', _( 'очень-длинное-имя-устройства-без-пробелов.example.org' ), _( 'нет связи' ) ],
					[ 'wg0', 'fd61:bde8:2d8d:0:2d8:4d03:f7b:da35', _( 'работает' ) ]
				])
			]),

			section( _( 'Подключённые клиенты (как на странице Wi-Fi)' ), [ clientsTable(false) ]),

			section( _( 'Имитация опроса (проверка дёргания)' ), [
				row( _( 'Обновлять каждые 5 секунд' ), simCb, _( 'Включите и наблюдайте 20–30 секунд: страница не должна мигать и подпрыгивать.' )),
				simInfo, simBox
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
