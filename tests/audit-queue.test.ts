import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { TraceStore } from '../src/trace/store.ts';
import { openQuestions, recordAnswer } from '../src/audit.ts';
import { createInspector } from '../src/inspector/server.ts';

const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-opus-5', promptVersion: 'ambiguity/1' };

/** A requirement with one AI finding hanging off it — the shape phase 2 produces. */
function seed(store: TraceStore) {
  const req = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-114',
    content: { text: 'The dashboard should load quickly for all users.' },
    provenance: human,
  });
  const finding = store.record({
    type: 'finding',
    sourceRef: 'PROJ-114',
    content: {
      category: 'AMB-VAGUE-QUANT',
      quote: 'load quickly',
      question: 'What p95 counts as quickly?',
      confidence: 'high',
    },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });
  return { req, finding };
}

test('openFindings returns a finding nothing has superseded', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);

  const open = store.openFindings();
  assert.equal(open.length, 1);
  assert.equal(open[0].id, finding.id);
});

test('openFindings excludes a finding once something supersedes it', () => {
  const store = new TraceStore(':memory:');
  const { req, finding } = seed(store);

  store.record({
    type: 'answer',
    content: { text: 'p95 under 1.5s on 3G Fast.' },
    provenance: human,
    links: [
      { to: finding.id, relation: 'supersedes' },
      { to: req.id, relation: 'derived_from' },
    ],
  });

  assert.deepEqual(store.openFindings(), []);
});

test('openFindings ignores non-findings and non-supersedes edges', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);

  // A review points at the finding, but reviewing is not resolving.
  store.record({
    type: 'review',
    content: { verdict: 'good', note: '' },
    provenance: human,
    links: [{ to: finding.id, relation: 'reviews' }],
  });

  const open = store.openFindings();
  assert.equal(open.length, 1, 'a review must not retire a finding');
  assert.equal(open[0].id, finding.id);
  assert.ok(open.every((a) => a.type === 'finding'), 'only findings are ever returned');
});

test('edgesTo finds incoming edges that edgesFrom cannot see', () => {
  const store = new TraceStore(':memory:');
  const { req, finding } = seed(store);
  const answer = store.record({
    type: 'answer',
    content: { text: 'p95 under 1.5s on 3G Fast.' },
    provenance: human,
    links: [
      { to: finding.id, relation: 'supersedes' },
      { to: req.id, relation: 'derived_from' },
    ],
  });

  const incoming = store.edgesTo(finding.id);
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].fromArtifactId, answer.id);
  assert.equal(incoming[0].relation, 'supersedes');

  // The point of the method: the resolving edge is invisible from the finding's own side.
  assert.deepEqual(
    store.edgesFrom(finding.id).filter((e) => e.relation === 'supersedes'),
    [],
  );
});

test('openQuestions attaches the requirement needed to answer', () => {
  const store = new TraceStore(':memory:');
  const { req, finding } = seed(store);

  const { open } = openQuestions(store);
  assert.equal(open.length, 1);
  assert.equal(open[0].findingId, finding.id);
  assert.equal(open[0].category, 'AMB-VAGUE-QUANT');
  assert.equal(open[0].quote, 'load quickly');
  assert.equal(open[0].question, 'What p95 counts as quickly?');
  assert.equal(open[0].confidence, 'high');
  assert.equal(open[0].requirement?.id, req.id);
  assert.equal(open[0].requirement?.sourceRef, 'PROJ-114');
  assert.match(open[0].requirement?.text ?? '', /load quickly/);
});

test('openQuestions filtered by requirementId excludes other requirements', () => {
  const store = new TraceStore(':memory:');
  const { req } = seed(store);

  const other = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-200',
    content: { text: 'Exports must be timely.' },
    provenance: human,
  });
  store.record({
    type: 'finding',
    content: {
      category: 'AMB-VAGUE-QUANT',
      quote: 'timely',
      question: 'How timely?',
      confidence: 'low',
    },
    provenance: ai,
    links: [{ to: other.id, relation: 'derived_from' }],
  });

  assert.equal(openQuestions(store).open.length, 2, 'unfiltered sees both');
  const mine = openQuestions(store, req.id).open;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].requirement?.id, req.id);
});

