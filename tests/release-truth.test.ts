/**
 * Acceptance corpus for the release decision (research probes R01–R11, 2026-11-06).
 *
 * The contract: SHIP only when the evidence shows it; HOLD on a known blocker; UNKNOWN when
 * evidence is missing, skipped, malformed or for another build. Every surface — gate, MCP,
 * readiness, the verdict writer — reaches the same decision, because they share one evaluator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TraceStore } from '../src/trace/store.ts';
import { createServer } from '../src/server.ts';
import { runGate } from '../src/gate.ts';
import { ingestJunit } from '../src/junit.ts';
import { assessReleaseRisk, recordVerdict, requirementStatus } from '../src/release.ts';
import { recordRetraction } from '../src/retract.ts';
import { renderBrief } from '../src/brief.ts';

const human = { producer: 'human' as const };
const ingest = { producer: 'tool' as const, tool: 'qa-spine ingest-junit' };

const requirement = (s: TraceStore, ref = 'QA-1') =>
  s.record({ type: 'requirement', sourceRef: ref, content: { text: 'Checkout uses the correct total.' }, provenance: human });
const testCase = (s: TraceStore, reqId: string) =>
  s.record({ type: 'test_case', content: { name: 'checkout total' }, provenance: human, links: [{ to: reqId, relation: 'covers' }] });
const testRun = (s: TraceStore, tcId: string, content: Record<string, unknown>, provenance: any = ingest) =>
  s.record({ type: 'test_run', content, provenance, links: [{ to: tcId, relation: 'verifies' }] });
const junit = (s: TraceStore, body: string, extra: { commit?: string; runRef?: string } = {}) =>
  ingestJunit(s, {
    reports: [{ file: 'r.xml', xml: `<testsuite><testcase classname="checkout" name="QA-1 total">${body}</testcase></testsuite>` }],
    ...extra,
  });

/** A requirement with one ingested passing test: the positive control everything else perturbs. */
function shippable(s: TraceStore) {
  const req = requirement(s);
  const tc = testCase(s, req.id);
  testRun(s, tc.id, { status: 'passed', commit: 'c1' });
  return { req, tc };
}

// ---- positive control -----------------------------------------------------------------

test('a covered requirement whose test passed ships', () => {
  const s = new TraceStore(':memory:');
  shippable(s);
  const r = runGate(s, { changed: ['QA-1'] });
  assert.equal(r.decision, 'SHIP');
  assert.deepEqual(r.reasons, []);
  assert.equal(r.shippable, true);
});

// ---- UNKNOWN: evidence is missing ---------------------------------------------------------

test('R01: a store with nothing matching the change is UNKNOWN, not a clean release', () => {
  const s = new TraceStore(':memory:');
  shippable(s);
  const r = runGate(s, { changed: ['QA-999'] });
  assert.equal(r.decision, 'UNKNOWN');
  assert.deepEqual(r.reasons, ['SCOPE_UNRESOLVED']);
  assert.equal(r.shippable, false);
});

test('R02: a requirement with no test is UNKNOWN by default, no flag needed', () => {
  const s = new TraceStore(':memory:');
  requirement(s);
  const r = runGate(s, { changed: ['QA-1'] });
  assert.equal(r.decision, 'UNKNOWN');
  assert.deepEqual(r.reasons, ['NO_TEST']);
});

test('R03: a linked test that never ran is UNKNOWN, and readiness does not call it clear', () => {
  const s = new TraceStore(':memory:');
  const req = requirement(s);
  const tc = testCase(s, req.id);
  const r = runGate(s, { changed: ['QA-1'] });
  assert.equal(r.decision, 'UNKNOWN');
  assert.deepEqual(r.reasons, ['NO_REQUIRED_RUN']);
  assert.deepEqual(r.incomplete.map((t) => [t.testCaseId, t.state]), [[tc.id, 'not_run']]);
  assert.equal(requirementStatus(s)[0].status, 'unknown');
});

test('a test whose only result is an unnamed hand-typed pass has not run as far as the gate can tell', () => {
  const s = new TraceStore(':memory:');
  const req = requirement(s);
  const tc = testCase(s, req.id);
  testRun(s, tc.id, { status: 'passed' }, human);
  assert.equal(runGate(s, { changed: ['QA-1'] }).decision, 'UNKNOWN');
});

