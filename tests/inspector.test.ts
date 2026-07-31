import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { TraceStore } from '../src/trace/store.ts';
import { createInspector } from '../src/inspector/server.ts';
import { reviewExport } from '../src/server.ts';

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
