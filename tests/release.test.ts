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

/** The seed also holds a failing run, which is its own signal kind; these tests are about findings. */
const findingSignals = (r: ReturnType<typeof assessReleaseRisk>) =>
  r.signals.flatMap((s) => (s.kind === 'unresolved_finding_on_changed_area' ? [s] : []));

test('assessReleaseRisk signals an unresolved finding on a changed requirement', () => {
  const store = new TraceStore(':memory:');
  const { req, open } = seedRelease(store);

  const signals = findingSignals(assessReleaseRisk(store, { changed: ['PROJ-42'] }));
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

  const signals = findingSignals(assessReleaseRisk(store, { changed: ['PROJ-42'] }));
  assert.equal(signals.length, 1);
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

// I5: every existing fixture seeds exactly one open finding, so a mutant that slices
// openFindings down to one result passes 73/73 unnoticed. This seeds a second open finding
// on the same requirement and checks the count, both signals, and both ids in the veto.
test('recordVerdict counts and names every open finding, not just one', () => {
  const store = new TraceStore(':memory:');
  const { req, open } = seedRelease(store);
  const second = store.record({
    type: 'finding',
    sourceRef: 'PROJ-42',
    content: {
      category: 'AMB-VAGUE-QUANT',
      quote: 'processed quickly',
      question: 'What counts as quick enough?',
      confidence: 'low',
    },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });

  const signals = findingSignals(assessReleaseRisk(store, { changed: ['PROJ-42'] }));
  assert.deepEqual(
    signals.map((s) => s.detail.findingId).sort(),
    [open.id, second.id].sort(),
  );

  const before = store.list(undefined, 1e9).length;
  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'ship', reason: 'looks fine to me',
      cites: [open.id], changed: ['PROJ-42'], provenance: ai,
    }),
    (err) => {
      assert.match((err as Error).message, /cannot ship: 2 unresolved finding\(s\)/);
      assert.ok((err as Error).message.includes(open.id));
      assert.ok((err as Error).message.includes(second.id));
      return true;
    },
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict allows a ship with an override and records the reason', () => {
  const store = new TraceStore(':memory:');
  const { open, run } = seedRelease(store);

  const verdict = recordVerdict(store, {
    releaseRef: 'release/1',
    verdict: 'ship',
    reason: 'Hotfix. The open question is cosmetic and tracked separately.',
    cites: [open.id],
    changed: ['PROJ-42'],
    override: { reason: 'hotfix, accepted by release manager' },
    provenance: { ...ai, approvedBy: 'r.mehta' },
  });

  assert.equal(verdict.content.verdict, 'ship');
  assert.deepEqual(verdict.content.override, {
    reason: 'hotfix, accepted by release manager',
    findings: [open.id],
    testRuns: [run.id],
  });
  assert.equal(verdict.provenance.approvedBy, 'r.mehta');
});

test('recordVerdict rejects an override with nobody named as approving it', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1',
      verdict: 'ship',
      reason: 'Hotfix. The open question is cosmetic and tracked separately.',
      cites: [open.id],
      changed: ['PROJ-42'],
      override: { reason: 'hotfix, accepted by release manager' },
      provenance: ai,
    }),
    /approvedBy/,
  );
  assert.equal(store.list(undefined, 1e9).length, before, 'nothing may be recorded');
});

test('a blank approvedBy is refused the same as a missing one', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1',
      verdict: 'ship',
      reason: 'Hotfix. The open question is cosmetic and tracked separately.',
      cites: [open.id],
      changed: ['PROJ-42'],
      override: { reason: 'hotfix, accepted by release manager' },
      provenance: { ...ai, approvedBy: '   ' },
    }),
    /approvedBy/,
  );
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
  const { req, open, testCase } = seedRelease(store);
  // Named: a pass typed in by hand clears a failure only with a person vouching for it.
  store.record({
    type: 'test_run',
    content: { status: 'passed' },
    provenance: { ...human, approvedBy: 'a.rivera' },
    links: [{ to: testCase.id, relation: 'verifies' }],
  });
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
    // I1: sent defensively, as a caller that always includes `override` would. With no live
    // signal, nothing was actually overridden, so it must not be recorded — a stray
    // `override` here would make the Inspector's "⚠ OVERRIDDEN" flag a lie.
    override: { reason: 'just in case' },
  });
  assert.equal(verdict.content.verdict, 'ship');
  assert.equal(verdict.content.override, null);
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

