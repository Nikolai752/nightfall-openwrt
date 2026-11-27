#!/usr/bin/env node
'use strict';

// Regression tests for authoritative DHCP identity, proxy neighbours and ordinary networks.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root,
  'luci-app-nightfall-monitor/htdocs/luci-static/resources/view/nightfall/monitor.js'), 'utf8');
const start = source.indexOf('function normalizeMonitorIp(ip)');
const end = source.indexOf('function monitorDeviceOwnsHistoricalRow(', start);
assert(start >= 0 && end > start, 'production identity helpers not found');
const context = { _: msgid => msgid };
vm.runInNewContext(source.slice(start, end), context);

const repeater = 'DE:0D:AB:73:AA:8E';
const station24 = 'D2:0D:AB:73:AA:8E';
const reMgmt = 'D4:0D:AB:73:AA:8D';
const pad = 'DE:4D:0A:58:83:C1';
const yandex = '60:3D:61:C4:8A:A4';
const iphone = '9C:FC:28:99:43:A0';
const unknown = '34:10:BE:8B:C4:5D';
const direct = '04:7C:16:17:AB:EA';

const leases = [
  ['192.168.1.110', unknown, ''],
  ['192.168.1.132', yandex, 'Yandex-Station3'],
  ['192.168.1.180', iphone, 'iPhone'],
  ['192.168.1.191', pad, 'Redmi-Pad'],
  ['192.168.1.216', reMgmt, 'RE3000'],
  ['192.168.1.214', direct, 'Olhovskii_NN']
];
const hints = {
  [repeater]: {
    ipaddrs: ['192.168.1.110', '192.168.1.132', '192.168.1.180', '192.168.1.191', '192.168.1.216'],
    ip6addrs: ['fe80::413:2dc3:bce4:21a9'], name: 'Redmi-Pad.lan'
  },
  [unknown]: { ipaddrs: ['192.168.1.110'], ip6addrs: [] },
  [yandex]: { ipaddrs: ['192.168.1.132'], ip6addrs: [], name: 'Yandex-Station3.lan' },
  [iphone]: { ipaddrs: ['192.168.1.180'], ip6addrs: [], name: 'iPhone.lan' },
  [pad]: { ipaddrs: ['192.168.1.191'], ip6addrs: [], name: 'Redmi-Pad.lan' },
  [reMgmt]: { ipaddrs: ['192.168.1.216'], ip6addrs: [], name: 'RE3000.lan' },
  [direct]: { ipaddrs: ['192.168.1.214'], ip6addrs: [], name: 'Olhovskii_NN.lan' }
};
const neighbours = [
  ['192.168.1.110', repeater, 'REACHABLE'],
  ['192.168.1.132', repeater, 'REACHABLE'],
  ['192.168.1.180', repeater, 'STALE'],
  ['192.168.1.191', repeater, 'REACHABLE'],
  ['192.168.1.216', repeater, 'REACHABLE'],
  ['192.168.1.214', direct, 'REACHABLE']
];
const wifi = [
  { mac: station24, signal: -53, ssid: '2.4 GHz', band: '2g' },
  { mac: repeater, signal: -64, ssid: '5 GHz', band: '5g' },
  { mac: direct, signal: -51, ssid: '2.4 GHz', band: '2g' }
];

const resolved = context.monitorBuildIpMacMap(hints, neighbours, wifi, leases);
assert.strictEqual(resolved['192.168.1.110'], unknown, 'DHCP MAC must beat the false proxy host-hint');
assert.strictEqual(resolved['192.168.1.132'], yandex, 'Yandex Station must keep its DHCP MAC');
assert.strictEqual(resolved['192.168.1.180'], iphone, 'iPhone must keep its DHCP MAC');
assert.strictEqual(resolved['192.168.1.191'], pad, 'Redmi Pad must keep its own DHCP MAC');
assert.strictEqual(resolved['192.168.1.216'], reMgmt, 'range-extender management lease must keep its own MAC');
assert.strictEqual(resolved['192.168.1.214'], direct, 'direct Wi-Fi client keeps its real MAC');
assert.notStrictEqual(resolved['192.168.1.110'], repeater, 'proxy station MAC must never replace endpoint MAC');

const totals = context.sumMonitorDeviceDailyTraffic([
  ['192.168.1.110', 100, 10], ['192.168.1.132', 200, 20],
  ['192.168.1.180', 300, 30], ['192.168.1.191', 400, 40],
  ['192.168.1.214', 500, 50]
], hints, neighbours, wifi, new Set(), leases);
const totalsByMac = Object.fromEntries(totals.map(x => [x.mac, x.total]));
assert.strictEqual(totalsByMac[unknown], 110);
assert.strictEqual(totalsByMac[yandex], 220);
assert.strictEqual(totalsByMac[iphone], 330);
assert.strictEqual(totalsByMac[pad], 440);
assert.strictEqual(totalsByMac[direct], 550);
assert(!Object.prototype.hasOwnProperty.call(totalsByMac, repeater), 'traffic is not merged into repeater radio MAC');

