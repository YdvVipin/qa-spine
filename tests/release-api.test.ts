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

const post = (get: (p: string, i?: RequestInit) => Promise<Response>, body: Record<string, unknown>) =>
  get('/api/release/decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const verdicts = (s: TraceStore) => s.list('verdict');

test('Ship on a ready release records a ship with the name, and the page says Ready to ship', async (t) => {
  const s = seedReleases();
  const get = await serve(s, t);
  const r = await post(get, { release: 'shop-1.4', changed: ['QA-1'], action: 'ship', name: 'rahul' });
  assert.equal(r.status, 200, await r.clone().text());
  const v = await r.json();
  assert.equal(v.decided.headline, 'Ready to ship');
  assert.equal(v.decided.by, 'rahul');
  assert.equal(verdicts(s)[0].content.verdict, 'ship');
});

test('Ship anyway on a Not ready release needs a name, a 20+ character reason and a Jira key, and records them', async (t) => {
  const s = seedReleases();
  const get = await serve(s, t);
  const base = { release: 'shop-1.5', changed: ['QA-1', 'QA-2'], action: 'ship_anyway' };
  const refusals: [Record<string, unknown>, RegExp][] = [
    [{ name: '  ', reason: 'Refund fix ships next week; low volume.', defects: ['BUG-7'] }, /your name/i],
    [{ name: 'rahul', reason: 'Too short.', defects: ['BUG-7'] }, /20 characters/],
    [{ name: 'rahul', reason: 'Refund fix ships next week; low volume.', defects: [] }, /Jira bug/],
    [{ name: 'rahul', reason: 'Refund fix ships next week; low volume.', defects: ['bug7'] }, /"bug7" is not a Jira key/],
  ];
  for (const [extra, message] of refusals) {
    const r = await post(get, { ...base, ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.match((await r.json()).error, message);
  }
  assert.equal(verdicts(s).length, 0, 'nothing recorded by a refusal');

  const ok = await post(get, { ...base, name: 'rahul', reason: 'Refund fix ships next week; low volume.', defects: ['BUG-7'] });
  assert.equal(ok.status, 200, await ok.clone().text());
  const v = await ok.json();
  assert.equal(v.decided.headline, 'Shipped anyway');
  assert.deepEqual(v.decided.defects, ['BUG-7']);
  assert.equal(verdicts(s)[0].provenance.approvedBy, 'rahul');
  assert.deepEqual((verdicts(s)[0].content.override as any).defects, ['BUG-7']);
});

test("Ship and Ship anyway are refused on Can't tell yet; Hold works, with a default note", async (t) => {
  const s = seedReleases();
  const get = await serve(s, t);
  const base = { release: 'shop-1.6', changed: ['QA-1', 'QA-3'], name: 'rahul' };
  const anyway = await post(get, { ...base, action: 'ship_anyway', reason: 'We have to ship this one today.', defects: ['BUG-7'] });
  assert.equal(anyway.status, 409);
  assert.match((await anyway.json()).error, /Can't tell yet.*cannot be shipped anyway/);
  const ship = await post(get, { ...base, action: 'ship' });
  assert.equal(ship.status, 409);
  assert.equal(verdicts(s).length, 0);
  const hold = await post(get, { ...base, action: 'hold' });
  assert.equal(hold.status, 200);
  const v = await hold.json();
  assert.equal(v.decided.headline, 'Not ready');
  assert.match(v.decided.reason, /Held by rahul/);
});

test('Ship on Not ready is refused, and so is a decision the evidence moved past', async (t) => {
  const s = seedReleases();
  const get = await serve(s, t);
  const ship = await post(get, { release: 'shop-1.5', changed: ['QA-1', 'QA-2'], action: 'ship', name: 'rahul' });
  assert.equal(ship.status, 409);
  assert.match((await ship.json()).error, /Ship is only for Ready to ship.*Not ready/);
  // The page was loaded when QA-2 failed; the fix lands before the click.
  ingestJunit(s, { reports: [{ file: 'r.xml', xml: '<testsuite><testcase classname="refunds" name="QA-2 refund posts next day"/></testsuite>' }], runRef: 'ci/2' });
  const second = s.record({ type: 'test_run', content: { status: 'passed' }, provenance: { ...human, approvedBy: 'priya' }, links: [{ to: s.list('test_case').find((c) => c.content.name === 'refund posts next day')!.id, relation: 'verifies' }] });
  assert.ok(second);
  const late = await post(get, { release: 'shop-1.5', changed: ['QA-1', 'QA-2'], action: 'ship_anyway', name: 'rahul', reason: 'Refund fix ships next week; low volume.', defects: ['BUG-7'] });
  assert.equal(late.status, 409, 'Ready now, so Ship anyway no longer applies');
  assert.match((await late.json()).error, /now Ready to ship/);
});

test('a reason with internal ids in it is refused in plain words', async (t) => {
  const s = seedReleases();
  const get = await serve(s, t);
  const r = await post(get, { release: 'shop-1.5', changed: ['QA-1', 'QA-2'], action: 'ship_anyway', name: 'rahul', reason: 'Overriding test_run_1a2b3c4d for the deadline.', defects: ['BUG-7'] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /plain language/);
});
