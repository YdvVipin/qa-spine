/**
 * The documents a new user reads first must agree with the package they install. Each check here
 * caught a real drift: PROJECT_STATUS.md said 29 Sep and Node 22.5 two releases after both stopped
 * being true.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const read = (f: string) => readFileSync(f, 'utf8');

test('the newest changelog section is this package version, with a date', () => {
  const top = read('CHANGELOG.md').match(/^## (\S+) — (\d{4}-\d{2}-\d{2})$/m);
  assert.ok(top, 'a "## <version> — <YYYY-MM-DD>" heading');
  assert.equal(top[1], pkg.version);
});

test('README and PROJECT_STATUS name the Node the package needs, and no older one', () => {
  const engine = pkg.engines.node.replace('>=', '');
  for (const f of ['README.md', 'PROJECT_STATUS.md']) {
    const text = read(f);
    assert.ok(text.includes(`Node >= ${engine}`) || text.includes(`Node ${engine}`), `${f} names Node ${engine}`);
    assert.doesNotMatch(text, /22\.5\b/, `${f} still says Node 22.5`);
  }
});

test('npx is the way in: the README opens with it, and nothing tells you to install globally', () => {
  const readme = read('README.md');
  const firstScreen = readme.split('\n').slice(0, 30).join('\n');
  assert.match(firstScreen, /npx qa-spine demo/);
  assert.match(firstScreen, /npx qa-spine init/);
  for (const f of ['README.md', 'PROJECT_STATUS.md']) assert.doesNotMatch(read(f), /npm (install|i) -g/, f);
});

test('PROJECT_STATUS describes this version, not an old snapshot', () => {
  const status = read('PROJECT_STATUS.md');
  assert.ok(status.includes(pkg.version), `mentions ${pkg.version}`);
  assert.doesNotMatch(status, /2026-09-29|stacked:/);
});
