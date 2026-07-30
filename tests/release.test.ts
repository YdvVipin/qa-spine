import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceStore } from '../src/trace/store.ts';
import { assessReleaseRisk, recordVerdict } from '../src/release.ts';

const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-opus-5', promptVersion: 'ambiguity/1' };

test('bySourceRef returns artifacts matching the given refs', () => {
  const store = new TraceStore(':memory:');
  const req = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-42',
    content: { text: 'Refunds must be processed quickly.' },
    provenance: human,
  });
  store.record({
    type: 'requirement',
    sourceRef: 'PROJ-99',
    content: { text: 'Unrelated requirement.' },
    provenance: human,
  });

  const found = store.bySourceRef(['PROJ-42', 'src/never-seen.ts']);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, req.id);
});

test('bySourceRef returns [] for an empty ref list instead of throwing', () => {
  const store = new TraceStore(':memory:');
  // `IN ()` is a SQLite syntax error, so the guard is load-bearing.
  assert.deepEqual(store.bySourceRef([]), []);
});

/** The seed-demo shape: one requirement, one resolved finding, one open finding, a failing run. */
function seedRelease(store: TraceStore) {
  const req = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-42',
    content: { text: 'Refunds must be processed quickly and the customer notified appropriately.' },
    provenance: human,
  });
  const resolved = store.record({
    type: 'finding',
    sourceRef: 'PROJ-42',
    content: { category: 'AMB-VAGUE-QUANT', quote: 'quickly', question: 'How quick?', confidence: 'high' },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });
  const open = store.record({
    type: 'finding',
    sourceRef: 'PROJ-42',
    content: {
      category: 'AMB-UNTESTABLE',
      quote: 'notified appropriately',
      question: 'What happens when notification delivery fails?',
      confidence: 'unknown',
    },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });
  const testCase = store.record({
    type: 'test_case',
    sourceRef: 'tests/refund.spec.ts:14',
    content: { name: 'refund completes and emails the customer' },
    provenance: human,
    links: [
      { to: req.id, relation: 'covers' },
      { to: resolved.id, relation: 'supersedes' },
    ],
  });
  const run = store.record({
    type: 'test_run',
    sourceRef: 'ci/run/8812',
    content: { status: 'failed', message: 'timed out waiting for notification' },
    provenance: human,
    links: [{ to: testCase.id, relation: 'verifies' }],
  });
  return { req, resolved, open, testCase, run };
}

test('assessReleaseRisk signals an unresolved finding on a changed requirement', () => {
  const store = new TraceStore(':memory:');
  const { req, open } = seedRelease(store);

  const { signals } = assessReleaseRisk(store, { changed: ['PROJ-42'] });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, 'unresolved_finding_on_changed_area');
  assert.equal(signals[0].detail.findingId, open.id);
  assert.equal(signals[0].detail.requirementId, req.id);
  assert.equal(signals[0].detail.category, 'AMB-UNTESTABLE');
  assert.deepEqual(signals[0].artifacts, [open.id, req.id]);
});

test('assessReleaseRisk ignores a finding something has superseded', () => {
  const store = new TraceStore(':memory:');
  const { resolved } = seedRelease(store);

  const { signals } = assessReleaseRisk(store, { changed: ['PROJ-42'] });
  assert.ok(!signals.some((s) => s.detail.findingId === resolved.id));
});

test('assessReleaseRisk ignores an unresolved finding on a requirement that did not change', () => {
  const store = new TraceStore(':memory:');
  seedRelease(store);

  const { signals } = assessReleaseRisk(store, { changed: ['PROJ-99'] });
  assert.deepEqual(signals, []);
});

test('assessReleaseRisk reports refs that matched no artifact', () => {
  const store = new TraceStore(':memory:');
  seedRelease(store);

  const { matched } = assessReleaseRisk(store, { changed: ['PROJ-42', 'src/refund.ts'] });
  assert.deepEqual(matched.unmatched, ['src/refund.ts']);
  assert.equal(matched.requirements.length, 1);
});

test('assessReleaseRisk context includes the failing run reachable from a changed area', () => {
  const store = new TraceStore(':memory:');
  const { run } = seedRelease(store);

  const { context } = assessReleaseRisk(store, { changed: ['PROJ-42'] });
  const found = context.nodes.find((n) => n.id === run.id);
  assert.ok(found, 'failing test_run should arrive as unscored context');
  assert.equal(found.content.status, 'failed');
});

test('assessReleaseRisk rejects an empty changed list', () => {
  const store = new TraceStore(':memory:');
  assert.throws(() => assessReleaseRisk(store, { changed: [] }), /changed must not be empty/);
});

test('assessReleaseRisk deduplicates context nodes and edges from overlapping chains', () => {
  const store = new TraceStore(':memory:');
  seedRelease(store);

  // seedRelease creates req, resolved, and open, all with sourceRef: 'PROJ-42'.
  // bySourceRef returns all three; chain() is called on each, producing overlapping results.
  // This test ensures the Map-based dedup removes duplicates.
  const { context } = assessReleaseRisk(store, { changed: ['PROJ-42'] });

  // Every artifact id should appear exactly once in context.nodes.
  const nodeIds = context.nodes.map((n) => n.id);
  const uniqueNodeIds = new Set(nodeIds);
  assert.equal(nodeIds.length, uniqueNodeIds.size, 'context.nodes should have no duplicate artifact ids');

  // Every (from, to, relation) edge triple should appear exactly once.
  const edgeTriples = context.edges.map((e) => `${e.fromArtifactId}>${e.toArtifactId}:${e.relation}`);
  const uniqueEdgeTriples = new Set(edgeTriples);
  assert.equal(edgeTriples.length, uniqueEdgeTriples.size, 'context.edges should have no duplicate (from, to, relation) triples');
});

