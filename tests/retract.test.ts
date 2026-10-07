import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TraceStore, recordRequirement } from '../src/trace/store.ts';
import { createServer } from '../src/server.ts';
import { createInspector } from '../src/inspector/server.ts';
import { recordRetraction } from '../src/retract.ts';
import { recordAnswer, openQuestions } from '../src/audit.ts';
import { assessReleaseRisk, recordVerdict, requirementStatus, INGEST_TOOL } from '../src/release.ts';
import { renderBrief } from '../src/brief.ts';
import { ingestJunit } from '../src/junit.ts';

const REPO = process.cwd();
const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-opus-5', promptVersion: 'ambiguity/1' };
const ingest = { producer: 'tool' as const, tool: INGEST_TOOL };
const by = 'a.rivera';

/** A requirement with one test whose only run failed — the smallest store with a blocker. */
function seed(store: TraceStore) {
  const req = store.record({ type: 'requirement', sourceRef: 'PROJ-42', content: { text: 'Refunds are processed quickly.' }, provenance: human });
  const tc = store.record({ type: 'test_case', content: { name: 'refund completes' }, provenance: ingest, links: [{ to: req.id, relation: 'covers' }] });
  const run = store.record({
    type: 'test_run',
    content: { status: 'failed', message: 'timed out' },
    provenance: ingest,
    links: [{ to: tc.id, relation: 'verifies' }],
  });
  return { req, tc, run };
}

const failing = (store: TraceStore) =>
  assessReleaseRisk(store, { changed: ['PROJ-42'] }).signals.filter((s) => s.kind === 'failing_test_on_changed_area');

// ------------------------------------------------------------------ refusals

test('retract requires a name and a reason, and says which is missing', () => {
  const store = new TraceStore(':memory:');
  const { run } = seed(store);
  assert.throws(() => recordRetraction(store, { id: run.id, by: ' ', reason: 'wrong report' }), /needs a name/);
  assert.throws(() => recordRetraction(store, { id: run.id, by, reason: '' }), /needs a reason/);
  assert.throws(() => recordRetraction(store, { id: 'test_run_nope', by, reason: 'x' }), /no artifact/);
  assert.equal(store.list('retraction').length, 0);
});

test('retract refuses a finding (answer it) and a verdict (record a new one)', () => {
  const store = new TraceStore(':memory:');
  const { req } = seed(store);
  const finding = store.record({
    type: 'finding',
    content: { category: 'AMB-VAGUE-QUANT', quote: 'quickly', question: 'How quickly?' },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });
  assert.throws(() => recordRetraction(store, { id: finding.id, by, reason: 'x' }), /finding cannot be retracted — answer it/);
  const verdict = recordVerdict(store, { releaseRef: 'v1', verdict: 'hold', reason: 'Not ready.', cites: [], changed: ['PROJ-42'], provenance: human });
  assert.throws(() => recordRetraction(store, { id: verdict.id, by, reason: 'x' }), /verdict cannot be retracted — record a new decision/);
});

test('retracting something already retracted is refused and names the undo', () => {
  const store = new TraceStore(':memory:');
  const { run } = seed(store);
  const r = recordRetraction(store, { id: run.id, by, reason: 'wrong report' });
  assert.throws(() => recordRetraction(store, { id: run.id, by: 'b.chen', reason: 'again' }), new RegExp(`retract ${r.id}`));
});

// ------------------------------------------------------- gate, undo, verify

test('a retracted failing run stops blocking, is reported, and verify still passes', () => {
  const store = new TraceStore(':memory:');
  const { run } = seed(store);
  assert.equal(failing(store).length, 1);

  const r = recordRetraction(store, { id: run.id, by, reason: 'ingested the staging report' });
  const assessment = assessReleaseRisk(store, { changed: ['PROJ-42'] });
  assert.equal(failing(store).length, 0);
  assert.deepEqual(
    assessment.retracted.map((x) => [x.id, x.retractionId, x.by, x.reason, x.name]),
    [[run.id, r.id, by, 'ingested the staging report', 'refund completes']],
  );
  assert.equal(store.verify().ok, true);
});

