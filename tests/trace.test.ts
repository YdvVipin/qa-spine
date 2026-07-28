import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceStore } from '../src/trace/store.ts';

const store = () => new TraceStore(':memory:');
const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-opus-5', promptVersion: 'sha256:abc123' };

/** The Phase 1 exit criterion: requirement -> finding -> test -> run -> verdict, traced end to end. */
function fullChain(s: TraceStore) {
  const req = s.record({
    type: 'requirement',
    sourceRef: 'PROJ-1',
    content: { text: 'Checkout must be fast.' },
    provenance: human,
  });
  const finding = s.record({
    type: 'finding',
    content: { category: 'vague_qualifier', quote: 'fast', confidence: 'high' },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });
  const testCase = s.record({
    type: 'test_case',
    sourceRef: 'tests/checkout.spec.ts',
    content: { name: 'checkout completes under 2s' },
    provenance: human,
    links: [{ to: req.id, relation: 'covers' }],
  });
  const run = s.record({
    type: 'test_run',
    content: { status: 'failed', durationMs: 4100 },
    provenance: human,
    links: [{ to: testCase.id, relation: 'verifies' }],
  });
  const verdict = s.record({
    type: 'verdict',
    content: { verdict: 'hold', reason: 'unresolved ambiguity in a changed area' },
    provenance: ai,
    links: [{ to: run.id, relation: 'derived_from' }],
  });
  return { req, finding, testCase, run, verdict };
}

test('a verdict traces upstream all the way to the requirement', () => {
  const s = store();
  const { req, testCase, run, verdict } = fullChain(s);

  const chain = s.chain(verdict.id)!;
  assert.deepEqual(chain.upstream.sort(), [req.id, run.id, testCase.id].sort());
  assert.equal(chain.downstream.length, 0);
});

test('a requirement traces downstream to the verdict, and the finding comes with it', () => {
  const s = store();
  const { req, finding, verdict } = fullChain(s);

  const chain = s.chain(req.id)!;
  assert.ok(chain.downstream.includes(verdict.id));
  assert.ok(chain.downstream.includes(finding.id), 'the unresolved finding is reachable from the requirement');
  assert.equal(chain.edges.length, 4);
});

test('provenance survives every hop', () => {
  const s = store();
  const { verdict } = fullChain(s);

  for (const node of s.chain(verdict.id)!.nodes) {
    assert.ok(node.provenance.producer);
    if (node.provenance.producer === 'ai') {
      assert.equal(node.provenance.model, 'claude-opus-5');
      assert.equal(node.provenance.promptVersion, 'sha256:abc123');
    }
  }
});

test('AI artifacts cannot be recorded without model and promptVersion', () => {
  const s = store();
  assert.throws(
    () => s.record({ type: 'finding', content: {}, provenance: { producer: 'ai' } }),
    /model and promptVersion/,
  );
});

test('the store is append-only, enforced below this module', () => {
  const s = store();
  const { req } = fullChain(s);
  const db = (s as unknown as { db: { exec(sql: string): void } }).db;

  assert.throws(() => db.exec(`DELETE FROM artifacts WHERE id = '${req.id}'`), /append-only/);
  assert.throws(() => db.exec(`UPDATE artifacts SET content = '{}' WHERE id = '${req.id}'`), /append-only/);
  assert.throws(() => db.exec('DELETE FROM edges'), /append-only/);
});

test('supersession is an edge, not an overwrite', () => {
  const s = store();
  const v1 = s.record({ type: 'verdict', content: { verdict: 'ship' }, provenance: human });
  const v2 = s.record({
    type: 'verdict',
    content: { verdict: 'hold' },
    provenance: human,
    links: [{ to: v1.id, relation: 'supersedes' }],
  });

  assert.deepEqual(s.get(v1.id)!.content, { verdict: 'ship' }, 'the original is still readable');
  assert.deepEqual(s.chain(v2.id)!.upstream, [v1.id]);
});

test('linking to a nonexistent artifact fails, and takes the artifact down with it', () => {
  const s = store();
  assert.throws(
    () =>
      s.record({
        type: 'finding',
        content: {},
        provenance: human,
        links: [{ to: 'requirement_deadbeef', relation: 'derived_from' }],
      }),
    /does not exist/,
  );
  assert.equal(s.list().length, 0, 'the rolled-back artifact left no orphan');
});

test('unknown artifact ids return undefined rather than an empty chain', () => {
  assert.equal(store().chain('requirement_nope'), undefined);
});
