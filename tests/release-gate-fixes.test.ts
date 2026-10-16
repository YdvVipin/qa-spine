/**
 * Regression tests for two release-gate bugs found by reproducing QAAE's Loop A writes:
 *   1. A healed test stayed blocked forever: the test case a heal replaced (`supersedes`)
 *      still covered the requirement, so its last failed run still decided.
 *   2. A pass typed in by hand (producer `human`) cleared a failure a tool had recorded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';
import { assessReleaseRisk, currentTestCases, recordVerdict, requirementStatus, HAND_RECORDED_PASS_HELD } from '../src/release.ts';
import { renderBrief } from '../src/brief.ts';

const REPO = process.cwd();
const human = { producer: 'human' as const };
const tool = { producer: 'tool' as const, tool: 'qa-spine ingest-junit' };
const ai = { producer: 'ai' as const, model: 'gpt-5.2', promptVersion: 'sha256:abc123abc123' };

const failing = (r: ReturnType<typeof assessReleaseRisk>) =>
  r.signals.flatMap((s) => (s.kind === 'failing_test_on_changed_area' ? [s.detail] : []));

function run(store: TraceStore, tcId: string, content: Record<string, unknown>, provenance: any = human) {
  return store.record({ type: 'test_run', sourceRef: 'run', content, provenance, links: [{ to: tcId, relation: 'verifies' }] });
}

/** Loop A's heal path, as the repro script records it: generate, run fails, heal, run passes. */
function seedHeal(store: TraceStore, healCovers = true) {
  const req = store.record({ type: 'requirement', sourceRef: 'SCRUM-21', content: { text: 'Shops page lists shops' }, provenance: human });
  const tc1 = store.record({
    type: 'test_case', sourceRef: 'features/shops.feature', content: { scenario_name: 'shops' }, provenance: ai,
    links: [{ to: req.id, relation: 'covers' }],
  });
  const run1 = run(store, tc1.id, { status: 'failed', failed: 1 });
  const tc2 = store.record({
    type: 'test_case', sourceRef: 'features/shops.feature', content: { strategy_used: 'locator_swap' }, provenance: human,
    links: [{ to: tc1.id, relation: 'supersedes' }, ...(healCovers ? [{ to: req.id, relation: 'covers' as const }] : [])],
  });
  return { req, tc1, run1, tc2 };
}

// ---- Bug 1: superseded test cases ---------------------------------------------------------

test('bug 1: a healed test whose replacement passes no longer blocks', () => {
  const store = new TraceStore(':memory:');
  const { tc2 } = seedHeal(store);
  run(store, tc2.id, { status: 'completed', failed: 0 });
  assert.deepEqual(failing(assessReleaseRisk(store, { changed: ['SCRUM-21'] })), []);
});

test('bug 1: a healed test whose replacement fails still blocks, named by the replacement', () => {
  const store = new TraceStore(':memory:');
  const { tc2 } = seedHeal(store);
  const r2 = run(store, tc2.id, { status: 'failed' }, tool);
  const [t, ...rest] = failing(assessReleaseRisk(store, { changed: ['SCRUM-21'] }));
  assert.equal(rest.length, 0, 'the superseded case must not add a second failure');
  assert.equal(t.testCaseId, tc2.id);
  assert.equal(t.testRunId, r2.id);
});

test('bug 1: the replacement decides even when the heal recorded no covers edge of its own', () => {
  const store = new TraceStore(':memory:');
  const { tc1, tc2 } = seedHeal(store, false);
  assert.deepEqual(currentTestCases(store, tc1).map((t) => t.id), [tc2.id]);
  run(store, tc2.id, { status: 'passed' }, tool);
  const r = assessReleaseRisk(store, { changed: ['SCRUM-21'] });
  assert.deepEqual(failing(r), []);
  assert.deepEqual(r.untested, [], 'coverage carries over to the replacement');
});

test('bug 1: a chain of heals resolves to the newest case', () => {
  const store = new TraceStore(':memory:');
  const { req, tc1, tc2 } = seedHeal(store);
  run(store, tc2.id, { status: 'failed' }, tool);
  const tc3 = store.record({
    type: 'test_case', sourceRef: 'features/shops.feature', content: { strategy_used: 'text_match' }, provenance: human,
    links: [{ to: tc2.id, relation: 'supersedes' }, { to: req.id, relation: 'covers' }],
  });
  assert.deepEqual(currentTestCases(store, tc1).map((t) => t.id), [tc3.id]);
  run(store, tc3.id, { status: 'passed' }, tool);
  assert.deepEqual(failing(assessReleaseRisk(store, { changed: ['SCRUM-21'] })), []);
});

test('bug 1: the readiness view counts only the current case, so it agrees with the gate', () => {
  const store = new TraceStore(':memory:');
  const { tc2 } = seedHeal(store);
  run(store, tc2.id, { status: 'passed' }, tool);
  const [row] = requirementStatus(store, ['SCRUM-21']);
  assert.equal(row.tests, 1);
  assert.equal(row.failing, 0);
  assert.equal(row.status, 'clear');
});