test('undo is retracting the retraction; redo is retracting the undo; verify passes throughout', () => {
  const store = new TraceStore(':memory:');
  const { run } = seed(store);
  const r1 = recordRetraction(store, { id: run.id, by, reason: 'wrong report' });
  assert.equal(failing(store).length, 0);

  const undo = recordRetraction(store, { id: r1.id, by: 'b.chen', reason: 'it was the right report' });
  assert.equal(undo.content.undo, true);
  assert.equal(failing(store).length, 1, 'the run counts again');
  assert.equal(assessReleaseRisk(store, { changed: ['PROJ-42'] }).retracted.length, 0);
  assert.equal(store.verify().ok, true);

  recordRetraction(store, { id: undo.id, by, reason: 'no, it really was staging' });
  assert.equal(failing(store).length, 0, 'retracted again');
  assert.equal(store.verify().ok, true);
});

test('the verdict records what was retracted, copied, so a later undo does not change it', () => {
  const store = new TraceStore(':memory:');
  const { run } = seed(store);
  const r = recordRetraction(store, { id: run.id, by, reason: 'wrong report' });
  const verdict = recordVerdict(store, { releaseRef: 'v1', verdict: 'ship', reason: 'Clean.', cites: [], changed: ['PROJ-42'], provenance: human });
  recordRetraction(store, { id: r.id, by, reason: 'undo' });
  const recorded = store.get(verdict.id)!.content.retracted as { id: string; by: string; reason: string }[];
  assert.deepEqual(recorded.map((x) => [x.id, x.by, x.reason]), [[run.id, by, 'wrong report']]);
});

// ------------------------------------------------------- what's current

test('a retracted answer reopens its question everywhere, and it can be answered again', () => {
  const store = new TraceStore(':memory:');
  const { req } = seed(store);
  const finding = store.record({
    type: 'finding',
    sourceRef: 'PROJ-42',
    content: { category: 'AMB-VAGUE-QUANT', quote: 'quickly', question: 'How quickly?' },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });
  const answer = recordAnswer(store, { findingId: finding.id, answer: 'Within a day.', provenance: human });
  assert.equal(store.openFindings().length, 0);

  recordRetraction(store, { id: answer.id, by, reason: 'answered the wrong question' });
  assert.deepEqual(store.openFindings().map((f) => f.id), [finding.id]);
  assert.deepEqual(openQuestions(store).open.map((q) => q.findingId), [finding.id]);
  const open = (requireHumanAnswers: boolean) =>
    assessReleaseRisk(store, { changed: ['PROJ-42'], requireHumanAnswers }).signals.filter((s) => s.kind === 'unresolved_finding_on_changed_area');
  assert.equal(open(false).length, 1);
  assert.equal(open(true).length, 1, 'the human-answers path ignores the retracted answer too');
  assert.equal(requirementStatus(store)[0].open, 1);

  recordAnswer(store, { findingId: finding.id, answer: 'Within three business days.', provenance: human });
  assert.equal(store.openFindings().length, 0);
});

test('openFindings applies its limit after the retraction check, not before', () => {
  const store = new TraceStore(':memory:');
  const { req } = seed(store);
  const mk = (q: string) =>
    store.record({ type: 'finding', content: { category: 'C', quote: 'quickly', question: q }, provenance: ai, links: [{ to: req.id, relation: 'derived_from' }] });
  const open = mk('genuinely open');
  // Newer, so it sorts first: its answer was retracted and the retraction undone — answered
  // after all, but it still passes the cheap SQL pre-filter. It must not take the only slot.
  const stale = mk('looks open');
  const answer = recordAnswer(store, { findingId: stale.id, answer: 'a', provenance: human });
  const r = recordRetraction(store, { id: answer.id, by, reason: 'x' });
  recordRetraction(store, { id: r.id, by, reason: 'undo' });
  assert.deepEqual(store.openFindings(1).map((f) => f.id), [open.id]);
});

test('retracting an edit puts the previous version back; re-importing the retracted text records it again', () => {
  const store = new TraceStore(':memory:');
  const v1 = recordRequirement(store, { type: 'requirement', sourceRef: 'PROJ-9', content: { text: 'v1' }, provenance: human });
  const v2 = recordRequirement(store, { type: 'requirement', sourceRef: 'PROJ-9', content: { text: 'v2 (wrong ticket)' }, provenance: human });
  // A failing test written against the wrong ticket's text must not follow it back onto v1.
  const tc = store.record({ type: 'test_case', content: { name: 'wrong' }, provenance: ingest, links: [{ to: v2.id, relation: 'covers' }] });
  store.record({ type: 'test_run', content: { status: 'failed' }, provenance: ingest, links: [{ to: tc.id, relation: 'verifies' }] });
  recordRetraction(store, { id: v2.id, by, reason: 'imported from the wrong ticket' });

  const rows = requirementStatus(store).filter((r) => r.sourceRef === 'PROJ-9');
  assert.deepEqual(rows.map((r) => [r.requirementId, r.tests, r.failing]), [[v1.id, 0, 0]]);
  // Identical text to the retracted copy: a new artifact, never the copy someone withdrew.
  const again = recordRequirement(store, { type: 'requirement', sourceRef: 'PROJ-9', content: { text: 'v2 (wrong ticket)' }, provenance: human });
  assert.notEqual(again.id, v2.id);
  assert.equal(store.isRetracted(again.id), false);
  // Identical text to the version in force: nothing new.
  const v3 = recordRequirement(store, { type: 'requirement', sourceRef: 'PROJ-9', content: { text: 'v2 (wrong ticket)' }, provenance: human });
  assert.equal(v3.id, again.id);
});