test('openQuestions(store, reqId) finds an old finding even past the global cap', () => {
  const store = new TraceStore(':memory:');
  const { req, finding } = seed(store);

  const other = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-999',
    content: { text: 'Exports must be timely.' },
    provenance: human,
  });
  // Push the SQL-level cap's worth of newer findings onto a different requirement. Under
  // the old JS-filter bug, openFindings() would return only these 500 (the most recent),
  // pushing `finding` — older, and on a different requirement — out of the window before
  // the requirement filter ever ran.
  for (let i = 0; i < 500; i++) {
    store.record({
      type: 'finding',
      content: {
        category: 'AMB-VAGUE-QUANT',
        quote: `timely-${i}`,
        question: `How timely (${i})?`,
        confidence: 'low',
      },
      provenance: ai,
      links: [{ to: other.id, relation: 'derived_from' }],
    });
  }

  const mine = openQuestions(store, req.id).open;
  assert.equal(mine.length, 1, 'the per-requirement query must not be capped by the global window');
  assert.equal(mine[0].findingId, finding.id);
});

test('openQuestions filtering still excludes a parentless finding, though the unfiltered list keeps it', () => {
  const store = new TraceStore(':memory:');
  const { req } = seed(store);
  const orphan = store.record({
    type: 'finding',
    content: {
      category: 'AMB-UNTESTABLE',
      quote: 'somehow',
      question: 'Observable how?',
      confidence: 'unknown',
    },
    provenance: ai,
  });

  const unfiltered = openQuestions(store).open;
  assert.ok(
    unfiltered.some((q) => q.findingId === orphan.id),
    'a broken edge must not hide work from the unfiltered queue',
  );

  const filtered = openQuestions(store, req.id).open;
  assert.ok(
    !filtered.some((q) => q.findingId === orphan.id),
    'a finding with no requirement edge cannot match any requirement filter',
  );
});

test('openQuestions keeps a parentless finding, with requirement null', () => {
  const store = new TraceStore(':memory:');
  const orphan = store.record({
    type: 'finding',
    content: {
      category: 'AMB-UNTESTABLE',
      quote: 'somehow',
      question: 'Observable how?',
      confidence: 'unknown',
    },
    provenance: ai,
  });

  const { open } = openQuestions(store);
  assert.equal(open.length, 1, 'a broken edge must not hide work');
  assert.equal(open[0].findingId, orphan.id);
  assert.equal(open[0].requirement, null);
});

const countArtifacts = (store: TraceStore) => store.list(undefined, 1e9).length;

/** Boots the inspector on an ephemeral port and hands back a fetch bound to it. */
async function serve(store: TraceStore, t: TestContext) {
  const server = createInspector(store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return (path: string, init?: RequestInit) => fetch(base + path, init);
}

const postAnswer = (api: (p: string, i?: RequestInit) => Promise<Response>, body: unknown) =>
  api('/api/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('GET /api/open lists the queue and shrinks when a question is answered', async (t) => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const api = await serve(store, t);

  const before = await (await api('/api/open')).json();
  assert.equal(before.open.length, 1);
  assert.equal(before.open[0].findingId, finding.id);

  const res = await postAnswer(api, { findingId: finding.id, answer: 'Under 1.5s.' });
  assert.equal(res.status, 200);

  const after = await (await api('/api/open')).json();
  assert.deepEqual(after.open, [], 'answering removes it from the queue');
});

test('POST /api/answer always records human provenance, whatever the body claims', async (t) => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const api = await serve(store, t);

  const res = await postAnswer(api, {
    findingId: finding.id,
    answer: 'Under 1.5s.',
    // The Inspector must ignore this: its writes are human by definition.
    provenance: { producer: 'ai', model: 'sneaky', promptVersion: 'x' },
  });

  const answer = await res.json();
  assert.equal(answer.provenance.producer, 'human');
  assert.equal(answer.provenance.model, undefined);
});

