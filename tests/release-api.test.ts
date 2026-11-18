/**
 * The Release page's API over HTTP: GET /api/release returns the view; POST /api/release/decide
 * records Ship, Hold or Ship anyway under the rules a release manager is shown.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { TraceStore } from '../src/trace/store.ts';
import { createInspector } from '../src/inspector/server.ts';
import { ingestJunit } from '../src/junit.ts';

const human = { producer: 'human' as const };

async function serve(store: TraceStore, t: TestContext) {
  const server = createInspector(store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path: string, init?: RequestInit) => fetch(base + path, init);
}

/** QA-1 passes; QA-2 fails with bug BUG-7; QA-3 has a test with no result. */
export function seedReleases() {
  const s = new TraceStore(':memory:');
  const story = (key: string, text: string) => s.record({ type: 'requirement', sourceRef: key, content: { text }, provenance: human });
  story('QA-1', 'Totals include tax.');
  const qa2 = story('QA-2', 'Refunds post within a day.');
  const qa3 = story('QA-3', 'Receipts are emailed.');
  ingestJunit(s, { reports: [{ file: 'r.xml', xml: '<testsuite><testcase classname="cart" name="QA-1 total has tax"/></testsuite>' }], runRef: 'ci/1' });
  const refund = s.record({ type: 'test_case', content: { name: 'refund posts next day' }, provenance: human, links: [{ to: qa2.id, relation: 'covers' }] });
  s.record({ type: 'test_run', content: { status: 'failed', bug_key: 'BUG-7' }, provenance: { ...human, approvedBy: 'priya' }, links: [{ to: refund.id, relation: 'verifies' }] });
  s.record({ type: 'test_case', content: { name: 'receipt email arrives' }, provenance: human, links: [{ to: qa3.id, relation: 'covers' }] });
  return s;
}

test('GET /api/release returns the view for the stories in the link', async (t) => {
  const get = await serve(seedReleases(), t);
  const r = await get('/api/release?release=shop-1.5&changed=QA-1,QA-2');
  assert.equal(r.status, 200);
  const v = await r.json();
  assert.equal(v.summary, 'Not ready: 1 test failed');
  assert.equal(v.failed[0].bug, 'BUG-7');
});

test('GET /api/release for an undecided release with no stories is 404 with how to open it', async (t) => {
  const get = await serve(seedReleases(), t);
  const r = await get('/api/release?release=shop-9');
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /\?release=shop-9&changed=/);
  assert.equal((await get('/api/release')).status, 400, 'no release id at all');
});

test('GET /api/release on an empty store is 400 with the reason, not a server error', async (t) => {
  const get = await serve(new TraceStore(':memory:'), t);
  const r = await get('/api/release?release=r1&changed=QA-1');
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /empty|nothing/i);
});