test('a retracted requirement leaves the status list, unmatches its ref, hides its questions, and is reported', () => {
  const store = new TraceStore(':memory:');
  const { req } = seed(store);
  store.record({ type: 'finding', content: { category: 'C', quote: 'quickly', question: 'q?' }, provenance: ai, links: [{ to: req.id, relation: 'derived_from' }] });
  recordRetraction(store, { id: req.id, by, reason: 'not our ticket' });

  assert.equal(requirementStatus(store).length, 0);
  assert.equal(openQuestions(store).open.length, 0);
  const a = assessReleaseRisk(store, { changed: ['PROJ-42'] });
  assert.equal(a.signals.length, 0);
  assert.deepEqual(a.matched.unmatched, ['PROJ-42']);
  assert.deepEqual(a.retracted.map((x) => [x.id, x.name]), [[req.id, 'PROJ-42']]);
});

test('a retracted test case no longer covers its requirement', () => {
  const store = new TraceStore(':memory:');
  const { tc } = seed(store);
  recordRetraction(store, { id: tc.id, by, reason: 'test belongs to another service' });
  const [row] = requirementStatus(store);
  assert.equal(row.untested, true);
  assert.equal(row.failing, 0);
  assert.equal(assessReleaseRisk(store, { changed: ['PROJ-42'] }).untested.length, 1);
});

test('ingest does not reuse a retracted test case or cover a retracted requirement', () => {
  const store = new TraceStore(':memory:');
  const xml = '<testsuite><testcase classname="refunds" name="PROJ-42 refund completes"><failure message="boom"/></testcase></testsuite>';
  const first = ingestJunit(store, { reports: [{ file: 'a.xml', xml }] });
  recordRetraction(store, { id: first.runs[0].testCaseId, by, reason: 'wrong suite' });
  const second = ingestJunit(store, { reports: [{ file: 'a.xml', xml }] });
  assert.notEqual(second.runs[0].testCaseId, first.runs[0].testCaseId);
});

// ------------------------------------------------------- hand-entered runs

test('a hand-entered pass clears a failure only with a named person, and is flagged', () => {
  const store = new TraceStore(':memory:');
  const { tc } = seed(store);
  store.record({ type: 'test_run', content: { status: 'passed' }, provenance: human, links: [{ to: tc.id, relation: 'verifies' }] });
  assert.equal(failing(store).length, 1, 'an unnamed pass does not clear');
  assert.equal(requirementStatus(store)[0].failing, 1);

  const named = store.record({
    type: 'test_run',
    content: { status: 'passed' },
    provenance: { ...human, approvedBy: 'b.chen' },
    links: [{ to: tc.id, relation: 'verifies' }],
  });
  const a = assessReleaseRisk(store, { changed: ['PROJ-42'] });
  assert.equal(failing(store).length, 0);
  assert.deepEqual(a.handEntered.map((h) => [h.testRunId, h.by]), [[named.id, 'b.chen']]);
});

test('an ingested pass clears a failure and is not flagged as hand-entered', () => {
  const store = new TraceStore(':memory:');
  const { tc } = seed(store);
  store.record({ type: 'test_run', content: { status: 'passed' }, provenance: ingest, links: [{ to: tc.id, relation: 'verifies' }] });
  const a = assessReleaseRisk(store, { changed: ['PROJ-42'] });
  assert.equal(failing(store).length, 0);
  assert.equal(a.handEntered.length, 0);
});

test('a hand-entered failure still blocks, named or not', () => {
  const store = new TraceStore(':memory:');
  const { tc } = seed(store);
  store.record({ type: 'test_run', content: { status: 'passed' }, provenance: ingest, links: [{ to: tc.id, relation: 'verifies' }] });
  store.record({ type: 'test_run', content: { status: 'failed' }, provenance: human, links: [{ to: tc.id, relation: 'verifies' }] });
  assert.equal(failing(store).length, 1);
});

