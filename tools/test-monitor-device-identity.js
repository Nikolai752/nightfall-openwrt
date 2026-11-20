#!/usr/bin/env node
'use strict';

// Regression test for device identity with and without a Wi-Fi repeater.
// Execute the production helper directly from monitor.js (no mocked logic).
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname,
  '../luci-app-nightfall-monitor/htdocs/luci-static/resources/view/nightfall/monitor.js'), 'utf8');
const start = source.indexOf('function normalizeMonitorIp(ip)');
const end = source.indexOf('function monitorDeviceOwnsHistoricalRow(', start);
assert(start >= 0 && end > start, 'production identity helpers not found');
const context = {};
vm.runInNewContext(source.slice(start, end), context);

const sum = context.sumMonitorDeviceDailyTraffic;
const repeater = 'DE:0D:AB:73:AA:8E';
const macA = '10:10:10:10:10:10';
const macB = '20:20:20:20:20:20';
const macC = '30:30:30:30:30:30';
const direct = '40:40:40:40:40:40';

const hints = {
  [macA]: { ipaddrs: ['192.168.1.10'], ip6addrs: [] },
  [macB]: { ipaddrs: ['192.168.1.11'], ip6addrs: [] },
  [macC]: { ipaddrs: ['192.168.1.12'], ip6addrs: [] }
};
const neighbours = [
  ['192.168.1.10', repeater],
  ['192.168.1.11', repeater],
  ['192.168.1.12', repeater],
  ['192.168.1.50', direct],
  ['192.168.1.99', repeater]
];
const wifi = [{ mac: repeater }, { mac: direct }];
const rows = [
  ['192.168.1.10', 100, 10],
  ['192.168.1.11', 200, 20],
  ['192.168.1.12', 300, 30],
  ['192.168.1.50', 400, 40],
  ['192.168.1.99', 500, 50]
];
const got = sum(rows, hints, neighbours, wifi, new Set());
const byMac = Object.fromEntries(got.filter(x => x.mac).map(x => [x.mac, x.total]));
assert.strictEqual(byMac[macA], 110, 'DHCP identity A must survive repeater ARP MAC');
assert.strictEqual(byMac[macB], 220, 'DHCP identity B must survive repeater ARP MAC');
assert.strictEqual(byMac[macC], 330, 'DHCP identity C must survive repeater ARP MAC');
assert.strictEqual(byMac[direct], 440, 'a normal directly connected Wi-Fi client must still map');
assert(got.some(x => !x.mac && x.ip === '192.168.1.99' && x.total === 550),
  'unknown client behind a detected repeater must remain separate, not merge into repeater MAC');

const noRepeater = sum(
  [['192.168.1.60', 700, 70]],
  {},
  [['192.168.1.60', direct]],
  [{ mac: direct }],
  new Set()
);
assert.strictEqual(noRepeater.length, 1);
assert.strictEqual(noRepeater[0].mac, direct,
  'without repeater evidence, active Wi-Fi neighbour fallback must continue to work');

console.log('OK: repeater clients stay separate; direct Wi-Fi client fallback is preserved.');
