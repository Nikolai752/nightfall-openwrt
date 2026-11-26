'use strict';
'require view';
'require rpc';
'require fs';
'require poll';

/*
 * Nightfall: страница «Устройства». Карта сети (роутер в центре, устройства вокруг, живая скорость на линиях),
 * карточка устройства (своё имя, значок, группа, блокировка, расписание, лимит) и группы устройств
 * (правила на всю группу сразу: отключить, расписание, суточный лимит каждому).
 * Данные: nightfall-block list/groups, nightfall-history devices, iwinfo (уровень сигнала Wi-Fi).
 */

const BLOCK = '/usr/libexec/nightfall-block';
const HIST = '/usr/libexec/nightfall-history';
const EVERY = 3;   /* секунд между обновлениями */

const callIwDevs = rpc.declare({ object: 'iwinfo', method: 'devices', expect: { devices: [] } });
const callAssoc = rpc.declare({ object: 'iwinfo', method: 'assoclist', params: [ 'device' ], expect: { results: [] } });

const ICONS = [
	[ 'phone', '📱', _('Телефон') ], [ 'laptop', '💻', _('Ноутбук') ], [ 'pc', '🖥️', _('Компьютер') ], [ 'tablet', '📲', _('Планшет') ],
	[ 'tv', '📺', _('Телевизор') ], [ 'console', '🎮', _('Приставка') ], [ 'speaker', '🔊', _('Колонка') ], [ 'camera', '📷', _('Камера') ],
	[ 'printer', '🖨️', _('Принтер') ], [ 'iot', '💡', _('Умный дом') ], [ 'watch', '⌚', _('Часы') ], [ 'router', '📡', _('Роутер/точка') ], [ 'other', '❔', _('Другое') ]
];
const ICON = {}; ICONS.forEach(i => { ICON[i[0]] = i[1]; });
const GUESS = [
	[ /iphone|android|galaxy|pixel|redmi|xiaomi|poco|honor|huawei|oppo|realme|phone|телефон|手机|电话/i, 'phone' ], [ /ipad|tablet|планшет|平板/i, 'tablet' ],
	[ /macbook|laptop|notebook|thinkpad|ноутбук|笔记本/i, 'laptop' ], [ /desktop|\bpc\b|imac|компьют|电脑/i, 'pc' ], [ /tv|телев|bravia|webos|roku|chromecast|appletv|电视/i, 'tv' ],
	[ /playstation|ps[345]|xbox|nintendo|switch|steam/i, 'console' ], [ /echo|alice|алиса|speaker|sonos|колонк|音箱|音响/i, 'speaker' ], [ /cam|камер|ipc|reolink|hikvision|摄像头|相机/i, 'camera' ],
	[ /printer|принтер|epson|canon|brother|hp.?laser|打印机/i, 'printer' ], [ /watch|часы|band|手表/i, 'watch' ], [ /esp|tasmota|shelly|plug|lamp|bulb|sensor|tuya|zigbee|hue/i, 'iot' ],
	[ /ap|wifi|repeater|extender|mesh|router/i, 'router' ]
];