// ------------------------------------------------------- MCP: no retract

async function connect() {
  const store = new TraceStore(':memory:');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(store).connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res: any = await client.callTool({ name, arguments: args });
    return { isError: !!res.isError, body: JSON.parse(res.content[0].text) };
  };
  return { store, client, call };
}

test('no MCP tool can retract', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.ok(tools.length > 5, 'the list is real');
  assert.deepEqual(tools.filter((t) => /retract|withdraw|delete|remove/i.test(t.name)).map((t) => t.name), []);
});

test('trace_record refuses a retraction, a retracts link, and a qa-spine tool name', async () => {
  const { store, call } = await connect();
  const { run, tc } = seed(store);
  const before = store.list(undefined, 1e9).length;

  const asType = await call('trace_record', { type: 'retraction', content: { reason: 'x' }, provenance: human });
  assert.match(asType.body.error, /retraction cannot be recorded directly — use qa-spine retract/);

  const asLink = await call('trace_record', {
    type: 'defect', content: { text: 'x' }, provenance: human, links: [{ to: run.id, relation: 'retracts' }],
  });
  assert.match(asLink.body.error, /retracts link directly/);

  const forged = await call('trace_record', {
    type: 'test_run', content: { status: 'passed' }, provenance: { producer: 'tool', tool: 'qa-spine ingest-junit' },
    links: [{ to: tc.id, relation: 'verifies' }],
  });
  assert.match(forged.body.error, /reserved for qa-spine/);

  assert.equal(store.list(undefined, 1e9).length, before);
  assert.equal(failing(store).length, 1);
});

// ------------------------------------------------------- brief

test('a past brief does not move when something it relied on is retracted later', () => {
  const store = new TraceStore(':memory:');
  const { tc, run } = seed(store);
  // Passed on the same commit it failed on: flaky, and the brief says so.
  const pass = store.record({
    type: 'test_run', content: { status: 'passed', commit: 'abc' }, provenance: ingest, links: [{ to: tc.id, relation: 'verifies' }],
  });
  const fail = store.record({
    type: 'test_run', content: { status: 'failed', commit: 'abc' }, provenance: ingest, links: [{ to: tc.id, relation: 'verifies' }],
  });
  const verdict = recordVerdict(store, { releaseRef: 'v1', verdict: 'hold', reason: 'A test fails.', cites: [], changed: ['PROJ-42'], provenance: human });
  const before = renderBrief(store, verdict.id);
  assert.match(before, /may be unreliable/);

  recordRetraction(store, { id: pass.id, by, reason: 'x' });
  recordRetraction(store, { id: run.id, by, reason: 'x' });
  assert.equal(renderBrief(store, verdict.id), before);
  assert.ok(fail);
});

test('a new brief names what was withdrawn, by whom and why, in plain words', () => {
  const store = new TraceStore(':memory:');
  const { run } = seed(store);
  recordRetraction(store, { id: run.id, by, reason: 'That report came from the staging server.' });
  const verdict = recordVerdict(store, { releaseRef: 'v1', verdict: 'ship', reason: 'Clean.', cites: [], changed: ['PROJ-42'], provenance: human });
  const html = renderBrief(store, verdict.id);
  assert.match(html, /<h2>Withdrawn as recorded by mistake<\/h2>/);
  assert.match(html, /Test result · withdrawn by a\.rivera/);
  assert.match(html, /refund completes/);
  assert.match(html, /That report came from the staging server\./);
  const body = html.slice(0, html.indexOf('<footer>'));
  assert.doesNotMatch(body, /test_run|retraction_|test_run_|retractedBy/);
});

// ------------------------------------------------------- Inspector