// I5: the throw-only test above never touches a successful write, so a mutant that stores
// `input.changed` unnormalized still passes 73/73. This drives padded, duplicate refs
// through a write that actually succeeds and checks what got recorded.
test('recordVerdict normalizes content.changed on a successful write', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);

  const verdict = recordVerdict(store, {
    releaseRef: 'release/1', verdict: 'hold', reason: 'holding',
    cites: [open.id], changed: ['  PROJ-42\n', 'PROJ-42', ' PROJ-42 '], provenance: ai,
  });

  assert.deepEqual(verdict.content.changed, ['PROJ-42']);
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

test('recordVerdict rejects a reason containing a relation name', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'hold',
      reason: 'The test case was derived_from the ticket and never finished.',
      cites: [open.id], changed: ['PROJ-42'], provenance: ai,
    }),
    /reason contains internal terminology \("derived_from"\)/,
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict rejects a reason containing an internal field name', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'hold',
      reason: 'The sourceRef did not match anything we expected.',
      cites: [open.id], changed: ['PROJ-42'], provenance: ai,
    }),
    /reason contains internal terminology \("sourceRef"\)/,
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict rejects a reason containing an artifact id', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'hold',
      reason: 'We are holding because finding_9f8e2b1c was never answered.',
      cites: [open.id], changed: ['PROJ-42'], provenance: ai,
    }),
    /reason contains internal terminology \("finding_9f8e2b1c"\)/,
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict accepts ordinary English that merely resembles jargon', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);

  // The false-positive guard: each of these is a sentence a person would plausibly
  // write under release pressure. The genuinely risky words (supersedes, covers, verifies,
  // contradicts, reviews) are ordinary English verbs and are deliberately allowed.
  const verdict = recordVerdict(store, {
    releaseRef: 'release/1',
    verdict: 'hold',
    reason:
      'The new test verifies the checkout flow works correctly. ' +
      'The support ticket contradicts what QA found, so we\'re holding. ' +
      'This hotfix supersedes last week\'s patch. ' +
      'This release covers the refund flow and the team reviews every hotfix. ' +
      'Our finding was that the refund requirement was ambiguous, and we could not ' +
      'trace the root cause before the cutoff. This is the spine of the checkout flow.',
    cites: [open.id],
    changed: ['PROJ-42'],
    provenance: ai,
  });
  assert.equal(verdict.content.verdict, 'hold');
});

test('recordVerdict lints override.reason too, since the brief renders it verbatim', () => {
  const store = new TraceStore(':memory:');
  const { req, open } = seedRelease(store);
  store.record({
    type: 'answer',
    content: { text: 'Retry twice, then alert on-call.' },
    provenance: human,
    links: [{ to: open.id, relation: 'supersedes' }, { to: req.id, relation: 'derived_from' }],
  });
  // M5: this was the one lint-rejection test of thirteen without the store-count-unchanged
  // assertion — nothing stopped a mutant that let the throw happen but wrote first anyway.
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'ship', reason: 'Everything is answered.',
      cites: [req.id], changed: ['PROJ-42'],
      override: { reason: 'accepted despite test_case coverage gaps' },
      provenance: ai,
    }),
    /override\.reason contains internal terminology \("test_case"\)/,
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

