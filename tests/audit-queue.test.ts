import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceStore } from '../src/trace/store.ts';
import { openQuestions, recordAnswer } from '../src/audit.ts';

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