test('bug 1: history stays: the old case, its failed run and the supersedes edge remain in the chain', () => {
  const store = new TraceStore(':memory:');
  const { req, tc1, run1, tc2 } = seedHeal(store);
  run(store, tc2.id, { status: 'passed' }, tool);
  const before = store.list(undefined, 1e9).length;
  assessReleaseRisk(store, { changed: ['SCRUM-21'] });
  requirementStatus(store);
  assert.equal(store.list(undefined, 1e9).length, before, 'reading the gate writes nothing');
  const chain = store.chain(req.id)!;
  const ids = chain.nodes.map((n) => n.id);
  for (const id of [tc1.id, run1.id, tc2.id]) assert.ok(ids.includes(id), `${id} still in the chain`);
  assert.ok(chain.edges.some((e) => e.fromArtifactId === tc2.id && e.toArtifactId === tc1.id && e.relation === 'supersedes'));
  assert.equal(store.verify().ok, true);
});

test('bug 1: a supersedes cycle (only possible through store.link) does not make a test vanish', () => {
  const store = new TraceStore(':memory:');
  const { tc1, tc2 } = seedHeal(store);
  store.link(tc1.id, tc2.id, 'supersedes');
  run(store, tc2.id, { status: 'failed' }, tool);
  assert.ok(failing(assessReleaseRisk(store, { changed: ['SCRUM-21'] })).length >= 1);
});

// ---- Bug 2: hand-recorded passes ----------------------------------------------------------

/** Scenario B of the repro: a failing run from the ingest tool on a covering test. */
function seedToolFailure(store: TraceStore) {
  const req = store.record({ type: 'requirement', sourceRef: 'SCRUM-22', content: { text: 'Coupon applies 10%' }, provenance: human });
  const tc = store.record({
    type: 'test_case', sourceRef: 'features/coupon.feature', content: { name: 'coupon' }, provenance: human,
    links: [{ to: req.id, relation: 'covers' }],
  });
  const fail = run(store, tc.id, { status: 'failed', message: 'total unchanged' }, { ...tool, tool: 'qa-spine ingest-junit' });
  return { req, tc, fail };
}

test('bug 2: a hand-recorded pass does not clear a tool-recorded failure, and says why', () => {
  const store = new TraceStore(':memory:');
  const { tc, fail } = seedToolFailure(store);
  const pass = run(store, tc.id, { status: 'passed' });
  const [t, ...rest] = failing(assessReleaseRisk(store, { changed: ['SCRUM-22'] }));
  assert.equal(rest.length, 0);
  assert.equal(t.testRunId, fail.id, 'the failing tool run still decides');
  assert.equal(t.status, 'failed');
  assert.equal(t.handRecordedPass, pass.id);
  assert.equal(t.heldBecause, HAND_RECORDED_PASS_HELD);
  assert.equal(requirementStatus(store, ['SCRUM-22'])[0].status, 'blocked');
});

test('bug 2: a pass from a tool run clears the failure as before', () => {
  const store = new TraceStore(':memory:');
  const { tc } = seedToolFailure(store);
  run(store, tc.id, { status: 'passed' }, tool);
  assert.deepEqual(failing(assessReleaseRisk(store, { changed: ['SCRUM-22'] })), []);
});

test('bug 2: a tool pass after a hand-recorded pass clears it', () => {
  const store = new TraceStore(':memory:');
  const { tc } = seedToolFailure(store);
  run(store, tc.id, { status: 'passed' });
  run(store, tc.id, { status: 'passed' }, tool);
  assert.deepEqual(failing(assessReleaseRisk(store, { changed: ['SCRUM-22'] })), []);
});

test('bug 2: a hand-recorded pass on a test with no earlier failure is not a block', () => {
  const store = new TraceStore(':memory:');
  const req = store.record({ type: 'requirement', sourceRef: 'SCRUM-23', content: { text: 'r' }, provenance: human });
  const tc = store.record({ type: 'test_case', content: {}, provenance: human, links: [{ to: req.id, relation: 'covers' }] });
  run(store, tc.id, { status: 'passed' });
  assert.deepEqual(failing(assessReleaseRisk(store, { changed: ['SCRUM-23'] })), []);
});

test('bug 2: a hand-recorded pass on the same commit does not make the failure look flaky', () => {
  const store = new TraceStore(':memory:');
  const req = store.record({ type: 'requirement', sourceRef: 'SCRUM-24', content: { text: 'r' }, provenance: human });
  const tc = store.record({ type: 'test_case', content: {}, provenance: human, links: [{ to: req.id, relation: 'covers' }] });
  run(store, tc.id, { status: 'failed', commit: 'c1' }, tool);
  run(store, tc.id, { status: 'passed', commit: 'c1' });
  const r = assessReleaseRisk(store, { changed: ['SCRUM-24'] });
  assert.equal(failing(r)[0].flaky, false);
  assert.deepEqual(r.flaky, []);
});