async function serve(store: TraceStore, t: TestContext) {
  const server = createInspector(store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return (path: string, init?: RequestInit) => fetch(base + path, init);
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('Inspector: retract needs a name and a reason, refuses a finding, and records a human retraction', async (t) => {
  const store = new TraceStore(':memory:');
  const { run, req } = seed(store);
  const finding = store.record({ type: 'finding', content: { category: 'C', quote: 'quickly', question: 'q?' }, provenance: ai, links: [{ to: req.id, relation: 'derived_from' }] });
  const api = await serve(store, t);

  const noReason = await api('/api/retract', post({ artifactId: run.id, by }));
  assert.equal(noReason.status, 400);
  assert.match((await noReason.json()).error, /needs a reason/);
  const noName = await api('/api/retract', post({ artifactId: run.id, reason: 'x' }));
  assert.match((await noName.json()).error, /needs a name/);
  assert.equal((await api('/api/retract', post({ artifactId: finding.id, by, reason: 'x' }))).status, 400);
  assert.equal(store.list('retraction').length, 0);

  const ok = await api('/api/retract', post({ artifactId: run.id, by, reason: 'wrong report', provenance: ai }));
  assert.equal(ok.status, 200);
  const r = await ok.json();
  assert.equal(r.provenance.producer, 'human', 'the body cannot choose provenance');
  assert.equal(failing(store).length, 0);
});

test('Inspector: the list hides withdrawn artifacts unless asked, and the chain marks them', async (t) => {
  const store = new TraceStore(':memory:');
  const { run, tc } = seed(store);
  const r = recordRetraction(store, { id: run.id, by, reason: 'wrong report' });
  const api = await serve(store, t);

  const ids = async (q: string) => (await (await api('/api/artifacts' + q)).json()).artifacts.map((a: { id: string }) => a.id);
  assert.equal((await ids('')).includes(run.id), false);
  assert.equal((await ids('?type=test_run')).includes(run.id), false);
  const all = (await (await api('/api/artifacts?retracted=1')).json()).artifacts;
  assert.deepEqual(all.find((a: { id: string }) => a.id === run.id).retracted, {
    retractionId: r.id, by, reason: 'wrong report', at: r.createdAt,
  });

  const chain = await (await api(`/api/chain/${tc.id}`)).json();
  assert.ok(chain.nodes.some((n: { id: string }) => n.id === run.id), 'history keeps it');
  assert.equal(chain.retracted[run.id].by, by);
  assert.equal(chain.retracted[tc.id], undefined);
});

// ------------------------------------------------------- CLI end to end

function cli(args: string[], db: string, input?: string) {
  try {
    const out = execFileSync('node', [resolve(REPO, 'src/server.ts'), ...args], {
      encoding: 'utf8',
      input,
      env: { ...process.env, QA_SPINE_DB: db },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, out, err: '' };
  } catch (err: any) {
    return { code: err.status as number, out: String(err.stdout), err: String(err.stderr) };
  }
}

test('CLI: the gate goes green only through retract, which it then reports; undo turns it red again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-retract-'));
  try {
    const db = join(dir, 'trace.db');
    const store = new TraceStore(db);
    const { tc, run } = seed(store);
    store.close();

    assert.equal(cli(['gate', '--changed', 'PROJ-42'], db).code, 1);

    // The obvious way round it: a hand-typed "passed". Accepted, because QAAE records runs
    // this way, but it does not clear the failure.
    const sneak = cli(['record'], db, JSON.stringify({
      type: 'test_run', content: { status: 'passed' }, provenance: human, links: [{ to: tc.id, relation: 'verifies' }],
    }));
    assert.equal(sneak.code, 0, sneak.out);
    assert.equal(cli(['gate', '--changed', 'PROJ-42'], db).code, 1);

    const noReason = cli(['retract', run.id, '--by', by], db);
    assert.equal(noReason.code, 1);
    assert.match(noReason.err, /needs a reason/);
    const noName = cli(['retract', run.id, '--reason', 'x'], db);
    assert.equal(noName.code, 1);
    assert.match(noName.err, /needs a name/);

    const retracted = cli(['retract', run.id, '--by', by, '--reason', 'staging report'], db);
    assert.equal(retracted.code, 0, retracted.err);
    const retractionId = JSON.parse(retracted.out).id;

    const green = cli(['gate', '--changed', 'PROJ-42', '--record', '--release-ref', 'v1'], db);
    assert.equal(green.code, 0, green.out);
    assert.match(green.out, /withdrawn as recorded by mistake/);
    assert.match(green.out, /failed result refund completes — withdrawn by a\.rivera: staging report/);
    assert.match(green.out, new RegExp(`qa-spine retract ${retractionId}`));

    const check = new TraceStore(db);
    const verdict = check.list('verdict')[0];
    assert.equal(verdict.content.verdict, 'ship');
    assert.deepEqual((verdict.content.retracted as { id: string }[]).map((x) => x.id), [run.id]);
    check.close();
    assert.equal(cli(['verify'], db).code, 0);

    assert.equal(cli(['retract', retractionId, '--by', 'b.chen', '--reason', 'it was production after all'], db).code, 0);
    assert.equal(cli(['gate', '--changed', 'PROJ-42'], db).code, 1);
    assert.equal(cli(['verify'], db).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
