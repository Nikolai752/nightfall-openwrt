#!/usr/bin/env node
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'luci-theme-nightfall/htdocs/luci-static/resources/nightfall-overview.js'), 'utf8');
const start = source.indexOf('function sumApps(');
const end = source.indexOf('\nfunction appsCard()', start);
if (start < 0 || end < 0) throw new Error('sumApps() not found');
const sumApps = vm.runInNewContext('(' + source.slice(start, end).replace(/^function sumApps/, 'function') + ')', { ymd: d => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate() });
const data = {
  today: '20261118',
  day: [
    ['192.0.2.10', 'YouTube', 'VPN', 700, 30],
    ['192.0.2.10', 'YouTube', 'Direct', 200, 10],
    ['192.0.2.10', 'Прочее · okcdn.ru', 'Direct', 900, 50],
    ['192.0.2.10', 'Прочее', 'Unknown', 300, 20],
    ['192.0.2.11', 'Telegram', 'VPN', 500, 10]
  ],
  hist: [
    ['20261117', '192.0.2.10', 'Прочее · rtbcdn.ru', 'Direct', 100, 5],
    ['20261117', '192.0.2.11', 'Telegram', 'VPN', 200, 5]
  ]
};
function check(ok, message) { if (!ok) throw new Error('FAIL: ' + message); }
let result = sumApps(data, 1, '');
check(result.routes.VPN === 1240, 'today VPN total');
check(result.routes.Direct === 1160, 'today Direct total');
check(result.routes.Unknown === 320, 'today Unknown total');
check(result.other['okcdn.ru\u001fDirect'][0] === 900, 'domain key uses unit separator');
check(result.other['\u001fUnknown'][0] === 300, 'domainless Unknown bucket');
result = sumApps(data, 7, '192.0.2.10');
check(result.routes.VPN === 730, 'device filter + history VPN');
check(result.routes.Direct === 1265, 'device filter + history Direct');
check(result.routes.Unknown === 320, 'device filter + Unknown');
check(source.includes('k.split(String.fromCharCode(31))'), 'Other chip parser splits the actual unit separator');
check(source.includes('fmtBytes(r.routes[route])'), 'route badges expose byte totals without hover');
check(source.includes('nf-apps-other-row'), 'unclassified traffic uses readable structured rows');
check(source.includes('Общие CDN и конфликтующие домены остаются здесь'), 'UI explains why shared CDNs stay unclassified');
check(source.includes("'Неизв.'"), 'unknown route label is explicit, not a question mark');
check(source.includes('IP без DNS-имени'), 'missing DNS is explained separately');
check(source.includes('Общий IP / CDN'), 'shared CDN conflict is visible');
check(source.includes('DoH/DoT, внешний DNS'), 'UI lists possible reasons without claiming certainty');
console.log('Application traffic UI tests: all passed.');
