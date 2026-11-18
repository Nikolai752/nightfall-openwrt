#!/usr/bin/env node
'use strict';
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('luci-app-nightfall-monitor/htdocs/luci-static/resources/view/nightfall/monitor.js', 'utf8');
const start = source.indexOf('const APP_TRAFFIC_CATEGORIES =');
const end = source.indexOf('\n/* ---------- widgets ---------- */', start);
if (start < 0 || end < 0) throw new Error('application traffic classifier not found');
const api = vm.runInNewContext(source.slice(start, end) + '\n;({ appTrafficCategory, appTrafficDisplayName, sumMonitorAppTraffic });');
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
const one = api.sumMonitorAppTraffic(data, 7, '192.0.2.10');
check(one.routes.VPN === 730, 'device filter VPN');
check(one.routes.Direct === 1265, 'device filter Direct');
check(one.routes.Unknown === 320, 'device filter unknown');
check(api.appTrafficCategory('Прочее · Общий IP (CDN)') === 'Не определено', 'shared IP remains unclassified');
check(api.appTrafficCategory('Прочее · aaplimg.com') === 'Системные службы', 'Apple infrastructure classification');
check(api.appTrafficCategory('Прочее · rtbcdn.ru') === 'Не определено', 'uncertain RTB domain is not guessed');
check(api.appTrafficCategory('RuStore') === 'Магазины приложений', 'app store has a dedicated category');
check(api.appTrafficCategory('Прочее · shalltry.com') === 'Не определено', 'unknown domains are not guessed');
check(api.appTrafficDisplayName('Прочее · Нет DNS-имени') === 'IP без DNS-имени', 'missing DNS label is user friendly');
check(api.appTrafficDisplayName('Прочее · Общий IP (CDN)') === 'Общий IP / CDN', 'shared CDN label is explicit');
check(source.includes("[ 'apps', 'Трафик' ]"), 'monitor has the application traffic tab');
check(source.includes("if (S.tab === 'apps' && due('appTraffic', 30))"), 'application stats poll only on their tab');
check(source.includes('show(appsTab, S.tab === \'apps\')'), 'tab panel visibility is wired');
console.log('Resource monitor application traffic tests: all passed.');