// M1: [0-9a-f]{8} also matches eight plain digits, so a date-shaped suffix like
// defect_20260731 used to be rejected as though it were a real artifact id — real ids come
// from randomUUID().slice(0,8) and always contain at least one a-f letter.
test('recordVerdict accepts a date-shaped suffix that merely resembles an artifact id', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);

  const verdict = recordVerdict(store, {
    releaseRef: 'release/1', verdict: 'hold',
    reason: 'Related to defect_20260731, reported last week and still under review.',
    cites: [open.id], changed: ['PROJ-42'], provenance: ai,
  });
  assert.equal(verdict.content.verdict, 'hold');
});

// M2: source_ref and prompt_version are literal column/field names an agent sees if it reads
// src/trace/store.ts directly — the denylist covered only the camelCase wire-format twins,
// and plurals of the test_case/test_run terms were also uncovered.
test('recordVerdict rejects the snake_case twins and plurals of denied terms, and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  for (const term of ['source_ref', 'prompt_version', 'test_cases', 'test_runs']) {
    assert.throws(
      () => recordVerdict(store, {
        releaseRef: 'release/1', verdict: 'hold',
        reason: `We are holding because the ${term} did not line up with what we expected.`,
        cites: [open.id], changed: ['PROJ-42'], provenance: ai,
      }),
      new RegExp(`reason contains internal terminology \\("${term}"\\)`),
      `expected "${term}" to be rejected`,
    );
  }
  assert.equal(store.list(undefined, 1e9).length, before);
});

/** A requirement covered by one test, with the given runs recorded oldest first. No findings. */
function seedTested(store: TraceStore, runs: { status: string; commit?: string; flaky?: boolean; message?: string }[]) {
  const req = store.record({ type: 'requirement', sourceRef: 'PROJ-7', content: { text: 'r' }, provenance: human });
  const tc = store.record({
    type: 'test_case',
    sourceRef: 'junit:refunds::emails',
    content: { name: 'emails', classname: 'refunds' },
    provenance: { producer: 'tool', tool: 'qa-spine ingest-junit' },
    links: [{ to: req.id, relation: 'covers' }],
  });
  const runIds = runs.map(
    (content) =>
      store.record({
        type: 'test_run',
        sourceRef: 'ci/1',
        content,
        provenance: { producer: 'tool', tool: 'qa-spine ingest-junit' },
        links: [{ to: tc.id, relation: 'verifies' }],
      }).id,
  );
  return { req, tc, runIds };
}
const testSignals = (r: ReturnType<typeof assessReleaseRisk>) =>
  r.signals.filter((s) => s.kind === 'failing_test_on_changed_area');

test('a failing latest run on a changed requirement is a signal', () => {
  const store = new TraceStore(':memory:');
  const { req, tc, runIds } = seedTested(store, [{ status: 'failed', message: 'no email sent' }]);

  const [signal, ...rest] = testSignals(assessReleaseRisk(store, { changed: ['PROJ-7'] }));
  assert.equal(rest.length, 0);
  assert.deepEqual(signal.artifacts, [runIds[0], tc.id, req.id]);
  assert.equal(signal.detail.status, 'failed');
  assert.equal(signal.detail.name, 'emails');
  assert.equal(signal.detail.message, 'no email sent');
  assert.equal(signal.detail.flaky, false);
});

test('an error latest run is a signal too', () => {
  const store = new TraceStore(':memory:');
  seedTested(store, [{ status: 'error' }]);
  assert.equal(testSignals(assessReleaseRisk(store, { changed: ['PROJ-7'] })).length, 1);
});

test('a later passing run clears an earlier failure', () => {
  const store = new TraceStore(':memory:');
  seedTested(store, [{ status: 'failed' }, { status: 'passed' }]);
  assert.equal(testSignals(assessReleaseRisk(store, { changed: ['PROJ-7'] })).length, 0);
});

