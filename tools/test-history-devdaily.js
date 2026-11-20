#!/usr/bin/env node
'use strict';

// Run the production nightfall-history serializer against large archived counters.
// Values deliberately exceed signed 32-bit range (2 GiB); JSON must retain them.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const history = path.join(root, 'luci-app-nightfall-monitor/root/usr/libexec/nightfall-history');
const historySource = fs.readFileSync(history, 'utf8');
const serializer = historySource.split('devdaily)')[1]?.split('known)')[0] || '';
assert(serializer.includes('%.0f,%.0f'),
  'production devdaily serializer must use floating-point-safe integer formatting (%.0f)');
assert(!serializer.includes('%d,%d'),
  'production devdaily serializer must not use narrow %d formatting');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightfall-devdaily-'));

try {
  fs.writeFileSync(path.join(dir, 'dev.daily'), [
    '20261119 192.168.1.191 25160614811 414815153 de:4d:0a:58:83:c1',
    '20261119 192.168.1.110 14532914559 2453589016 34:10:be:8b:c4:5d',
    '20261119 192.168.1.214 2541146251 5769244553 04:7c:16:17:ab:ea'
  ].join('\n') + '\n');

  const output = execFileSync('sh', [history, 'devdaily'], {
    encoding: 'utf8',
    env: { ...process.env, NF_DIR: dir }
  });
  const result = JSON.parse(output);
  assert.strictEqual(result.rows.length, 3, 'all archived device rows must be serialized');

  const byIp = Object.fromEntries(result.rows.map(row => [row[1], row]));
  assert.strictEqual(byIp['192.168.1.191'][2], 25160614811,
    'RX above 2 GiB must not be truncated');
  assert.strictEqual(byIp['192.168.1.110'][3], 2453589016,
    'TX above 2 GiB must not be truncated');
  assert.strictEqual(byIp['192.168.1.214'][2], 2541146251,
    'second RX counter above 2 GiB must remain exact');
  assert.strictEqual(byIp['192.168.1.214'][3], 5769244553,
    'second TX counter above 2 GiB must remain exact');
  assert.strictEqual(byIp['192.168.1.191'][4], 'de:4d:0a:58:83:c1',
    'archived MAC must remain unchanged');

  console.log('OK: devdaily JSON preserves RX/TX counters above 2 GiB and archived MACs.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