// ---- skips do not prove anything ---------------------------------------------------------

test('R04: a real JUnit failure followed by a skip still holds — a skip does not fix anything', () => {
  const s = new TraceStore(':memory:');
  requirement(s);
  junit(s, '<failure message="bad total"/>', { commit: 'b1' });
  junit(s, '<skipped/>', { commit: 'b1' });
  const r = runGate(s, { changed: ['QA-1'] });
  assert.equal(r.decision, 'HOLD');
  assert.ok(r.reasons.includes('FAILED_TEST'));
  assert.equal(r.failingTests.length, 1);
  assert.equal(r.failingTests[0].status, 'failed');
});

test('a pass followed by a skip is UNKNOWN: the latest run did not show it works', () => {
  const s = new TraceStore(':memory:');
  requirement(s);
  junit(s, '', { commit: 'b1' });
  junit(s, '<skipped/>', { commit: 'b2' });
  const r = runGate(s, { changed: ['QA-1'] });
  assert.equal(r.decision, 'UNKNOWN');
  assert.deepEqual(r.reasons, ['SKIPPED_REQUIRED_TEST']);
});

// ---- the build being released --------------------------------------------------------------

test('R05: a pass on another build does not clear a failure on the build being released', () => {
  const s = new TraceStore(':memory:');
  const req = requirement(s);
  const tc = testCase(s, req.id);
  testRun(s, tc.id, { status: 'failed', commit: 'new-build', environment: 'staging' });
  testRun(s, tc.id, { status: 'passed', commit: 'old-build', environment: 'development' });
  assert.equal(runGate(s, { changed: ['QA-1'], commit: 'new-build' }).decision, 'HOLD');
  assert.equal(runGate(s, { changed: ['QA-1'], environment: 'staging' }).decision, 'HOLD');
});

test('a build with no result of its own is UNKNOWN, whatever older builds said', () => {
  const s = new TraceStore(':memory:');
  shippable(s);
  const r = runGate(s, { changed: ['QA-1'], commit: 'c2' });
  assert.equal(r.decision, 'UNKNOWN');
  assert.deepEqual(r.reasons, ['NO_REQUIRED_RUN']);
  assert.equal(runGate(s, { changed: ['QA-1'], commit: 'c1' }).decision, 'SHIP');
});

// ---- malformed results ---------------------------------------------------------------------

test('R08: a test result with an unknown status is refused before it is written', () => {
  const s = new TraceStore(':memory:');
  const req = requirement(s);
  const tc = testCase(s, req.id);
  assert.throws(
    () => testRun(s, tc.id, { status: 'banana' }, { ...human, approvedBy: 'claimed-reviewer' }),
    /status "banana" is not one of passed, failed, error, skipped, blocked, not_run, cancelled, unknown/,
  );
  assert.throws(() => testRun(s, tc.id, {}), /status/);
  assert.equal(s.list('test_run', 10).length, 0, 'nothing partial was written');
});

test('R08: a malformed status already in an old store reads as UNKNOWN, never as a pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-legacy-'));
  try {
    const db = join(dir, 'trace.db');
    const s = new TraceStore(db);
    const req = requirement(s);
    const tc = testCase(s, req.id);
    s.close();
    // Written the way an older version could: straight in, no status check.
    const raw = new DatabaseSync(db);
    const at = new Date(Date.now() + 1000).toISOString();
    raw.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?)').run(
      'test_run_0legacy0', 'test_run', null, JSON.stringify({ status: 'completed', failed: 0 }),
      JSON.stringify({ ...human, approvedBy: 'Dana' }), at,
    );
    raw.prepare('INSERT INTO edges VALUES (?, ?, ?, ?)').run('test_run_0legacy0', tc.id, 'verifies', at);
    raw.close();
    const r = runGate(new TraceStore(db), { changed: ['QA-1'] });
    assert.equal(r.decision, 'UNKNOWN');
    assert.deepEqual(r.reasons, ['INVALID_STATUS']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withdrawing a test\'s only failing run leaves it never run: UNKNOWN, not a pass', () => {
  const s = new TraceStore(':memory:');
  const req = requirement(s);
  const tc = testCase(s, req.id);
  const run = testRun(s, tc.id, { status: 'failed' });
  recordRetraction(s, { id: run.id, by: 'Dana', reason: 'Report came from the wrong server.' });
  const r = runGate(s, { changed: ['QA-1'] });
  assert.equal(r.decision, 'UNKNOWN');
  assert.deepEqual(r.reasons, ['NO_REQUIRED_RUN']);
});