const wifiRows = context.monitorBuildWifiDisplayRows(wifi, hints, neighbours, leases);
const stationRow = wifiRows.find(x => x.mac === repeater);
assert(stationRow && stationRow.proxyStation, 'shared active neighbour is marked as a bridge station');
assert.strictEqual(stationRow.displayName, 'RE3000', 'bridge station uses infrastructure lease name, not downstream alias');
const downstream = wifiRows.filter(x => x.proxy);
assert.strictEqual(downstream.length, 4, 'four endpoints are shown behind bridge; management record is not duplicated');
assert.deepStrictEqual(new Set(downstream.map(x => x.mac)), new Set([unknown, yandex, iphone, pad]));

// Ordinary network, no repeater: a direct client remains one row and gets no special marker.
const ordinaryHints = { [direct]: { ipaddrs: ['192.0.2.10'], ip6addrs: [], name: 'Phone.lan' } };
const ordinaryLeases = [['192.0.2.10', direct, 'Phone']];
const ordinaryWifi = [{ mac: direct, signal: -55, band: '5g', ssid: 'Home' }];
const ordinary = context.monitorBuildWifiDisplayRows(ordinaryWifi, ordinaryHints,
  [['192.0.2.10', direct, 'REACHABLE']], ordinaryLeases);
assert.strictEqual(ordinary.length, 1, 'no repeater means no synthetic downstream rows');
assert(!ordinary[0].proxy && !ordinary[0].proxyStation);
assert.strictEqual(context.monitorBuildIpMacMap(ordinaryHints,
  [['192.0.2.10', direct, 'REACHABLE']], ordinaryWifi, ordinaryLeases)['192.0.2.10'], direct);

// A shared proxy MAC without DHCP evidence cannot identify several downstream IPs.
const noLeaseProxy = context.monitorBuildIpMacMap({}, [
  ['192.0.2.20', repeater, 'REACHABLE'], ['192.0.2.21', repeater, 'STALE']
], [{ mac: repeater }], []);
assert(!noLeaseProxy['192.0.2.20'] && !noLeaseProxy['192.0.2.21']);

// Conflicting DHCP leases stay unresolved; hints and neighbour data cannot choose one.
const ambiguousIp = '192.0.2.30';
const ambiguous = context.monitorBuildIpMacMap({
  [unknown]: { ipaddrs: [ambiguousIp], ip6addrs: [] }
}, [[ambiguousIp, direct, 'REACHABLE']], [{ mac: direct }], [
  [ambiguousIp, unknown, 'client-a'], [ambiguousIp, direct, 'client-b']
]);
assert(!ambiguous[ambiguousIp], 'ambiguous DHCP IP is not assigned to an arbitrary MAC');

// Legacy/static configurations retain a unique host-hint fallback without DHCP.
const legacy = context.monitorBuildIpMacMap({
  [direct]: { ipaddrs: ['192.0.2.50'], ip6addrs: [], name: 'Legacy.lan' }
}, [['192.0.2.50', direct, 'REACHABLE']], [{ mac: direct }], []);
assert.strictEqual(legacy['192.0.2.50'], direct);
assert(context.monitorIsInfrastructureName('RE3000.lan'));
assert(!context.monitorIsInfrastructureName('Redmi-Pad.lan'));

// The production history endpoint exposes live DHCP leases to the UI.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightfall-identity-'));
try {
  const leaseFile = path.join(tmp, 'dhcp.leases');
  const neighFile = path.join(tmp, 'neigh');
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(leaseFile, [
    [now + 3600, unknown.toLowerCase(), '192.168.1.110', '*'].join(' '),
    [now + 3600, reMgmt.toLowerCase(), '192.168.1.216', 'RE3000'].join(' ')
  ].join('\n') + '\n');
  fs.writeFileSync(neighFile, '');
  const history = path.join(root, 'luci-app-nightfall-monitor/root/usr/libexec/nightfall-history');
  const output = execFileSync('sh', [history, 'devices'], {
    encoding: 'utf8',
    env: { ...process.env, NF_DIR: path.join(tmp, 'state'), NF_LEASES: leaseFile, NF_NEIGH: neighFile }
  });
  const payload = JSON.parse(output);
  assert.deepStrictEqual(payload.leases, [
    ['192.168.1.110', unknown, ''], ['192.168.1.216', reMgmt, 'RE3000']
  ], 'devices endpoint returns valid DHCP leases with names');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('OK: DHCP identity wins, proxy MACs do not merge clients, and non-repeater networks remain unchanged.');
