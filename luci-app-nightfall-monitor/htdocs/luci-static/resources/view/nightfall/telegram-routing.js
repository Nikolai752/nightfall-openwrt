'use strict';
'require view';
'require fs';
'require ui';

const BIN = '/usr/libexec/nightfall-telegram-route';

function el(tag, attrs, children) {
	const node = E(tag, attrs || {});
	(children || []).forEach(child => node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child));
	return node;
}
function card(title, body) {
	return el('section', { class: 'nf-tr-card' }, [ el('h3', {}, [ title ]), ...body ]);
}
function pill(text, good) {
	return el('span', { class: 'nf-tr-pill ' + (good ? 'is-good' : 'is-muted') }, [ text ]);
}
function parseResult(result) {
	try { return JSON.parse(result.stdout || '{}'); }
	catch (e) { return { ok: false, error: _('Не удалось разобрать ответ диагностики') }; }
}

return view.extend({
	load: function() {
		return fs.exec(BIN, [ 'status' ]).then(parseResult).catch(function() {
			return { ok: false, error: _('Не удалось запустить диагностику. Проверьте права LuCI и наличие nightfall-telegram-route.') };
		});
	},

	render: function(data) {
		const root = el('div', { class: 'nf-tr-page' });
		root.appendChild(el('style', {}, [ `
.nf-tr-page { color:var(--nf-text,var(--text-color-highest,inherit)); }
.nf-tr-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin:0 0 16px; }
.nf-tr-head h2 { margin:0 0 4px; }
.nf-tr-sub { opacity:.72; }
.nf-tr-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
.nf-tr-card { min-width:0; padding:16px; margin-bottom:14px; border:1px solid var(--nf-stroke,var(--border-color,rgba(128,128,128,.25))); border-radius:12px; background:var(--nf-card,var(--background-color-medium,transparent)); }
.nf-tr-card h3 { margin:0 0 12px; font-size:1.08rem; }
.nf-tr-choice { display:flex; align-items:flex-start; gap:10px; padding:12px; margin:8px 0; border:1px solid var(--nf-stroke,var(--border-color,rgba(128,128,128,.25))); border-radius:10px; }
.nf-tr-choice input { margin-top:4px; }
.nf-tr-choice strong { display:block; }
.nf-tr-choice small { display:block; opacity:.72; margin-top:3px; }
.nf-tr-pill { display:inline-block; padding:3px 9px; border-radius:20px; font-size:12px; white-space:nowrap; }
.nf-tr-pill.is-good { color:#16834b; background:rgba(32,180,100,.13); }
.nf-tr-pill.is-muted { opacity:.7; background:rgba(128,128,128,.13); }
.nf-tr-row { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:9px 0; border-bottom:1px solid var(--nf-stroke,var(--border-color,rgba(128,128,128,.18))); }
.nf-tr-row:last-child { border-bottom:0; }
.nf-tr-note { margin-top:12px; padding:11px 13px; border-radius:10px; background:rgba(70,130,220,.10); }
.nf-tr-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; }
.nf-tr-empty { opacity:.7; padding:10px 0; }
@media(max-width:850px) { .nf-tr-grid { grid-template-columns:1fr; } }
` ]));

		root.appendChild(el('div', { class: 'nf-tr-head' }, [
			el('div', {}, [ el('h2', {}, [ _('Маршрутизация Telegram') ]), el('div', { class: 'nf-tr-sub' }, [ _('Отдельный маршрут для бота и уведомлений Nightfall') ]) ]),
			pill(data && data.ok ? _('Диагностика доступна') : _('Нет данных'), !!(data && data.ok))
		]));

		if (!data || !data.ok) {
			root.appendChild(card(_('Не удалось получить состояние'), [ el('p', {}, [ data && data.error || _('Неизвестная ошибка') ]) ]));
			return root;
		}

		const modes = card(_('Способ подключения'), [
			el('label', { class: 'nf-tr-choice' }, [
				el('input', { type: 'radio', name: 'tg-route-mode', value: 'system', checked: true, disabled: true }),
				el('span', {}, [ el('strong', {}, [ _('Системный маршрут') ]), el('small', {}, [ _('Обычная маршрутизация OpenWrt. Ничего не меняет в VPN.') ]) ])
			]),
			el('label', { class: 'nf-tr-choice' }, [
				el('input', { type: 'radio', name: 'tg-route-mode', value: 'proxy', disabled: true }),
				el('span', {}, [ el('strong', {}, [ _('Через прокси') ]), el('small', {}, [ _('SOCKS5 или HTTP(S). Использует существующую настройку прокси Telegram.') ]) ])
			]),
			el('label', { class: 'nf-tr-choice' }, [
				el('input', { type: 'radio', name: 'tg-route-mode', value: 'vpn', disabled: true }),
				el('span', {}, [ el('strong', {}, [ _('Через VPN') ]), el('small', {}, [ _('Выбор обнаруженного VPN-выхода. Будет включён после проверки адаптеров маршрутизации.') ]) ])
			]),
			el('div', { class: 'nf-tr-note' }, [ _('Сейчас доступен безопасный режим диагностики. Изменение маршрутов пока отключено: сначала проверяем API VPN-менеджеров, чтобы не повредить существующие правила.') ])
		]);

		const integrations = (data.integrations || []).map(item => el('div', { class: 'nf-tr-row' }, [
			el('span', {}, [ item.name ]),
			pill(item.found ? (item.version || _('обнаружен')) : _('не найден'), !!item.found)
		]));
		const outputs = (data.outputs || []).map(item => el('div', { class: 'nf-tr-row' }, [
			el('span', {}, [ el('strong', {}, [ item.device ]), el('small', {}, [ ' · ' + _('таблица') + ' ' + item.table + ' · ' + item.mark ]) ]),
			pill(item.up === 'up' ? _('Активен') : _('Неактивен'), item.up === 'up')
		]));
		const found = card(_('Обнаруженные интеграции'), integrations.length ? integrations : [ el('div', { class: 'nf-tr-empty' }, [ _('Совместимые менеджеры не обнаружены') ]) ]);
		const routes = card(_('Доступные policy-route выходы'), outputs.length ? outputs : [ el('div', { class: 'nf-tr-empty' }, [ _('Маршруты с fwmark не обнаружены') ]) ]);
		routes.appendChild(el('div', { class: 'nf-tr-note' }, [ _('Имена интерфейсов и таблиц считываются из системы. Nightfall не предполагает, что у всех пользователей VPN называется одинаково.') ]));
		root.appendChild(el('div', { class: 'nf-tr-grid' }, [ el('div', {}, [ modes, found ]), el('div', {}, [ routes ]) ]));

		root.appendChild(el('div', { class: 'nf-tr-actions' }, [
			el('button', { class: 'btn cbi-button-action', click: function() {
				fs.exec(BIN, [ 'status' ]).then(parseResult).then(function(next) {
					if (next && next.ok) window.location.reload();
					else ui.addNotification(null, E('p', {}, [ next.error || _('Ошибка обновления') ]), 'error');
				}).catch(function() { ui.addNotification(null, E('p', {}, [ _('Не удалось обновить диагностику') ]), 'error'); });
			} }, [ _('Обновить обнаружение') ])
		]));
		return root;
	}
});