// ---- overrides ------------------------------------------------------------------------------

test('R09: a whitespace-only approver is refused whether or not the gate records', () => {
  const s = new TraceStore(':memory:');
  const { tc } = shippable(s);
  testRun(s, tc.id, { status: 'failed' });
  for (const record of [false, true]) {
    assert.throws(
      () => runGate(s, { changed: ['QA-1'], overrideReason: 'Risk accepted.', approvedBy: '   ', record, releaseRef: 'v1' }),
      /override-reason and --approved-by must be given together/,
    );
  }
  assert.throws(
    () => runGate(s, { changed: ['QA-1'], overrideReason: '  ', approvedBy: 'Dana' }),
    /override-reason and --approved-by must be given together/,
  );
});

test('a named override ships a known failure, and says it was overridden', () => {
  const s = new TraceStore(':memory:');
  const { tc } = shippable(s);
  testRun(s, tc.id, { status: 'failed' });
  const r = runGate(s, { changed: ['QA-1'], overrideReason: 'Risk accepted.', approvedBy: 'Dana' });
  assert.equal(r.decision, 'OVERRIDDEN');
  assert.equal(r.shippable, true);
});

test('an override cannot clear missing evidence: failing plus untested stays unshippable', () => {
  const s = new TraceStore(':memory:');
  const { tc } = shippable(s);
  testRun(s, tc.id, { status: 'failed' });
  requirement(s, 'QA-2');
  const held = runGate(s, { changed: ['QA-1', 'QA-2'] });
  assert.equal(held.decision, 'HOLD', 'a known failure outranks missing evidence');
  assert.deepEqual(held.reasons, ['FAILED_TEST', 'NO_TEST'], 'and the missing evidence is not lost');
  const r = runGate(s, { changed: ['QA-1', 'QA-2'], overrideReason: 'Risk accepted.', approvedBy: 'Dana' });
  assert.equal(r.decision, 'UNKNOWN');
  assert.equal(r.shippable, false);
});

// ---- the verdict writer uses the same rules -------------------------------------------------

test('R10: a ship verdict written directly is refused while a requirement has no test', () => {
  const s = new TraceStore(':memory:');
  const req = requirement(s);
  assert.throws(
    () => recordVerdict(s, { releaseRef: 'v1', verdict: 'ship', reason: 'Review completed.', changed: ['QA-1'], cites: [req.id], provenance: human }),
    /cannot ship: the evidence is incomplete \(NO_TEST\)/,
  );
  // A hold is always allowed: saying "not yet" needs no evidence.
  const v = recordVerdict(s, { releaseRef: 'v1', verdict: 'hold', reason: 'Not tested yet.', changed: ['QA-1'], cites: [req.id], provenance: human });
  assert.equal(v.content.decision, 'UNKNOWN');
  assert.deepEqual(v.content.reasons, ['NO_TEST']);
});

test('the brief says, in plain words, that the evidence behind a hold was incomplete', () => {
  const s = new TraceStore(':memory:');
  const req = requirement(s);
  const v = recordVerdict(s, { releaseRef: 'v1', verdict: 'hold', reason: 'Not tested yet.', changed: ['QA-1'], cites: [req.id], provenance: human });
  const html = renderBrief(s, v.id);
  assert.match(html, /What the evidence showed: incomplete — some changed areas have nothing showing they work\./);
  assert.doesNotMatch(html.split(/<footer/i)[0], /UNKNOWN|NO_TEST/, 'no internal codes in front of a project manager');
});

test('R10: an override does not let a direct ship verdict past missing evidence', () => {
  const s = new TraceStore(':memory:');
  const req = requirement(s);
  assert.throws(
    () =>
      recordVerdict(s, {
        releaseRef: 'v1', verdict: 'ship', reason: 'Shipping.', changed: ['QA-1'], cites: [req.id],
        override: { reason: 'Accepted.' }, provenance: { ...human, approvedBy: 'Dana' },
      }),
    /cannot ship: the evidence is incomplete/,
  );
});

