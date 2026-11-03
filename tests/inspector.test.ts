import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { TraceStore } from '../src/trace/store.ts';
import { createInspector, startInspector } from '../src/inspector/server.ts';
import { reviewExport } from '../src/server.ts';
import { ingestJunit } from '../src/junit.ts';
import { recordRetraction } from '../src/retract.ts';

const ai = { producer: 'ai' as const, model: 'claude-opus-5', promptVersion: 'sha256:abc' };

/** Boots the inspector on an ephemeral port and hands back a fetch bound to it. */
async function serve(store: TraceStore, t: TestContext) {
  const server = createInspector(store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return (path: string, init?: RequestInit) => fetch(base + path, init);
}

function seed(store: TraceStore) {
  const req = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-7',
    content: { text: 'The dashboard must load fast.' },
    provenance: { producer: 'human' },
  });
  const finding = store.record({
    type: 'finding',
    content: { category: 'vague_qualifier', quote: 'fast', confidence: 'high' },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });
  return { req, finding };
}

test('the artifact list renders newest first and filters by type', async (t) => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const api = await serve(store, t);

  const all = await (await api('/api/artifacts')).json();
  assert.equal(all.artifacts.length, 2);
  assert.equal(all.artifacts[0].id, finding.id, 'reverse-chronological');

  const findings = await (await api('/api/artifacts?type=finding')).json();
  assert.deepEqual(
    findings.artifacts.map((a: { id: string }) => a.id),
    [finding.id],
  );

  assert.equal((await api('/api/artifacts?type=nonsense')).status, 400);
});

test('a chain request carries provenance through to the UI', async (t) => {
  const store = new TraceStore(':memory:');
  const { req, finding } = seed(store);
  const api = await serve(store, t);

  const chain = await (await api(`/api/chain/${finding.id}`)).json();
  assert.equal(chain.root.id, finding.id);
  assert.deepEqual(chain.upstream, [req.id]);
  assert.equal(chain.root.provenance.model, 'claude-opus-5');
  assert.equal((await api('/api/chain/finding_nope')).status, 404);
});

test('reviewing is one of two human-authored writes, and it lands as a linked artifact', async (t) => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const api = await serve(store, t);

  const res = await api('/api/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ artifactId: finding.id, verdict: 'bad', note: 'quote is out of context' }),
  });
  assert.equal(res.status, 200);

  const review = store.list('review')[0];
  assert.equal(review.provenance.producer, 'human', 'the one write is human-authored');
  assert.deepEqual(store.edgesFrom(review.id).map((e) => [e.relation, e.toArtifactId]), [
    ['reviews', finding.id],
  ]);
});

test('bad review payloads are rejected rather than stored', async (t) => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const api = await serve(store, t);

  const post = (body: unknown) =>
    api('/api/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  assert.equal((await post({ artifactId: finding.id, verdict: 'meh' })).status, 400);
  assert.equal((await post({ artifactId: 'finding_nope', verdict: 'good' })).status, 404);
  assert.equal(store.list('review').length, 0);
});

test('the UI is served, and nothing outside it is', async (t) => {
  const store = new TraceStore(':memory:');
  const api = await serve(store, t);

  const index = await api('/');
  assert.equal(index.status, 200);
  assert.match(await index.text(), /<title>qa-spine inspector<\/title>/);
  assert.equal((await api('/app.js')).status, 200);
  assert.equal((await api('/style.css')).status, 200);

  for (const path of ['/../package.json', '/..%2fpackage.json', '/trace/store.ts', '/.env']) {
    assert.equal((await api(path)).status, 404, `${path} must not be served`);
  }
});

test('review-export joins each label to the artifact and model that produced it', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  store.record({
    type: 'review',
    content: { verdict: 'bad', note: 'quote is out of context' },
    provenance: { producer: 'human' },
    links: [{ to: finding.id, relation: 'reviews' }],
  });

  const lines = reviewExport(store).split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].verdict, 'bad');
  assert.equal(lines[0].artifactId, finding.id);
  assert.equal(lines[0].model, 'claude-opus-5');
  assert.equal(lines[0].promptVersion, 'sha256:abc');
  assert.deepEqual(lines[0].content, finding.content, 'the judged output travels with the label');
});

test('review-export on an empty store produces nothing, not a blank line', () => {
  assert.equal(reviewExport(new TraceStore(':memory:')), '');
});

/** A one-suite JUnit report; each case is [name, failure message or null]. */
const junit = (...cases: [string, string | null][]) =>
  `<testsuite name="s">${cases
    .map(([name, failure]) =>
      `<testcase classname="refund.spec.ts" name="${name}" time="0.5">${failure === null ? '' : `<failure message="${failure}"/>`}</testcase>`)
    .join('')}</testsuite>`;

