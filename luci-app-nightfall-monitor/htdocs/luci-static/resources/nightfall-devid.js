'use strict';
'require baseclass';

/*
 * Nightfall: опознавание устройства по MAC-адресу и имени узла.
 *  - приватный (случайный) MAC: у телефонов с «частным адресом Wi‑Fi» второй бит первого байта равен 1 — по такому адресу
 *    производителя узнать нельзя, и это надо показывать честно, а не гадать;
 *  - производитель по первым трём байтам (OUI): компактная таблица самых частых домашних производителей.
 *    Это не полный список IEEE (в нём десятки тысяч записей): неизвестный префикс просто остаётся без подписи;
 *  - вид устройства (телефон, ТВ, компьютер…) по имени узла и по производителю.
 * Используется Монитором и карточками «Сейчас» (тема подключает модуль, если он есть).
 */

/* префикс (6 символов hex) → производитель; значение «Имя|вид» (вид необязателен) */
const OUI = {
	/* Apple */
	'000393': 'Apple', '000a27': 'Apple', '000a95': 'Apple', '000d93': 'Apple', '001124': 'Apple', '001451': 'Apple', '0016cb': 'Apple',
	'0017f2': 'Apple', '0019e3': 'Apple', '001b63': 'Apple', '001cb3': 'Apple', '001d4f': 'Apple', '001e52': 'Apple', '001ec2': 'Apple',
	'001ff3': 'Apple', '0021e9': 'Apple', '002241': 'Apple', '002312': 'Apple', '002332': 'Apple', '00236c': 'Apple', '0023df': 'Apple',
	'002436': 'Apple', '002500': 'Apple', '00254b': 'Apple', '0025bc': 'Apple', '002608': 'Apple', '00264a': 'Apple', '0026b0': 'Apple',
	'0026bb': 'Apple', '3c0754': 'Apple', 'f01898': 'Apple', 'acbc32': 'Apple', '9801a7': 'Apple',
	/* платформы разработчиков и «умный дом» */
	'b827eb': 'Raspberry Pi|pc', 'dca632': 'Raspberry Pi|pc', 'e45f01': 'Raspberry Pi|pc', 'd83add': 'Raspberry Pi|pc', '2ccf67': 'Raspberry Pi|pc',
	'240ac4': 'Espressif|iot', '30aea4': 'Espressif|iot', '7c9ebd': 'Espressif|iot', 'a4cf12': 'Espressif|iot', '840d8e': 'Espressif|iot',
	'246f28': 'Espressif|iot', '5ccf7f': 'Espressif|iot', 'bcddc2': 'Espressif|iot', '84cca8': 'Espressif|iot', 'c44f33': 'Espressif|iot',
	'ecfabc': 'Espressif|iot', '3c71bf': 'Espressif|iot', 'cc50e3': 'Espressif|iot', '8caab5': 'Espressif|iot', '68c63a': 'Espressif|iot',
	/* колонки, консоли */
	'000e58': 'Sonos|speaker', '5caafd': 'Sonos|speaker', '7828ca': 'Sonos|speaker', 'b8e937': 'Sonos|speaker', '949f3e': 'Sonos|speaker',
	'0009bf': 'Nintendo|console', '001656': 'Nintendo|console', '0017ab': 'Nintendo|console', '00191d': 'Nintendo|console', '001ae9': 'Nintendo|console',
	'001bea': 'Nintendo|console', '001cbe': 'Nintendo|console', '001e35': 'Nintendo|console', '001f32': 'Nintendo|console', '002147': 'Nintendo|console',
	'0022aa': 'Nintendo|console', '0024f3': 'Nintendo|console', '002659': 'Nintendo|console', '8c56c5': 'Nintendo|console', '98b6e9': 'Nintendo|console',
	/* виртуальные машины и контейнеры */
	'000c29': 'VMware|vm', '005056': 'VMware|vm', '000569': 'VMware|vm', '001c14': 'VMware|vm', '00155d': 'Microsoft Hyper-V|vm',
	'080027': 'VirtualBox|vm', '525400': 'QEMU/KVM|vm',
	/* сетевое оборудование */
	'50c7bf': 'TP-Link|net', '14cc20': 'TP-Link|net', '98dac4': 'TP-Link|net', 'f4f26d': 'TP-Link|net', '002719': 'TP-Link|net', '54c80f': 'TP-Link|net',
	'10feed': 'TP-Link|net', '60e327': 'TP-Link|net', 'a0f3c1': 'TP-Link|net', 'ec086b': 'TP-Link|net', '647002': 'TP-Link|net', '30b5c2': 'TP-Link|net',
	'c04a00': 'TP-Link|net', '8416f9': 'TP-Link|net',
	'00e04c': 'Realtek', '001b21': 'Intel', '001e64': 'Intel', '00216a': 'Intel', '001302': 'Intel', '3ca9f4': 'Intel', '001500': 'Intel',
	'0016ea': 'Intel'
};

