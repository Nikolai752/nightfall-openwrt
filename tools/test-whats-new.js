'use strict';
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('luci-theme-nightfall/htdocs/luci-static/nightfall/nightfall.js', 'utf8');
const start = source.indexOf('\tfunction versionParts(');
const end = source.indexOf('\n\tfunction updCache()', start);
if (start < 0 || end < 0) throw new Error('Version comparison helpers were not found');

const context = {};
vm.runInNewContext(source.slice(start, end) + '\nglobalThis.compareVersions = isNewer;', context);

const cases = [
  ['1.27.7-alpha.1-test5', '1.27.7', true],
  ['1.27.7', '1.27.7-alpha.1-test5', false],
  ['1.27.6', '1.27.7', true],
  ['1.27.7', '1.27.7', false],
  ['1.27.7-alpha.1', '1.27.7-alpha.2', true],
  ['1.27.7-alpha.2', '1.27.7-alpha.1', false],
  ['1.27.7-beta.1', '1.27.7-rc.1', true],
  ['1.27.7-rc.1', '1.27.7', true]
];
for (const [oldVersion, newVersion, expected] of cases) {
  const actual = context.compareVersions(oldVersion, newVersion);
  if (actual !== expected) {
    throw new Error(oldVersion + ' -> ' + newVersion + ': expected ' + expected + ', got ' + actual);
  }
}
console.log('Version precedence tests passed.');