test('recordVerdict records a hold with a derived_from edge to every cited artifact', () => {
  const store = new TraceStore(':memory:');
  const { req, open } = seedRelease(store);

  const verdict = recordVerdict(store, {
    releaseRef: 'release/2026.7.3',
    verdict: 'hold',
    reason: 'PROJ-42 notification failure was flagged at requirement stage and never resolved.',
    cites: [open.id, req.id],
    changed: ['PROJ-42'],
    provenance: ai,
  });

  assert.equal(verdict.type, 'verdict');
  assert.equal(verdict.sourceRef, 'release/2026.7.3');
  assert.equal(verdict.content.verdict, 'hold');
  assert.deepEqual(verdict.content.changed, ['PROJ-42']);
  assert.equal(verdict.content.override, null);

  const edges = store.edgesFrom(verdict.id);
  const targets = edges.map((e) => e.toArtifactId).sort();
  assert.deepEqual(targets, [open.id, req.id].sort());
  for (const e of edges) {
    assert.equal(e.relation, 'derived_from');
  }
});

test('recordVerdict rejects a blank reason and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'hold', reason: '   ',
      cites: [open.id], changed: ['PROJ-42'], provenance: ai,
    }),
    /reason must not be blank/,
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict rejects an unknown cited artifact and writes nothing', () => {
  const store = new TraceStore(':memory:');
  seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'hold', reason: 'because',
      cites: ['finding_deadbeef'], changed: ['PROJ-42'], provenance: ai,
    }),
    /cites unknown artifact finding_deadbeef/,
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict refuses to ship while a signal is live, and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'ship', reason: 'looks fine to me',
      cites: [open.id], changed: ['PROJ-42'], provenance: ai,
    }),
    new RegExp(`cannot ship: 1 unresolved finding\\(s\\).*${open.id}`),
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict allows a ship with an override and records the reason', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);

  const verdict = recordVerdict(store, {
    releaseRef: 'release/1',
    verdict: 'ship',
    reason: 'Hotfix. The open question is cosmetic and tracked separately.',
    cites: [open.id],
    changed: ['PROJ-42'],
    override: { reason: 'hotfix, accepted by release manager' },
    provenance: ai,
  });

  assert.equal(verdict.content.verdict, 'ship');
  assert.deepEqual(verdict.content.override, { reason: 'hotfix, accepted by release manager' });
});

test('recordVerdict rejects an override supplied with a hold verdict', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'hold', reason: 'holding',
      cites: [open.id], changed: ['PROJ-42'],
      override: { reason: 'pointless here' }, provenance: ai,
    }),
    /override is only meaningful with a ship verdict/,
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict allows a ship when no signal is live', () => {
  const store = new TraceStore(':memory:');
  const { req, open } = seedRelease(store);
  store.record({
    type: 'answer',
    content: { text: 'Retry twice, then raise a defect and alert on-call.' },
    provenance: human,
    links: [
      { to: open.id, relation: 'supersedes' },
      { to: req.id, relation: 'derived_from' },
    ],
  });

  const verdict = recordVerdict(store, {
    releaseRef: 'release/1', verdict: 'ship', reason: 'All requirement questions answered.',
    cites: [req.id], changed: ['PROJ-42'], provenance: ai,
  });
  assert.equal(verdict.content.verdict, 'ship');
});

test('recordVerdict preserves AI provenance and does not override promptVersion', () => {
  const store = new TraceStore(':memory:');
  const { req, open } = seedRelease(store);

  const verdict = recordVerdict(store, {
    releaseRef: 'release/1', verdict: 'hold', reason: 'holding',
    cites: [open.id, req.id], changed: ['PROJ-42'],
    provenance: { producer: 'ai', model: 'claude-opus-5', promptVersion: 'release-brief/7' },
  });

  assert.equal(verdict.provenance.model, 'claude-opus-5');
  assert.equal(verdict.provenance.promptVersion, 'release-brief/7');
});

test('recordVerdict deduplicates cites so a repeated id is not an edge conflict', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);

  const verdict = recordVerdict(store, {
    releaseRef: 'release/1', verdict: 'hold', reason: 'holding',
    cites: [open.id, open.id], changed: ['PROJ-42'], provenance: ai,
  });
  assert.equal(store.edgesFrom(verdict.id).length, 1);
});

test('recordVerdict normalizes padded changed refs and signals persists', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'ship', reason: 'looks fine',
      cites: [open.id], changed: ['  PROJ-42\n'], provenance: ai,
    }),
    /cannot ship: 1 unresolved finding\(s\)/,
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict stores unmatched refs in verdict content', () => {
  const store = new TraceStore(':memory:');
  const { req } = seedRelease(store);

  const verdict = recordVerdict(store, {
    releaseRef: 'release/1', verdict: 'hold', reason: 'unmatched refs',
    cites: [req.id], changed: ['PROJ-42', 'src/missing.ts'], provenance: ai,
  });

  assert.deepEqual(verdict.content.unmatched, ['src/missing.ts']);
});

test('recordVerdict rejects invalid verdict and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'SHIP' as any, reason: 'uppercase',
      cites: [open.id], changed: ['PROJ-42'], provenance: ai,
    }),
    /verdict must be 'ship' or 'hold'/,
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict rejects blank releaseRef and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: '   ', verdict: 'hold', reason: 'holding',
      cites: [open.id], changed: ['PROJ-42'], provenance: ai,
    }),
    /releaseRef must not be blank/,
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict rejects blank override.reason and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'ship', reason: 'shipping anyway',
      cites: [open.id], changed: ['PROJ-42'],
      override: { reason: '   ' }, provenance: ai,
    }),
    /override.reason must not be blank/,
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});