test('the runs endpoint joins each run to its test and ticket, newest first', async (t) => {
  const store = new TraceStore(':memory:');
  const { req } = seed(store);
  ingestJunit(store, {
    reports: [{ file: 'a.xml', xml: junit(['PROJ-7 refund completes', null], ['PROJ-7 refund emails', 'expected 1 email, got 0']) }],
    runRef: 'r1',
    commit: 'aaa111',
  });
  const api = await serve(store, t);

  const { rows } = await (await api('/api/runs')).json();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].test, 'PROJ-7 refund emails', 'newest first');
  assert.deepEqual(rows[0].tickets, [{ ref: 'PROJ-7', requirementId: req.id }]);
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].flaky, false);
  assert.equal(rows[0].release, 'r1');
  assert.equal(rows[0].commit, 'aaa111');
  assert.equal(rows[0].message, 'expected 1 email, got 0');
  assert.equal(rows[0].durationSec, 0.5);
  assert.equal(rows[1].test, 'PROJ-7 refund completes');
  assert.equal(rows[1].status, 'passed');
});

test('the runs endpoint marks a run flaky the same way Readiness does', async (t) => {
  const store = new TraceStore(':memory:');
  seed(store);
  // The same test passing and failing in one ingest: one run, worst status, flaky.
  ingestJunit(store, {
    reports: [{ file: 'a.xml', xml: junit(['PROJ-7 refund races', null], ['PROJ-7 refund races', 'timeout']) }],
    runRef: 'r1',
    commit: 'aaa111',
  });
  const api = await serve(store, t);
  let { rows } = await (await api('/api/runs')).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].flaky, true);

  // A later pass on the same commit is still flaky: isFlaky looks at every run of the test.
  ingestJunit(store, { reports: [{ file: 'b.xml', xml: junit(['PROJ-7 refund races', null]) }], runRef: 'r2', commit: 'aaa111' });
  ({ rows } = await (await api('/api/runs')).json());
  assert.equal(rows[0].status, 'passed');
  assert.equal(rows[0].flaky, true);
});

test('the runs endpoint leaves out a withdrawn run, as the artifact list does', async (t) => {
  const store = new TraceStore(':memory:');
  seed(store);
  ingestJunit(store, { reports: [{ file: 'a.xml', xml: junit(['PROJ-7 refund emails', 'wrong env']) }], runRef: 'r1' });
  const [run] = store.list('test_run');
  recordRetraction(store, { id: run.id, by: 'Vipin', reason: 'ran against staging by mistake' });
  const api = await serve(store, t);
  assert.deepEqual(await (await api('/api/runs')).json(), { rows: [] });
});

test('an unkeyed test has no tickets, and an empty store has no runs', async (t) => {
  const store = new TraceStore(':memory:');
  const api = await serve(store, t);
  assert.deepEqual(await (await api('/api/runs')).json(), { rows: [] });

  ingestJunit(store, { reports: [{ file: 'a.xml', xml: junit(['renders the footer', null]) }] });
  const { rows } = await (await api('/api/runs')).json();
  assert.deepEqual(rows[0].tickets, []);
});

test('the runs endpoint takes a limit, and falls back or caps rather than erroring', async (t) => {
  const store = new TraceStore(':memory:');
  ingestJunit(store, { reports: [{ file: 'a.xml', xml: junit(['one', null], ['two', null], ['three', null]) }] });
  const api = await serve(store, t);
  assert.equal((await (await api('/api/runs?limit=1')).json()).rows.length, 1);
  for (const limit of ['0', 'abc', '99999', '-3', '1.5']) {
    const res = await api(`/api/runs?limit=${limit}`);
    assert.equal(res.status, 200, limit);
    assert.equal((await res.json()).rows.length, 3, limit);
  }
});

test('the inspector still listens on loopback only', async (t) => {
  const s = await startInspector(new TraceStore(':memory:'), 0);
  t.after(() => new Promise<void>((r) => s.close(() => r())));
  assert.equal((s.address() as AddressInfo).address, '127.0.0.1');
});

test('the UI ships the runs view', async (t) => {
  const api = await serve(new TraceStore(':memory:'), t);
  const app = await (await api('/app.js')).text();
  assert.ok(app.includes("'#/runs'"), 'app.js routes #/runs');
  assert.ok(app.includes("'/api/runs'"), 'app.js fetches /api/runs');
  assert.ok((await (await api('/style.css')).text()).includes('.run-failed'));
  assert.ok((await (await api('/')).text()).includes('href="#/runs"'));
});