/* вид устройства: [шаблон имени узла, код] — первый совпавший побеждает */
const KIND_RE = [
	[ /ipad|tablet|galaxy-?tab|\bsm-t\d|mi-?pad|lenovo-?tab|matepad|планшет/i, 'tablet' ],
	[ /iphone|android|galaxy|\bsm-[a-z]\d|pixel|redmi|xiaomi|poco|huawei|honor|oneplus|realme|oppo|vivo|phone|\bmi-?\d|nothing|телефон|смартфон|мобильн/i, 'phone' ],
	[ /watch|band|fitbit|garmin|часы|браслет/i, 'watch' ],
	[ /playstation|\bps[345]\b|xbox|nintendo|switch-?\d?|steamdeck|steam-?deck/i, 'console' ],
	[ /\btv\b|-tv|tv-|bravia|webos|roku|chromecast|firetv|fire-?stick|shield|appletv|apple-?tv|smarttv|tizen|android-?tv|mi-?box|телевизор|(?:^|[^а-яёa-z])тв(?:[^а-яёa-z]|$)/i, 'tv' ],
	[ /print|laserjet|deskjet|officejet|epson|canon|brother|pixma|mfp|принтер|мфу/i, 'printer' ],
	[ /cam|hikvision|ezviz|imou|reolink|dahua|tapo-?c|doorbell|камера|видеоняня|звонок/i, 'camera' ],
	[ /echo|alexa|homepod|sonos|yandex|station|jbl|speaker|google-?home|nest-?(mini|audio)|колонка|алиса/i, 'speaker' ],
	[ /esp[-_]?\d*|tasmota|shelly|sonoff|tuya|yeelight|zigbee|homeassistant|hass|wled|xiaomi-?(plug|gateway)|lumi|bulb|plug|relay|лампа|лампочка|розетка|датчик|реле|пылесос/i, 'iot' ],
	[ /openwrt|router|repeater|extender|access-?point|\bap\b|switch|mesh|tl-|tp-?link|keenetic|mikrotik|ubnt|unifi/i, 'net' ],
	[ /macbook|imac|mac-?mini|mac-?pro|desktop|laptop|notebook|thinkpad|\bpc\b|workstation|ubuntu|debian|fedora|arch|raspberry|rpi|server|nas|synology|win-?\d|windows|ноутбук|компьютер|(?:^|[^а-яёa-z])пк(?:[^а-яёa-z]|$)|системник/i, 'pc' ]
];

const KIND_LABEL = {
	phone: 'Телефон', tablet: 'Планшет', watch: 'Часы', console: 'Приставка', tv: 'Телевизор', printer: 'Принтер', camera: 'Камера',
	speaker: 'Колонка', iot: 'Умный дом', net: 'Сеть', pc: 'Компьютер', vm: 'Виртуальная машина', unk: 'Устройство'
};

/* значки: простые контуры 24×24 */
const KIND_SVG = {
	phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
	tablet: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M11 18h2"/>',
	watch: '<rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 6l1-4h4l1 4M9 18l1 4h4l1-4"/>',
	console: '<rect x="2" y="8" width="20" height="10" rx="5"/><path d="M7 11v4M5 13h4"/><circle cx="16" cy="12.5" r=".9"/><circle cx="18.5" cy="14.5" r=".9"/>',
	tv: '<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M8 3l4 3 4-3"/>',
	printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><rect x="7" y="14" width="10" height="7"/>',
	camera: '<path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3"/>',
	speaker: '<rect x="6" y="2" width="12" height="20" rx="2"/><circle cx="12" cy="15" r="3"/><circle cx="12" cy="7" r="1"/>',
	iot: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
	net: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 17h.01M11 17h.01M12 13V9M8.5 9.5a5 5 0 0 1 7 0"/>',
	pc: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
	vm: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
	unk: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7M12 17h.01"/>'
};

function norm(mac) {
	const m = String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
	return m.length === 12 ? m : '';
}

return baseclass.extend({
	KIND_LABEL: KIND_LABEL,
	norm: norm,

	/* приватный (случайный, «locally administered») адрес: производителя по нему узнать нельзя */
	isPrivate: function(mac) {
		const m = norm(mac);
		return m ? (parseInt(m.slice(0, 2), 16) & 2) === 2 : false;
	},

	/* опознавание: { vendor, kind, label, priv, hint } */
	identify: function(mac, host) {
		const m = norm(mac), priv = m ? this.isPrivate(m) : false;
		let vendor = '', kind = '';
		const ent = m && !priv ? OUI[m.slice(0, 6)] : '';
		if (ent) { const p = ent.split('|'); vendor = p[0]; kind = p[1] || ''; }
		const h = String(host || '');
		if (h) for (const [ re, k ] of KIND_RE) if (re.test(h)) { kind = k; break; }
		if (!vendor && /iphone|ipad|macbook|imac|mac-?mini|apple/i.test(h)) vendor = 'Apple';
		const label = KIND_LABEL[kind] || '';
		let hint = '';
		if (priv) hint = 'Частный (случайный) MAC: у устройства включён «частный адрес Wi‑Fi», производителя по нему узнать нельзя';
		else if (vendor) hint = 'Производитель по MAC: ' + vendor;
		return { vendor: vendor, kind: kind || 'unk', label: label, priv: priv, hint: hint, known: !!(vendor || kind) };
	},

	/* значок вида устройства (строка SVG, без внешних данных) */
	icon: function(kind) {
		return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
			+ (KIND_SVG[kind] || KIND_SVG.unk) + '</svg>';
	}
});
