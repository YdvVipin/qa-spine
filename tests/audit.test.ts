import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRubric, auditRequirement, submitFindings, type AuditFinding } from '../src/audit.ts';
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

const ai = { producer: 'ai' as const, model: 'claude-opus-5', promptVersion: 'caller-supplied' };

const vagueFinding = (over: Partial<AuditFinding> = {}): AuditFinding => ({
  category: 'AMB-VAGUE-QUANT',
  quote: 'load quickly',
  question: 'What p95 load time counts as "quickly", and on what connection?',
  confidence: 'high',
  ...over,
});

const countArtifacts = (store: TraceStore) => store.list(undefined, 1e9).length;

test('audit_submit records findings linked back to the requirement', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);

  const written = submitFindings(store, {
    requirementId: req.id,
    findings: [vagueFinding(), vagueFinding({ category: 'AMB-MISSING-ACTOR', quote: 'are notified' })],
    provenance: ai,
  });

  assert.equal(written.length, 2);
  assert.equal(written[0].type, 'finding');
  assert.equal(written[0].sourceRef, 'PROJ-114', 'inherits the requirement sourceRef');
  assert.equal(written[0].content.category, 'AMB-VAGUE-QUANT');
  assert.equal(written[0].content.confidence, 'high', 'confidence stays a string');

  const chain = store.chain(req.id);
  assert.ok(chain);
  const ids = chain.nodes.map((n) => n.id);
  assert.ok(written.every((f) => ids.includes(f.id)), 'both findings are in the chain');
  assert.ok(
    chain.edges.some((e) => e.fromArtifactId === written[0].id && e.toArtifactId === req.id && e.relation === 'derived_from'),
  );
});

test('audit_submit stamps promptVersion from the rubric, ignoring the caller', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);

  const [finding] = submitFindings(store, {
    requirementId: req.id,
    findings: [vagueFinding()],
    provenance: ai,
  });

  assert.equal(finding.provenance.promptVersion, 'ambiguity/1');
  assert.equal(finding.provenance.model, 'claude-opus-5', "model is still the caller's");
});

test('audit_submit rejects an unknown rule id and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);
  const before = countArtifacts(store);

  assert.throws(
    () => submitFindings(store, { requirementId: req.id, findings: [vagueFinding({ category: 'AMB-TYPO' })], provenance: ai }),
    /unknown rule "AMB-TYPO"/,
  );
  assert.equal(countArtifacts(store), before, 'store untouched');
});

test('audit_submit rejects a quote absent from the requirement and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);
  const before = countArtifacts(store);

  assert.throws(
    () => submitFindings(store, { requirementId: req.id, findings: [vagueFinding({ quote: 'blazingly fast' })], provenance: ai }),
    /quote not found in requirement text: "blazingly fast"/,
  );
  assert.equal(countArtifacts(store), before, 'store untouched');
});

test('audit_submit is all-or-nothing when one finding of several is invalid', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);
  const before = countArtifacts(store);

  assert.throws(
    () =>
      submitFindings(store, {
        requirementId: req.id,
        findings: [vagueFinding(), vagueFinding({ quote: 'never written here' })],
        provenance: ai,
      }),
    /quote not found/,
  );
  assert.equal(countArtifacts(store), before, 'the valid finding was not written either');
});

test('audit_submit rejects an empty findings list', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);

  assert.throws(() => submitFindings(store, { requirementId: req.id, findings: [], provenance: ai }), /must not be empty/);
});

test('audit_submit still enforces the AI provenance rule', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);
  const before = countArtifacts(store);

  assert.throws(
    () =>
      submitFindings(store, {
        requirementId: req.id,
        findings: [vagueFinding()],
        // producer 'ai' with no model. This type-checks — `model` is optional on the object —
        // and is rejected at runtime by the refinement in schema.ts. No cast needed.
        provenance: { producer: 'ai' },
      }),
    /model and promptVersion/,
  );
  assert.equal(countArtifacts(store), before);
});

test('audit_submit rejects a finding with an invalid confidence enum', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);

  // Cast to bypass TypeScript's type check — we're testing runtime validation.
  const invalidFinding = vagueFinding({ confidence: 'ABSOLUTELY' }) as any;

  assert.throws(
    () => submitFindings(store, { requirementId: req.id, findings: [invalidFinding], provenance: ai }),
    /Invalid option/,
  );
});

test('audit_submit strips unknown keys like suggestedRewrite from recorded findings', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);

  // Cast to bypass TypeScript's type check — we're testing runtime stripping.
  const findingWithExtra = vagueFinding({ suggestedRewrite: 'within 3 business days' }) as any;

  const written = submitFindings(store, { requirementId: req.id, findings: [findingWithExtra], provenance: ai });

  assert.equal(written.length, 1);
  assert.ok(!('suggestedRewrite' in written[0].content), 'suggestedRewrite was stripped from content');
  assert.ok(written[0].content.category === 'AMB-VAGUE-QUANT', 'valid fields are preserved');
  assert.ok(written[0].content.quote === 'load quickly', 'quote is preserved');
});