test('a later failing run is not cleared by an earlier pass', () => {
  const store = new TraceStore(':memory:');
  seedTested(store, [{ status: 'passed' }, { status: 'failed' }]);
  assert.equal(testSignals(assessReleaseRisk(store, { changed: ['PROJ-7'] })).length, 1);
});

test('a skipped latest run does not block', () => {
  const store = new TraceStore(':memory:');
  seedTested(store, [{ status: 'skipped' }]);
  assert.equal(testSignals(assessReleaseRisk(store, { changed: ['PROJ-7'] })).length, 0);
});

test('a failing test on a requirement that did not change is not a signal', () => {
  const store = new TraceStore(':memory:');
  seedTested(store, [{ status: 'failed' }]);
  assert.equal(testSignals(assessReleaseRisk(store, { changed: ['PROJ-8'] })).length, 0);
});

test('runs that disagree on one commit mark a failing test flaky, and it still blocks', () => {
  const store = new TraceStore(':memory:');
  seedTested(store, [{ status: 'passed', commit: 'c1' }, { status: 'failed', commit: 'c1' }]);
  const result = assessReleaseRisk(store, { changed: ['PROJ-7'] });
  const [signal] = testSignals(result);
  assert.equal(signal.detail.flaky, true);
  assert.equal(result.flaky.length, 1);
});

test('runs that disagree across different commits are not flaky', () => {
  const store = new TraceStore(':memory:');
  seedTested(store, [{ status: 'passed', commit: 'c1' }, { status: 'failed', commit: 'c2' }]);
  const result = assessReleaseRisk(store, { changed: ['PROJ-7'] });
  assert.equal(testSignals(result)[0].detail.flaky, false);
  assert.deepEqual(result.flaky, []);
});

test('a flaky test whose latest run passed is listed as flaky but raises no signal', () => {
  const store = new TraceStore(':memory:');
  const { tc } = seedTested(store, [{ status: 'failed', commit: 'c1' }, { status: 'passed', commit: 'c1' }]);
  const result = assessReleaseRisk(store, { changed: ['PROJ-7'] });
  assert.equal(testSignals(result).length, 0);
  assert.deepEqual(result.flaky.map((f) => [f.testCaseId, f.name]), [[tc.id, 'emails']]);
});

test('a run ingest flagged flaky makes its test flaky', () => {
  const store = new TraceStore(':memory:');
  seedTested(store, [{ status: 'failed', flaky: true }]);
  assert.equal(testSignals(assessReleaseRisk(store, { changed: ['PROJ-7'] }))[0].detail.flaky, true);
});

