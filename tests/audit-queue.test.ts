import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceStore } from '../src/trace/store.ts';

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
