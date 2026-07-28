import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRubric } from '../src/audit.ts';
import { ArtifactType } from '../src/trace/schema.ts';

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