test('recordVerdict refuses a ship while only a failing test is live, and names it', () => {
  const store = new TraceStore(':memory:');
  const { runIds } = seedTested(store, [{ status: 'failed' }]);
  const before = store.list(undefined, 1e9).length;
  assert.throws(
    () =>
      recordVerdict(store, {
        releaseRef: 'r1', verdict: 'ship', reason: 'Looks fine.', cites: [], changed: ['PROJ-7'], provenance: human,
      }),
    (err) => {
      assert.match((err as Error).message, /cannot ship: 1 failing test\(s\)/);
      assert.ok((err as Error).message.includes(runIds[0]));
      return true;
    },
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict records liveTestRuns on a hold', () => {
  const store = new TraceStore(':memory:');
  const { runIds } = seedTested(store, [{ status: 'failed' }]);
  const v = recordVerdict(store, {
    releaseRef: 'r1', verdict: 'hold', reason: 'A test is failing.', cites: [], changed: ['PROJ-7'], provenance: human,
  });
  assert.deepEqual(v.content.liveTestRuns, [runIds[0]]);
  assert.deepEqual(v.content.liveFindings, []);
});

test('an override of a failing test records the runs it overrode and needs a name', () => {
  const store = new TraceStore(':memory:');
  const { runIds } = seedTested(store, [{ status: 'failed' }]);
  const input = {
    releaseRef: 'r1', verdict: 'ship' as const, reason: 'Hotfix.', cites: [], changed: ['PROJ-7'],
    override: { reason: 'Known flaky email stub, tracked separately.' },
  };
  assert.throws(() => recordVerdict(store, { ...input, provenance: human }), /approvedBy/);
  const v = recordVerdict(store, { ...input, provenance: { ...human, approvedBy: 'a.rivera' } });
  assert.deepEqual(v.content.override, {
    reason: 'Known flaky email stub, tracked separately.',
    findings: [],
    testRuns: [runIds[0]],
  });
});

test('the ship refusal counts a test covering two changed requirements once', () => {
  const store = new TraceStore(':memory:');
  const { tc } = seedTested(store, [{ status: 'failed' }]);
  const other = store.record({ type: 'requirement', sourceRef: 'PROJ-8', content: { text: 'r8' }, provenance: human });
  store.link(tc.id, other.id, 'covers');
  assert.throws(
    () => recordVerdict(store, { releaseRef: 'r', verdict: 'ship', reason: 'Fine.', cites: [], changed: ['PROJ-7', 'PROJ-8'], provenance: human }),
    /cannot ship: 1 failing test\(s\)/,
  );
});

/** PROJ-50 recorded, then edited `edits` times through recordRequirement. Returns every version. */
async function seedVersions(store: TraceStore, edits: number) {
  const { recordRequirement } = await import('../src/trace/store.ts');
  return Array.from({ length: edits + 1 }, (_, i) =>
    recordRequirement(store, { type: 'requirement', sourceRef: 'PROJ-50', content: { text: `Version ${i}.` }, provenance: human }),
  );
}

test('an edited requirement nobody has audited since is suspect', async () => {
  const store = new TraceStore(':memory:');
  const [v1, v2] = await seedVersions(store, 1);
  assert.deepEqual(assessReleaseRisk(store, { changed: ['PROJ-50'] }).suspect, [
    { requirementId: v2.id, sourceRef: 'PROJ-50', previousIds: [v1.id] },
  ]);
});

test('only the current version is suspect, not every edit in its history', async () => {
  const store = new TraceStore(':memory:');
  const [, v2, v3] = await seedVersions(store, 2);
  assert.deepEqual(assessReleaseRisk(store, { changed: ['PROJ-50'] }).suspect.map((s) => [s.requirementId, s.previousIds]), [[v3.id, [v2.id]]]);
});

test('an unedited requirement is never suspect', async () => {
  const store = new TraceStore(':memory:');
  await seedVersions(store, 0);
  assert.deepEqual(assessReleaseRisk(store, { changed: ['PROJ-50'] }).suspect, []);
});

for (const type of ['finding', 'audit'] as const) {
  test(`a ${type} on the new version clears suspect`, async () => {
    const store = new TraceStore(':memory:');
    const [, v2] = await seedVersions(store, 1);
    store.record({ type, content: {}, provenance: human, links: [{ to: v2.id, relation: 'derived_from' }] });
    assert.deepEqual(assessReleaseRisk(store, { changed: ['PROJ-50'] }).suspect, []);
  });
}

test('a verdict records suspect requirements, and records nothing when there are none', async () => {
  const store = new TraceStore(':memory:');
  await seedVersions(store, 1);
  store.record({ type: 'requirement', sourceRef: 'PROJ-51', content: { text: 'Clean.' }, provenance: human });
  const withSuspect = recordVerdict(store, { releaseRef: 'r', verdict: 'hold', reason: 'Checking.', cites: [], changed: ['PROJ-50'], provenance: human });
  assert.deepEqual(withSuspect.content.suspect, ['PROJ-50']);
  const clean = recordVerdict(store, { releaseRef: 'r', verdict: 'ship', reason: 'Fine.', cites: [], changed: ['PROJ-51'], provenance: human });
  assert.equal('suspect' in clean.content, false);
});