test('POST /api/answer rejects a blank answer with 400 and writes nothing', async (t) => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const api = await serve(store, t);
  const before = countArtifacts(store);

  const res = await postAnswer(api, { findingId: finding.id, answer: '  ' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /answer must not be blank/);
  assert.equal(countArtifacts(store), before, 'store untouched');
});

test('recordAnswer links to both the finding and the requirement, and closes the question', () => {
  const store = new TraceStore(':memory:');
  const { req, finding } = seed(store);

  const answer = recordAnswer(store, {
    findingId: finding.id,
    answer: 'p95 under 1.5s on 3G Fast, at first contentful paint.',
    provenance: human,
  });

  assert.equal(answer.type, 'answer');
  assert.equal(answer.content.text, 'p95 under 1.5s on 3G Fast, at first contentful paint.');
  assert.equal(answer.sourceRef, 'PROJ-114');

  const edges = store.edgesFrom(answer.id);
  assert.ok(
    edges.some((e) => e.toArtifactId === finding.id && e.relation === 'supersedes'),
    'supersedes the finding',
  );
  assert.ok(
    edges.some((e) => e.toArtifactId === req.id && e.relation === 'derived_from'),
    'derived from the requirement',
  );
  assert.deepEqual(openQuestions(store).open, [], 'the question leaves the queue');
});

test('an answered finding reads as resolved through chain()', () => {
  const store = new TraceStore(':memory:');
  const { req, finding } = seed(store);
  recordAnswer(store, { findingId: finding.id, answer: 'Under 1.5s.', provenance: human });

  const chain = store.chain(req.id);
  assert.ok(chain);
  // This is exactly the test the chain view runs to decide whether to render a finding red.
  const stillUnresolved = !chain.edges.some(
    (e) => e.toArtifactId === finding.id && e.relation === 'supersedes',
  );
  assert.equal(stillUnresolved, false, 'the chain view will now render it resolved');
});

test('recordAnswer rejects a blank or whitespace-only answer and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const before = countArtifacts(store);

  assert.throws(
    () => recordAnswer(store, { findingId: finding.id, answer: '', provenance: human }),
    /answer must not be blank/,
  );
  assert.throws(
    () => recordAnswer(store, { findingId: finding.id, answer: '   \n ', provenance: human }),
    /answer must not be blank/,
  );
  assert.equal(countArtifacts(store), before, 'store untouched');
});

test('recordAnswer rejects an id that is not a finding, and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const { req } = seed(store);
  const before = countArtifacts(store);

  assert.throws(
    () => recordAnswer(store, { findingId: req.id, answer: 'Under 1.5s.', provenance: human }),
    /is a requirement, not a finding/,
  );
  assert.throws(
    () => recordAnswer(store, { findingId: 'nope_123', answer: 'Under 1.5s.', provenance: human }),
    /no artifact with id nope_123/,
  );
  assert.equal(countArtifacts(store), before, 'store untouched');
});

test('recordAnswer refuses to double-answer, naming the answer to supersede', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const first = recordAnswer(store, {
    findingId: finding.id,
    answer: 'Under 1.5s.',
    provenance: human,
  });
  const before = countArtifacts(store);

  assert.throws(
    () => recordAnswer(store, { findingId: finding.id, answer: 'Actually 2s.', provenance: human }),
    new RegExp(`already resolved by ${first.id}`),
  );
  assert.equal(countArtifacts(store), before, 'store untouched');
});

test('recordAnswer keeps AI provenance exactly as given', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);

  const answer = recordAnswer(store, {
    findingId: finding.id,
    answer: 'p95 under 1.5s.',
    provenance: { producer: 'ai', model: 'claude-opus-5', promptVersion: 'answer/1' },
  });

  assert.equal(answer.provenance.producer, 'ai');
  assert.equal(answer.provenance.model, 'claude-opus-5');
  // Unlike audit_submit, the server does not own an answer and must not restamp this.
  assert.equal(answer.provenance.promptVersion, 'answer/1');
});
