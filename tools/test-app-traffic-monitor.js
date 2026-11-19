#!/usr/bin/env node
'use strict';
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('luci-app-nightfall-monitor/htdocs/luci-static/resources/view/nightfall/monitor.js', 'utf8');
const start = source.indexOf('const APP_TRAFFIC_CATEGORIES =');
const end = source.indexOf('\n/* ---------- widgets ---------- */', start);
if (start < 0 || end < 0) throw new Error('application traffic classifier not found');
const api = vm.runInNewContext(source.slice(start, end) + '\n;({ appTrafficCategory, appTrafficDisplayName, sumMonitorAppTraffic, sumMonitorDeviceApps });');
const check = (ok, message) => { if (!ok) throw new Error('FAIL: ' + message); };
const data = {
  today: '20261118',
  enabled: 1,
  day: [
    ['192.0.2.10', 'ВКонтакте', 'VPN', 700, 30],
    ['192.0.2.10', 'ВКонтакте', 'Direct', 200, 10],
    ['192.0.2.10', 'Прочее · okcdn.ru', 'Direct', 900, 50],
    ['192.0.2.10', 'Прочее · Нет DNS-имени', 'Unknown', 300, 20],
    ['192.0.2.11', 'Telegram', 'VPN', 500, 10],
    ['192.0.2.11', 'Прочее · doubleclick.net', 'Direct', 100, 5]
  ],
  hist: [
    ['20261117', '192.0.2.10', 'Прочее · rtbcdn.ru', 'Direct', 100, 5],
    ['20261117', '192.0.2.11', 'Telegram', 'VPN', 200, 5],
    ['20261101', '192.0.2.10', 'YouTube', 'VPN', 999, 1]
  ]
};
const all = api.sumMonitorAppTraffic(data, 7, '');
check(all.routes.VPN === 1445, 'VPN total across today and history');
check(all.routes.Direct === 1370, 'Direct total across today and history');
check(all.routes.Unknown === 320, 'Unknown route total');
check(all.total === 3135, 'grand total');
check(all.categories.find(x => x.name === 'Социальные сети').total === 940, 'social category aggregation');
check(all.categories.find(x => x.name === 'CDN и инфраструктура').total === 950, 'shared CDN stays infrastructure, not a social app');
check(all.categories.find(x => x.name === 'Реклама и аналитика').total === 105, 'ad and analytics classification');
check(all.categories.find(x => x.name === 'Не определено').total === 425, 'missing DNS and uncertain domains remain unclassified');
const deviceApps = api.sumMonitorDeviceApps({
  day: [
    ['192.0.2.10', 'YouTube', 'Direct', 1000, 100],
    ['2001:db8::10', 'YouTube', 'VPN', 2000, 200],
    ['192.0.2.10', 'Broken route', 'Direct', 'Direct', 50],
    ['192.0.2.99', 'Other device', 'VPN', 9000, 900]
  ],
  hist: [
    ['20261117', '2001:db8::10', 'YouTube', 'VPN', 3000, 300],
    ['20261117', '192.0.2.10', 'Legacy row', 400, 40]
  ]
}, new Set(['192.0.2.10', '2001:db8::10']));
check(deviceApps.find(x => x[0] === 'YouTube')[1] === 6600, 'device app totals include all IPv4/IPv6 addresses and history');
check(deviceApps.find(x => x[0] === 'Broken route')[1] === 50, 'route labels are not parsed as byte counts');
check(deviceApps.find(x => x[0] === 'Legacy row')[1] === 440, 'legacy app row format remains readable');
check(!deviceApps.some(x => x[0] === 'Other device'), 'device app filter excludes unrelated IPs');
const one = api.sumMonitorAppTraffic(data, 7, '192.0.2.10');
check(one.routes.VPN === 730, 'device filter VPN');
check(one.routes.Direct === 1265, 'device filter Direct');
check(one.routes.Unknown === 320, 'device filter unknown');
check(api.appTrafficCategory('Прочее · Общий IP (CDN)') === 'Не определено', 'shared IP remains unclassified');
check(api.appTrafficCategory('Прочее · aaplimg.com') === 'Системные службы', 'Apple infrastructure classification');
check(api.appTrafficCategory('Прочее · rtbcdn.ru') === 'Не определено', 'uncertain RTB domain is not guessed');
check(api.appTrafficCategory('RuStore') === 'Магазины приложений', 'app store has a dedicated category');
check(api.appTrafficCategory('Прочее · shalltry.com') === 'Не определено', 'unknown domains are not guessed');
check(api.appTrafficCategory('Прочее · giants-software.com') === 'Игры', 'Farming Simulator publisher is grouped with games');
check(api.appTrafficCategory('Прочее · dbankcloud.ru') === 'Облака и хранилища', 'Huawei cloud domains are grouped as cloud storage');
check(api.appTrafficCategory('Прочее · tamtam.chat') === 'Мессенджеры и звонки', 'TamTam is grouped with messengers');
check(api.appTrafficCategory('Прочее · sberbank.ru') === 'Банки и платежи', 'Sberbank domain is grouped with banking');
check(api.appTrafficCategory('Прочее · 5ka.ru') === 'Продукты и магазины', 'grocery retailer domain has its own category');
check(api.appTrafficCategory('Прочее · snapchat.com') === 'Социальные сети', 'Snapchat is grouped with social networks');
check(api.appTrafficCategory('Прочее · palmplaystore.com') === 'Магазины приложений', 'Palm app store has a dedicated category');
check(api.appTrafficCategory('Прочее · revenuecat.com') === 'Платежи в приложениях', 'in-app billing stays distinct');
check(api.appTrafficCategory('Прочее · rtcdn.ru') === 'Видео и развлечения', 'RuTube CDN is grouped with video');
check(api.appTrafficCategory('Прочее · apptracer.ru') === 'Реклама и аналитика', 'application telemetry is grouped with analytics');
check(api.appTrafficDisplayName('Прочее · Нет DNS-имени') === 'IP без DNS-имени', 'missing DNS label is user friendly');
check(api.appTrafficDisplayName('Прочее · Общий IP (CDN)') === 'Общий IP / CDN', 'shared CDN label is explicit');
check(source.includes("[ 'apps', 'Трафик' ]"), 'monitor has the application traffic tab');
check(source.includes("if (S.tab === 'apps' && due('appTraffic', 30))"), 'application stats poll only on their tab');
check(source.includes('show(appsTab, S.tab === \'apps\')'), 'tab panel visibility is wired');
check(source.includes(".nfm-app-distribution { display:grid; grid-template-columns:minmax(190px,260px) minmax(0,1fr)"), 'distribution is a full-width horizontal panel on desktop');
check(source.includes("const remainingTotal = result.categories.slice(6).reduce"), 'collapsed legend reports the real aggregate volume');
check(source.includes("Прочие (' + remaining.length + ' категорий)'"), 'small categories can be expanded from the legend');
check(source.includes("card('Трафик по категориям', E('div', { class: 'nfm-app-categories' }"), 'category list occupies its own full-width row');
check(source.includes('function trafficBytes(value)') && source.includes('Number.isFinite(n) && n > 0'), 'device and history traffic totals reject non-numeric bytes');
check(source.includes("if (!Number.isFinite(b) || b < 0) return '—';"), 'byte formatter never prints NaN');
check(source.includes("if (!Number.isFinite(bps) || bps < 0) return [ '—', '' ];"), 'rate formatter never prints NaN');
check(source.includes('for (const [ dt, ip, app, route, d, u ] of A.hist || [])'), 'application CSV reads the route-aware historical schema');
check(source.includes('for (const [ ip, app, route, d, u ] of A.day || [])'), 'application CSV reads the route-aware daily schema');
check(source.includes(".nfm-app-category-bar > i"), 'category rows include proportional traffic bars');
check(source.includes(".nfm-app-distribution { grid-template-columns:minmax(0,1fr);"), 'mobile distribution stacks chart and legend');
check(source.includes("@media (max-width: 760px)"), 'responsive breakpoint covers 430px and 440px phones');
check(source.includes(".nfm-ti[data-ic='apps']"), 'traffic tab has its own chart icon');
console.log('Resource monitor application traffic tests: all passed.');