test('R10: an override on a known failure does not carry an untested requirement through with it', () => {
  const s = new TraceStore(':memory:');
  const { req, tc } = shippable(s);
  testRun(s, tc.id, { status: 'failed' });
  requirement(s, 'QA-2');
  assert.throws(
    () =>
      recordVerdict(s, {
        releaseRef: 'v1', verdict: 'ship', reason: 'Shipping.', changed: ['QA-1', 'QA-2'], cites: [req.id],
        override: { reason: 'Accepted.' }, provenance: { ...human, approvedBy: 'Dana' },
      }),
    /cannot ship: the evidence is incomplete \(NO_TEST\)/,
  );
});

// ---- replayed reports -----------------------------------------------------------------------

test('R11: the same report delivered twice for one run records one result', () => {
  const s = new TraceStore(':memory:');
  requirement(s);
  junit(s, '', { runRef: 'ci:123', commit: 'abc' });
  junit(s, '', { runRef: 'ci:123', commit: 'abc' });
  assert.equal(s.list('test_run', 10).length, 1);
});

test('R11: the same run delivering a different result is a conflict, not an overwrite', () => {
  const s = new TraceStore(':memory:');
  requirement(s);
  junit(s, '', { runRef: 'ci:123', commit: 'abc' });
  assert.throws(() => junit(s, '<failure/>', { runRef: 'ci:123', commit: 'abc' }), /ci:123 already recorded .* as passed/);
  assert.equal(s.list('test_run', 10).length, 1);
});

// ---- every surface agrees -------------------------------------------------------------------

function withDb(fn: (db: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-truth-'));
  try {
    fn(join(dir, 'trace.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function cli(args: string[], db: string) {
  try {
    return { code: 0, out: execFileSync('node', ['src/server.ts', ...args], { encoding: 'utf8', env: { ...process.env, QA_SPINE_DB: db } }) };
  } catch (err: any) {
    return { code: err.status as number, out: err.stdout as string };
  }
}

test('CLI: UNKNOWN exits 2 with the decision on stdout; --advisory exits 0 but still says UNKNOWN', () => {
  withDb((db) => {
    const s = new TraceStore(db);
    requirement(s);
    s.close();
    const strict = cli(['gate', '--changed', 'QA-1', '--json'], db);
    assert.equal(strict.code, 2);
    assert.equal(JSON.parse(strict.out).decision, 'UNKNOWN');
    const advisory = cli(['gate', '--changed', 'QA-1', '--json', '--advisory'], db);
    assert.equal(advisory.code, 0);
    const r = JSON.parse(advisory.out);
    assert.equal(r.decision, 'UNKNOWN');
    assert.equal(r.shippable, false);
    assert.equal(r.enforcement, 'advisory');
  });
});

test('CLI: --commit binds the gate to one build', () => {
  withDb((db) => {
    const s = new TraceStore(db);
    shippable(s);
    s.close();
    assert.equal(cli(['gate', '--changed', 'QA-1', '--commit', 'c1'], db).code, 0);
    assert.equal(cli(['gate', '--changed', 'QA-1', '--commit', 'c2'], db).code, 2);
  });
});

test('gate, MCP assess, MCP submit and readiness reach the same decision on one snapshot', async () => {
  const s = new TraceStore(':memory:');
  const req = requirement(s);
  testCase(s, req.id);
  const gate = runGate(s, { changed: ['QA-1'] });
  const direct = assessReleaseRisk(s, { changed: ['QA-1'] });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(s).connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  const assessed = JSON.parse(((await client.callTool({ name: 'assess_release_risk', arguments: { changed: ['QA-1'] } })) as any).content[0].text);
  const submitted = (await client.callTool({
    name: 'release_submit',
    arguments: { releaseRef: 'v1', verdict: 'ship', reason: 'Looks fine.', cites: [], changed: ['QA-1'], provenance: human },
  })) as any;

  assert.deepEqual([gate.decision, gate.reasons], ['UNKNOWN', ['NO_REQUIRED_RUN']]);
  assert.deepEqual([direct.decision, direct.reasons], [gate.decision, gate.reasons]);
  assert.deepEqual([assessed.decision, assessed.reasons], [gate.decision, gate.reasons]);
  assert.equal(submitted.isError, true);
  assert.match(submitted.content[0].text, /cannot ship: the evidence is incomplete \(NO_REQUIRED_RUN\)/);
  assert.equal(requirementStatus(s, ['QA-1'])[0].status, 'unknown');
});