/* значки устройств: один набор линий, рисуется цветом текста темы */
const SHAPES = {
	phone: [ [ 'rect', { x: 7, y: 2, width: 10, height: 20, rx: 2.5 } ], [ 'path', { d: 'M11 18.5h2' } ] ],
	tablet: [ [ 'rect', { x: 4, y: 3, width: 16, height: 18, rx: 2 } ], [ 'path', { d: 'M11 18h2' } ] ],
	laptop: [ [ 'rect', { x: 5, y: 5, width: 14, height: 10, rx: 1.5 } ], [ 'path', { d: 'M2 19h20' } ] ],
	pc: [ [ 'rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 } ], [ 'path', { d: 'M9 20h6M12 16v4' } ] ],
	tv: [ [ 'rect', { x: 3, y: 6, width: 18, height: 12, rx: 2 } ], [ 'path', { d: 'M9 3l3 3 3-3' } ] ],
	console: [ [ 'rect', { x: 2, y: 8, width: 20, height: 9, rx: 4.5 } ], [ 'path', { d: 'M7 12.5h3M8.5 11v3' } ], [ 'circle', { cx: 15.5, cy: 12, r: .6 } ], [ 'circle', { cx: 17.5, cy: 13.5, r: .6 } ] ],
	speaker: [ [ 'rect', { x: 6, y: 2, width: 12, height: 20, rx: 3 } ], [ 'circle', { cx: 12, cy: 15, r: 3.5 } ], [ 'circle', { cx: 12, cy: 7, r: 1 } ] ],
	camera: [ [ 'path', { d: 'M2 8h4l2-3h8l2 3h4v11H2z' } ], [ 'circle', { cx: 12, cy: 13, r: 3.5 } ] ],
	printer: [ [ 'path', { d: 'M7 9V3h10v6' } ], [ 'rect', { x: 3, y: 9, width: 18, height: 8, rx: 2 } ], [ 'rect', { x: 7, y: 14, width: 10, height: 7 } ] ],
	iot: [ [ 'path', { d: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.1 1 1.9v.2h5v-.2c0-.8.4-1.4 1-1.9A6 6 0 0 0 12 3z' } ] ],
	watch: [ [ 'rect', { x: 7, y: 6, width: 10, height: 12, rx: 3 } ], [ 'path', { d: 'M9 6l.7-3h4.6l.7 3M9 18l.7 3h4.6l.7-3M12 10v2.5l1.5 1' } ] ],
	router: [ [ 'rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 } ], [ 'path', { d: 'M7 16.5h.01M11 16.5h.01M12 13V9M8.5 7a5 5 0 0 1 7 0M6 4.5a8.5 8.5 0 0 1 12 0' } ] ],
	other: [ [ 'circle', { cx: 12, cy: 12, r: 9 } ], [ 'path', { d: 'M12 8v5M12 16h.01' } ] ],
	group: [ [ 'circle', { cx: 9, cy: 8, r: 3 } ], [ 'path', { d: 'M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6' } ], [ 'circle', { cx: 17, cy: 9, r: 2.4 } ], [ 'path', { d: 'M16 14.2c2.8.2 5 2.4 5 5.3' } ] ]
};
/* значок как вложенный SVG: size в пикселях, x и y только внутри карты */
function glyph(name, size, x, y) {
	const a = { viewBox: '0 0 24 24', width: size, height: size, class: 'nf-ic', 'aria-hidden': 'true' };
	if (x != null) { a.x = x; a.y = y; }
	return svgEl('svg', a, (SHAPES[name] || SHAPES.other).map(sh => svgEl(sh[0], sh[1])));
}

const NF_LOC = (document.documentElement.lang || 'en').replace(/_/g, '-');
const nf1 = new Intl.NumberFormat(NF_LOC, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat(NF_LOC, { maximumFractionDigits: 0 });

function bytes(b) {
	if (b >= 1073741824) return nf1.format(b / 1073741824) + _(' ГБ');
	if (b >= 1048576) return nf1.format(b / 1048576) + _(' МБ');
	if (b >= 1024) return nf0.format(b / 1024) + _(' КБ');
	return nf0.format(b) + _(' Б');
}
function mbit(bps) { const m = bps * 8 / 1e6; return (m >= 10 ? nf0.format(m) : nf1.format(m)) + _(' Мбит/с'); }
const iconOf = d => (SHAPES[d.icon] ? d.icon : (GUESS.find(g => g[0].test(d.name || '')) || [ 0, 'other' ])[1]);
const show = d => d.name || d.ip || d.mac;
const parse = r => { try { return JSON.parse(r.stdout); } catch (e) { return null; } };

const opt = (value, text, on) => { const o = E('option', { value: value }, text); o.selected = !!on; return o; };

function svgEl(name, attrs, kids) {
	const e = document.createElementNS('http://www.w3.org/2000/svg', name);
	Object.keys(attrs || {}).forEach(k => e.setAttribute(k, attrs[k]));
	(kids || []).forEach(k => e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k));
	return e;
}

return view.extend({
	load() { return Promise.resolve(); },

	render() {
		const S = { devs: [], groups: [], rate: {}, day: {}, sig: {}, wifi: {}, sel: null, filter: '', note: '', busy: false, ok: null };
		const root = E('div', { class: 'nf-dv' });
		const mapBox = E('div', { class: 'nf-dv-map' });
		const side = E('div', { class: 'nf-dv-side' });
		const grpBox = E('div', { class: 'nf-dv-groups' });
		const chips = E('div', { class: 'nf-dv-chips' });
		const noteEl = E('div', { class: 'nf-dv-note', role: 'status' });

		const run = args => fs.exec(BLOCK, args).then(parse);
		function act(args, ok) {
			if (S.busy) return;
			S.busy = true;
			run(args).then(r => {
				S.busy = false;
				S.note = r && r.ok ? ok : ((r && r.error) || _('Нет ответа от роутера. Выйдите и войдите в LuCI снова (права обновляются при входе).'));
				refresh();
			}).catch(() => { S.busy = false; S.note = _('Не получилось выполнить команду.'); refresh(); });
		}

		const shown = () => S.devs.filter(d => !S.filter || (S.filter === '-' ? !d.group : d.group === S.filter));

		/* ---- карта сети ---- */
		function drawMap() {
			const list = shown().filter(d => d.online || d.active).sort((a, b) => (a.group || '').localeCompare(b.group || '') || show(a).localeCompare(show(b)));
			const W = 520, cx = W / 2, n = list.length, rad = n > 14 ? 205 : 165, H = n > 14 ? 500 : 420, cy = H / 2;
			const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'nf-dv-svg', role: 'img', 'aria-label': _('Карта сети') });
			const links = svgEl('g'), nodes = svgEl('g');
			svg.appendChild(links); svg.appendChild(nodes);
			list.forEach((d, i) => {
				const a = -Math.PI / 2 + 2 * Math.PI * i / Math.max(n, 1), x = cx + rad * Math.cos(a), y = cy + rad * 0.95 * Math.sin(a);
				const r = S.rate[d.ip] || [ 0, 0 ], bps = (r[0] || 0) + (r[1] || 0);
				const wifi = !!S.wifi[d.mac], busy = bps > 2000;
				const cls = 'nf-dv-link' + (wifi ? ' wifi' : '') + (d.active ? ' off' : '') + (busy ? ' busy' : '');
				const line = svgEl('line', { x1: cx, y1: cy, x2: x, y2: y, class: cls });
				if (busy) { line.style.strokeWidth = String(Math.min(6, 1.5 + Math.log10(bps / 1000))); line.style.animationDuration = Math.max(0.35, 2.4 - Math.log10(bps) * 0.3) + 's'; }
				links.appendChild(line);
				const g = svgEl('g', { class: 'nf-dv-node' + (S.sel === d.mac ? ' sel' : '') + (d.active ? ' off' : ''), tabindex: '0', role: 'button', 'aria-label': show(d) });
				g.setAttribute('transform', 'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ')');
				g.appendChild(svgEl('circle', { r: 28 }));
				g.appendChild(glyph(iconOf(d), 26, -13, -13));
				const label = show(d); g.appendChild(svgEl('text', { class: 'lb', 'text-anchor': 'middle', y: 47 }, [ label.length > 16 ? label.slice(0, 15) + '…' : label ]));
				if (busy) g.appendChild(svgEl('text', { class: 'sp', 'text-anchor': 'middle', y: 61 }, [ mbit(bps) ]));
				const pick = () => { S.sel = S.sel === d.mac ? null : d.mac; draw(); };
				g.addEventListener('click', pick);
				g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
				nodes.appendChild(g);
			});
			const hub = svgEl('g', { class: 'nf-dv-hub' }, [ svgEl('circle', { cx: cx, cy: cy, r: 38 }), glyph('router', 34, cx - 17, cy - 17) ]);
			svg.appendChild(hub);
			mapBox.replaceChildren(svg, n ? '' : E('div', { class: 'nf-dv-empty' }, _('Сейчас в этой группе нет устройств в сети.')));
		}

		/* ---- карточка выбранного устройства ---- */
		/* ---- расписание: несколько окон, у каждого свои дни недели ---- */
		const DAYN = [ _('Пн'), _('Вт'), _('Ср'), _('Чт'), _('Пт'), _('Сб'), _('Вс') ];
		function daysText(dy) {
			if (!dy) return _('каждый день');
			if (dy === '12345') return _('будни');
			if (dy === '67') return _('выходные');
			return dy.split('').map(x => DAYN[+x - 1]).join(', ');
		}
		function winsOf(o) {   // окна объекта: первое лежит в from/to/days, остальные в rules «с-до@дни;…»
			const w = [];
			if (o.from && o.to) w.push({ from: o.from, to: o.to, days: o.days || '' });
			(o.rules || '').split(';').forEach(r => { const m = /^(\d\d:\d\d)-(\d\d:\d\d)(?:@([1-7]*))?$/.exec(r); if (m) w.push({ from: m[1], to: m[2], days: m[3] || '' }); });
			return w;
		}
		function schedBox(o, cmd) {   // cmd: [ 'sadd', mac ] или [ 'gsadd', группа ]
			const grp = cmd[0] === 'gsadd', pre = grp ? 'gs' : 's';
			const f = E('input', { type: 'time', value: '23:00', 'aria-label': _('Отключать с') });
			const t = E('input', { type: 'time', value: '07:00', 'aria-label': _('Включать в') });
			const chk = DAYN.map((n, i) => E('input', { type: 'checkbox', value: String(i + 1), checked: true, 'aria-label': n }));
			const setDays = set => chk.forEach(c => { c.checked = set.indexOf(c.value) >= 0; });
			const picked = () => { const v = chk.filter(c => c.checked).map(c => c.value).join(''); return v === '1234567' ? '' : v; };
			const preset = (txt, set) => E('button', { type: 'button', class: 'cbi-button', click: () => setDays(set) }, txt);
			const wins = winsOf(o);
			const list = wins.map((w, i) => E('div', { class: 'nf-dv-row nf-dv-win' }, [
				E('span', {}, w.from + '–' + w.to + ' · ' + daysText(w.days)),
				E('button', { class: 'cbi-button', click: () => act([ pre + 'del', cmd[1], String(i + 1) ], _('Окно убрано.')) }, _('Убрать')) ]));
			if (wins.length > 1) list.push(E('div', { class: 'nf-dv-row' }, [ E('button', { class: 'cbi-button', click: () => act([ grp ? 'gsched' : 'sched', cmd[1], 'off' ], _('Расписание убрано.')) }, _('Убрать всё расписание')) ]));
			const add = () => {
				if (!chk.some(c => c.checked)) { window.alert(_('Отметьте хотя бы один день недели.')); return; }
				act([ cmd[0], cmd[1], f.value, t.value, picked() ], _('Окно добавлено.'));
			};
			return E('div', { class: 'nf-dv-sched' }, [
				E('small', {}, wins.length ? _('Отключать интернет по расписанию') : _('Расписание не задано')),
				E('div', {}, list),
				E('div', { class: 'nf-dv-row' }, [ E('span', {}, _('Отключать с')), f, E('span', {}, _('до')), t ]),
				E('div', { class: 'nf-dv-row nf-dv-days' }, chk.map((c, i) => E('label', {}, [ c, DAYN[i] ]))),
				E('div', { class: 'nf-dv-row' }, [ preset(_('Каждый день'), '1234567'), preset(_('Будни'), '12345'), preset(_('Выходные'), '67'),
					E('button', { class: 'cbi-button cbi-button-action', click: add }, _('Добавить окно')) ]) ]);
		}
		function sched(d) { return schedBox(d, [ 'sadd', d.mac ]); }
		function quota(d) {
			const q = E('input', { type: 'number', min: '1', max: '1000000', value: d.quota || '', placeholder: _('МБ в сутки'), 'aria-label': _('Лимит в сутки, МБ') });
			return E('div', { class: 'nf-dv-row' }, [ E('span', {}, _('Лимит в сутки')), q, E('span', {}, _('МБ')),
				E('button', { class: 'cbi-button cbi-button-action', click: () => act([ 'quota', d.mac, q.value || 'off', d.name || '' ], q.value ? _('Лимит сохранён.') : _('Лимит убран.')) }, _('Сохранить')) ]);
		}
		function detail(d) {
			const day = S.day[d.ip], sig = S.sig[d.mac], r = S.rate[d.ip] || [ 0, 0 ];
			const name = E('input', { type: 'text', value: d.name || '', maxlength: '40', placeholder: _('Имя устройства'), 'aria-label': _('Имя устройства') });
			const icon = E('select', { 'aria-label': _('Значок') }, ICONS.map(i => opt(i[0], i[1] + ' ' + i[2], (d.icon || '') === i[0])));
			if (!d.icon) icon.insertBefore(opt('', _('Авто'), true), icon.firstChild);
			const grp = E('select', { 'aria-label': _('Группа') }, [ opt('', _('Без группы'), !d.group) ].concat(S.groups.map(g => opt(g.name, g.name, g.name === d.group))));
			const state = d.active ? ({ manual: _('Отключено вручную'), gmanual: _('Отключено группой'), quota: _('Лимит исчерпан'), sched: _('Отключено по расписанию') }[d.reason] || _('Отключено')) : (d.online ? _('В сети') : _('Не в сети'));
			return E('div', { class: 'nf-dv-card' }, [
				E('div', { class: 'nf-dv-h' }, [ E('span', { class: 'ic' }, glyph(iconOf(d), 26)), E('div', {}, [ E('b', {}, show(d)), E('small', {}, state + (d.ip ? ' · ' + d.ip : '')) ]),
					E('button', { class: 'nf-dv-x', 'aria-label': _('Закрыть'), click: () => { S.sel = null; draw(); } }, '✕') ]),
				E('div', { class: 'nf-dv-kv' }, [
					E('div', {}, [ E('small', {}, _('Сегодня')), E('b', {}, day ? '↓ ' + bytes(day[0]) + ' ↑ ' + bytes(day[1]) : '—') ]),
					E('div', {}, [ E('small', {}, _('Сейчас')), E('b', {}, d.online ? '↓ ' + mbit(r[0] || 0) + ' ↑ ' + mbit(r[1] || 0) : '—') ]),
					E('div', {}, [ E('small', {}, _('Подключение')), E('b', {}, S.wifi[d.mac] ? 'Wi-Fi' + (sig ? ', ' + sig + _(' дБм') : '') : (d.online ? _('Кабель') : '—')) ]),
					E('div', {}, [ E('small', {}, 'MAC'), E('b', { class: 'mono' }, d.mac) ]) ]),
				d.quota ? E('div', { class: 'nf-dv-bar', title: _('Лимит') }, [ E('i', { style: 'width:' + Math.min(100, Math.round(100 * d.used / (d.quota * 1048576))) + '%' }), E('span', {}, bytes(d.used) + _(' из ') + d.quota + _(' МБ')) ]) : '',
				E('div', { class: 'nf-dv-row' }, [ name, icon, grp,
					E('button', { class: 'cbi-button cbi-button-action', click: () => act([ 'meta', d.mac, name.value.trim(), icon.value, grp.value ], _('Сохранено.')) }, _('Сохранить')) ]),
				E('div', { class: 'nf-dv-row' }, [ d.manual || d.reason === 'gmanual' || d.active
					? E('button', { class: 'cbi-button cbi-button-positive', click: () => act([ 'unblock', d.mac ], _('Интернет возвращён.')) }, d.manual ? _('Вернуть интернет') : _('Вернуть на сегодня'))
					: E('button', { class: 'cbi-button cbi-button-negative', click: () => act([ 'block', d.mac, d.name || '' ], _('Интернет отключён.')) }, _('Отключить интернет')) ]),
				sched(d), quota(d) ]);
		}

		/* ---- группы ---- */
		function groupRow(g) {
			const members = S.devs.filter(d => d.group === g.name);
			const q = E('input', { type: 'number', min: '1', max: '1000000', value: g.quota || '', placeholder: _('МБ'), 'aria-label': _('Лимит каждому в сутки, МБ') });
			const rules = [ g.manual ? _('отключена') : '', winsOf(g).length ? winsOf(g).map(w => w.from + '–' + w.to + ' ' + daysText(w.days)).join('; ') : '', g.quota ? _('лимит ') + g.quota + _(' МБ') : '' ].filter(Boolean).join(' · ') || _('без правил');
			return E('div', { class: 'nf-dv-grp' + (S.filter === g.name ? ' on' : '') }, [
				E('div', { class: 'nf-dv-h' }, [ E('span', { class: 'ic' }, glyph('group', 26)), E('div', {}, [ E('b', {}, g.name), E('small', {}, members.length + _(' устр. · ') + rules) ]),
					E('button', { class: 'cbi-button', click: () => { S.filter = S.filter === g.name ? '' : g.name; draw(); } }, S.filter === g.name ? _('Все устройства') : _('Показать')) ]),
				E('div', { class: 'nf-dv-row' }, [ g.manual
					? E('button', { class: 'cbi-button cbi-button-positive', click: () => act([ 'gunblock', g.name ], _('Группа «') + g.name + _('» снова в интернете.')) }, _('Вернуть интернет группе'))
					: E('button', { class: 'cbi-button cbi-button-negative', click: () => act([ 'gblock', g.name ], _('Группа «') + g.name + _('» отключена.')) }, _('Отключить всю группу')) ]),
					schedBox(g, [ 'gsadd', g.name ]),
				E('div', { class: 'nf-dv-row' }, [ E('span', {}, _('Лимит каждому')), q, E('span', {}, _('МБ/сутки')),
					E('button', { class: 'cbi-button cbi-button-action', click: () => act([ 'gquota', g.name, q.value || 'off' ], q.value ? _('Лимит группы сохранён.') : _('Лимит убран.')) }, _('Сохранить')) ]),
				E('div', { class: 'nf-dv-row' }, [ E('button', { class: 'cbi-button cbi-button-remove', click: () => { if (window.confirm(_('Удалить группу «') + g.name + _('»? Устройства останутся без группы.'))) { if (S.filter === g.name) S.filter = ''; act([ 'gdel', g.name ], _('Группа удалена.')); } } }, _('Удалить группу')) ]) ]);
		}
		function groupsPane() {
			const nm = E('input', { type: 'text', maxlength: '30', placeholder: _('Новая группа: Дети, Гости, Умный дом…'), 'aria-label': _('Название группы') });
			const add = () => { const v = nm.value.trim(); if (v) act([ 'gadd', v ], _('Группа «') + v + _('» создана. Добавьте в неё устройства в их карточках.')); };
			nm.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
			return [ E('div', { class: 'nf-dv-row nf-dv-add' }, [ nm, E('button', { class: 'cbi-button cbi-button-action', click: add }, _('Создать группу')) ]) ]
				.concat(S.groups.length ? S.groups.map(groupRow) : [ E('div', { class: 'nf-dv-empty' }, _('Групп пока нет. Создайте группу, например «Дети»: расписание и лимит будут действовать на все её устройства сразу.')) ]);
		}

		/* ---- список устройств ---- */
		function listPane() {
			const rows = shown().slice().sort((a, b) => ((b.online ? 1 : 0) - (a.online ? 1 : 0)) || show(a).localeCompare(show(b)));
			if (!rows.length) return E('div', { class: 'nf-dv-empty' }, _('Устройств нет.'));
			return E('div', { class: 'nf-dv-list' }, rows.map(d => {
				const r = S.rate[d.ip] || [ 0, 0 ], day = S.day[d.ip];
				return E('button', { type: 'button', class: 'nf-dv-item' + (S.sel === d.mac ? ' sel' : '') + (d.active ? ' off' : '') + (d.online ? '' : ' gone'), click: () => { S.sel = S.sel === d.mac ? null : d.mac; draw(); } }, [
					E('span', { class: 'ic' }, glyph(iconOf(d), 22)),
					E('span', { class: 'tx' }, [ E('b', {}, show(d)), E('small', {}, [ d.group ? d.group + ' · ' : '', d.active ? _('отключено') : (d.online ? (S.wifi[d.mac] ? 'Wi-Fi' : _('кабель')) : _('не в сети')), day ? ' · ' + bytes(day[0] + day[1]) + _(' сегодня') : '' ].join('')) ]),
					E('span', { class: 'sp' }, d.online && (r[0] + r[1]) > 2000 ? mbit(r[0] + r[1]) : '') ]);
			}));
		}

		function draw() {
			chips.replaceChildren(...[ [ '', _('Все') ] ].concat(S.groups.map(g => [ g.name, g.name ]), [ [ '-', _('Без группы') ] ]).map(c =>
				E('button', { type: 'button', class: 'nf-dv-chip', 'aria-pressed': String(S.filter === c[0]), click: () => { S.filter = c[0]; draw(); } }, c[1])));
			noteEl.textContent = S.note || '';
			if (S.ok === false) { mapBox.replaceChildren(E('div', { class: 'nf-dv-empty' }, _('Нет ответа от роутера. Выйдите и войдите в LuCI снова: права доступа обновляются при входе.'))); }
			else drawMap();
			const sel = S.devs.find(d => d.mac === S.sel);
			side.replaceChildren(...(sel ? [ detail(sel) ] : []), listPane());
			const key = JSON.stringify(S.groups) + S.filter + S.devs.map(d => d.mac + d.group).join();
			const a0 = document.activeElement;
			if (grpBox.dataset.k !== key && !(a0 && grpBox.contains(a0) && /INPUT/.test(a0.tagName))) { grpBox.replaceChildren(...groupsPane()); grpBox.dataset.k = key; }
		}

		function refresh() {
			return Promise.all([
				run([ 'list' ]).catch(() => null), run([ 'groups' ]).catch(() => null),
				fs.exec(HIST, [ 'devices' ]).then(parse).catch(() => null),
				callIwDevs().then(ds => Promise.all((ds || []).map(dv => callAssoc(dv).then(a => [ dv, a ]).catch(() => [ dv, [] ])))).catch(() => [])
			]).then(res => {
				const l = res[0], g = res[1], h = res[2];
				S.ok = !!(l && l.ok);
				if (l && l.ok) S.devs = l.devices;
				if (g && g.ok) S.groups = g.groups;
				S.rate = {}; S.day = {};
				if (h) { (h.rate || []).forEach(r => { S.rate[r[0]] = [ r[1], r[2] ]; }); (h.day || []).forEach(r => { S.day[r[0]] = [ r[1], r[2] ]; }); }
				S.wifi = {}; S.sig = {};
				(res[3] || []).forEach(p => (p[1] || []).forEach(c => { const m = String(c.mac || '').toLowerCase(); S.wifi[m] = true; if (c.signal) S.sig[m] = c.signal; }));
				const typing = document.activeElement && side.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName);
				if (!typing || S.note) draw();
			});
		}

		root.appendChild(E('div', { class: 'nf-dv-top' }, [ E('h2', {}, _('Устройства')), chips ]));
		root.appendChild(noteEl);
		root.appendChild(E('div', { class: 'nf-dv-grid' }, [ E('div', { class: 'nf-dv-col' }, [ mapBox ]), side ]));
		root.appendChild(E('h3', { class: 'nf-dv-gh' }, _('Группы')));
		root.appendChild(grpBox);
		draw();
		refresh();
		poll.add(() => { if (document.hidden) return; S.note = S.busy ? S.note : ''; return refresh(); }, EVERY);
		return root;
	},

	handleSave: null, handleSaveApply: null, handleReset: null
});
