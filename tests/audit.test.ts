import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRubric, auditRequirement } from '../src/audit.ts';
import { ArtifactType } from '../src/trace/schema.ts';
import { TraceStore } from '../src/trace/store.ts';

test('the shipped ambiguity rubric loads and validates', () => {
  const rubric = loadRubric();
  assert.equal(rubric.version, 'ambiguity/1');
  assert.ok(rubric.rules.length >= 4, 'ships at least four rules');

  const ids = rubric.rules.map((r) => r.id);
  assert.ok(ids.includes('AMB-VAGUE-QUANT'));
  assert.equal(new Set(ids).size, ids.length, 'rule ids are unique');
  for (const rule of rubric.rules) {
    assert.ok(rule.ask.length > 0, `${rule.id} has a question to ask`);
  }
});

test('a missing rubric fails with the path it looked in', () => {
  assert.throws(() => loadRubric('no-such-rubric'), /no-such-rubric/);
});

test('answer is a recordable artifact type', () => {
  assert.equal(ArtifactType.parse('answer'), 'answer');
});

const REQ_TEXT = 'The dashboard should load quickly, and users are notified when it fails.';

function seedRequirement(store: TraceStore) {
  return store.record({
    type: 'requirement',
    sourceRef: 'PROJ-114',
    content: { text: REQ_TEXT },
    provenance: { producer: 'human' },
  });
}

test('audit_requirement returns the requirement text and the rubric', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);

  const result = auditRequirement(store, req.id);

  assert.equal(result.requirement.id, req.id);
  assert.equal(result.requirement.sourceRef, 'PROJ-114');
  assert.equal(result.requirement.text, REQ_TEXT);
  assert.equal(result.rubric.version, 'ambiguity/1');
  assert.match(result.instructions, /verbatim/i, 'tells the model the quote is checked');
});

test('audit_requirement rejects an unknown id', () => {
  const store = new TraceStore(':memory:');
  assert.throws(() => auditRequirement(store, 'nope_123'), /no artifact with id nope_123/);
});

test('audit_requirement rejects an artifact that is not a requirement', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);
  const finding = store.record({
    type: 'finding',
    content: { category: 'vague_qualifier', quote: 'quickly', confidence: 'high' },
    provenance: { producer: 'ai', model: 'claude-opus-5', promptVersion: 'ambiguity/1' },
    links: [{ to: req.id, relation: 'derived_from' }],
  });

  assert.throws(() => auditRequirement(store, finding.id), /is a finding, not a requirement/);
});

test('audit_requirement rejects a requirement with no text', () => {
  const store = new TraceStore(':memory:');
  const empty = store.record({
    type: 'requirement',
    content: { note: 'no text field here' },
    provenance: { producer: 'human' },
  });

  assert.throws(() => auditRequirement(store, empty.id), /has no content\.text to audit/);
});
