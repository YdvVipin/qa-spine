/**
 * D2: the demo opens on the Release page, with three example releases, one of each kind, on
 * synthetic data only, and Ship anyway works against its throwaway store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDemo, DEMO_RELEASES } from '../src/demo.ts';
import { releaseView, decideRelease } from '../src/release-view.ts';
import { shouldOpenBrowser, openCommand } from '../src/server.ts';

function withDemo(fn: (store: ReturnType<typeof runDemo>['store']) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-demo-releases-'));
  try {
    const { store } = runDemo(join(dir, 'trace.db'), join(dir, 'brief.html'));
    try {
      fn(store);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the three example releases read Ready to ship, Not ready and Can\'t tell yet', () => {
  withDemo((store) => {
    assert.deepEqual(
      DEMO_RELEASES.map((r) => [r.label, releaseView(store, r).headline]),
      [
        ['Ready to ship', 'Ready to ship'],
        ['Not ready', 'Not ready'],
        ["Can't tell yet", "Can't tell yet"],
      ],
    );
  });
});

test('the examples are synthetic: invented PROJ keys and personas, a made-up shop', () => {
  for (const r of DEMO_RELEASES) {
    assert.match(r.release, /^shop-\d+\.\d+$/);
    for (const key of r.changed) assert.match(key, /^PROJ-\d+$/);
  }
});

test('Ship anyway works on the Not ready example, and is refused on Can\'t tell yet', () => {
  withDemo((store) => {
    const notReady = DEMO_RELEASES.find((r) => r.label === 'Not ready')!;
    const v = decideRelease(store, { ...notReady, action: 'ship_anyway', name: 'rahul', reason: 'The fix ships on Monday; few customers use it.', defects: ['SHOP-91'] });
    assert.equal(v.decided?.headline, 'Shipped anyway');
    const cantTell = DEMO_RELEASES.find((r) => r.label === "Can't tell yet")!;
    assert.throws(() => decideRelease(store, { ...cantTell, action: 'ship_anyway', name: 'rahul', reason: 'We have to ship this one today.', defects: ['SHOP-91'] }), /cannot be shipped anyway/);
  });
});

test('the browser opens only for a person at a terminal, never in CI or with --no-open', () => {
  assert.equal(shouldOpenBrowser({ isTTY: true, env: {}, args: [] }), true);
  assert.equal(shouldOpenBrowser({ isTTY: false, env: {}, args: [] }), false);
  assert.equal(shouldOpenBrowser({ isTTY: true, env: { CI: 'true' }, args: [] }), false);
  assert.equal(shouldOpenBrowser({ isTTY: true, env: {}, args: ['--no-open'] }), false);
  assert.deepEqual(openCommand('darwin', 'http://x'), ['open', ['http://x']]);
  assert.deepEqual(openCommand('win32', 'http://x'), ['cmd', ['/c', 'start', '', 'http://x']]);
  assert.deepEqual(openCommand('linux', 'http://x'), ['xdg-open', ['http://x']]);
});