test('bug 2: recordVerdict refuses a ship over a held hand pass, and an approved override ships it', () => {
  const store = new TraceStore(':memory:');
  const { tc, fail } = seedToolFailure(store);
  run(store, tc.id, { status: 'passed' });
  const base = { releaseRef: 'r1', verdict: 'ship' as const, reason: 'Checked by hand.', cites: [], changed: ['SCRUM-22'] };
  assert.throws(() => recordVerdict(store, { ...base, provenance: human }), /typed in by hand with no one named in approvedBy/);
  assert.throws(
    () => recordVerdict(store, { ...base, override: { reason: 'Verified by hand on staging.' }, provenance: human }),
    /approvedBy/,
  );
  const v = recordVerdict(store, {
    ...base,
    override: { reason: 'Verified by hand on staging.' },
    provenance: { producer: 'human', approvedBy: 'a.rivera' },
  });
  assert.equal(v.content.verdict, 'ship');
  assert.deepEqual((v.content.override as any).testRuns, [fail.id]);
  assert.match(renderBrief(store, v.id), /entered by hand/);
});

// ---- Both repros through the CLI, as QAAE calls it -----------------------------------------

function withDb(fn: (db: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-gatefix-'));
  try {
    fn(join(dir, 'trace.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cli(args: string[], db: string, input?: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', ['--no-warnings', resolve(REPO, 'src/server.ts'), ...args], {
      encoding: 'utf8', input, env: { ...process.env, QA_SPINE_DB: db },
    });
    return { code: 0, out };
  } catch (err: any) {
    return { code: err.status ?? 1, out: err.stdout ?? '' };
  }
}
const rec = (db: string, a: unknown) => JSON.parse(cli(['record'], db, JSON.stringify(a)).out).id as string;

test('repro A via the CLI: generate, fail, heal, pass gives shippable true', () => {
  withDb((db) => {
    const req = rec(db, { type: 'requirement', sourceRef: 'SCRUM-21', content: { text: 'Shops page lists shops' }, provenance: human });
    const tc1 = rec(db, { type: 'test_case', sourceRef: 'features/shops.feature', content: { scenario_name: 'shops' }, provenance: ai, links: [{ to: req, relation: 'covers' }] });
    rec(db, { type: 'test_run', sourceRef: 'run1', content: { status: 'failed', failed: 1 }, provenance: human, links: [{ to: tc1, relation: 'verifies' }] });
    const tc2 = rec(db, { type: 'test_case', sourceRef: 'features/shops.feature', content: { strategy_used: 'locator_swap' }, provenance: human, links: [{ to: tc1, relation: 'supersedes' }, { to: req, relation: 'covers' }] });
    rec(db, { type: 'test_run', sourceRef: 'run2', content: { status: 'completed', failed: 0 }, provenance: human, links: [{ to: tc2, relation: 'verifies' }] });
    const { code, out } = cli(['gate', '--changed', 'SCRUM-21', '--json'], db);
    const r = JSON.parse(out);
    assert.equal(r.shippable, true);
    assert.deepEqual(r.failingTests, []);
    assert.equal(code, 0);
  });
});

test('repro B via the CLI: a hand-recorded pass holds; a named override with a reason ships', () => {
  withDb((db) => {
    const req = rec(db, { type: 'requirement', sourceRef: 'SCRUM-22', content: { text: 'Coupon applies 10%' }, provenance: human });
    const tc = rec(db, { type: 'test_case', sourceRef: 'features/coupon.feature', content: {}, provenance: human, links: [{ to: req, relation: 'covers' }] });
    // A CI step, not the ingest: raw `record` refuses a qa-spine tool name. Any run can block.
    rec(db, { type: 'test_run', sourceRef: 'ci-run', content: { status: 'failed' }, provenance: { producer: 'tool', tool: 'jenkins' }, links: [{ to: tc, relation: 'verifies' }] });
    assert.equal(JSON.parse(cli(['gate', '--changed', 'SCRUM-22', '--json'], db).out).shippable, false);
    rec(db, { type: 'test_run', sourceRef: 'trust-me', content: { status: 'passed' }, provenance: human, links: [{ to: tc, relation: 'verifies' }] });

    const held = cli(['gate', '--changed', 'SCRUM-22', '--json'], db);
    assert.equal(held.code, 1);
    const r = JSON.parse(held.out);
    assert.equal(r.shippable, false);
    assert.equal(r.failingTests[0].heldBecause, HAND_RECORDED_PASS_HELD);

    const summary = cli(['gate', '--changed', 'SCRUM-22'], db).out;
    assert.match(summary, /Not cleared: latest pass was typed in by hand with no one named in approvedBy/);
    assert.match(summary, /--approved-by/);

    const approved = cli(['gate', '--changed', 'SCRUM-22', '--override-reason', 'Verified by hand on staging.', '--approved-by', 'a.rivera', '--json'], db);
    assert.equal(approved.code, 0);
    assert.equal(JSON.parse(approved.out).shippable, true);
  });
});
