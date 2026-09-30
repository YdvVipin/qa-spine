import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { TraceStore, recordRequirement } from '../src/trace/store.ts';
import { assessReleaseRisk, recordVerdict, requirementStatus } from '../src/release.ts';
import { renderBrief } from '../src/brief.ts';
import { createInspector } from '../src/inspector/server.ts';

const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-haiku-4-5', promptVersion: 'ambiguity/1' };

/**
 * PROJ-1: tested, passing, one open question. PROJ-2: no test at all. PROJ-3: edited since its
 * audit, with a failing test on the old version. PROJ-4: clean.
 */
function seed(store: TraceStore) {
  const r1 = store.record({ type: 'requirement', sourceRef: 'PROJ-1', content: { text: 'Refunds are quick.' }, provenance: human });
  store.record({ type: 'finding', content: { category: 'AMB-VAGUE-QUANT', quote: 'quick', question: 'How quick?' }, provenance: ai, links: [{ to: r1.id, relation: 'derived_from' }] });
  const t1 = store.record({ type: 'test_case', content: { name: 'refund speed' }, provenance: human, links: [{ to: r1.id, relation: 'covers' }] });
  store.record({ type: 'test_run', content: { status: 'passed' }, provenance: human, links: [{ to: t1.id, relation: 'verifies' }] });

  store.record({ type: 'requirement', sourceRef: 'PROJ-2', content: { text: 'Receipts are emailed.' }, provenance: human });

  const r3 = recordRequirement(store, { type: 'requirement', sourceRef: 'PROJ-3', content: { text: 'Old wording.' }, provenance: human });
  const t3 = store.record({ type: 'test_case', content: { name: 'old behaviour' }, provenance: human, links: [{ to: r3.id, relation: 'covers' }] });
  store.record({ type: 'test_run', content: { status: 'failed' }, provenance: human, links: [{ to: t3.id, relation: 'verifies' }] });
  recordRequirement(store, { type: 'requirement', sourceRef: 'PROJ-3', content: { text: 'New wording.' }, provenance: human });

  const r4 = store.record({ type: 'requirement', sourceRef: 'PROJ-4', content: { text: 'Clean.' }, provenance: human });
  const t4 = store.record({ type: 'test_case', content: { name: 'clean' }, provenance: human, links: [{ to: r4.id, relation: 'covers' }] });
  store.record({ type: 'test_run', content: { status: 'passed' }, provenance: human, links: [{ to: t4.id, relation: 'verifies' }] });
}

test('a changed requirement no test covers, in any version, is untested', () => {
  const store = new TraceStore(':memory:');
  seed(store);
  const { untested } = assessReleaseRisk(store, { changed: ['PROJ-1', 'PROJ-2', 'PROJ-3'] });
  assert.deepEqual(untested.map((u) => u.sourceRef), ['PROJ-2']);
});

test('a verdict records untested areas and the brief names them', () => {
  const store = new TraceStore(':memory:');
  seed(store);
  const v = recordVerdict(store, { releaseRef: 'r', verdict: 'hold', reason: 'Checking.', cites: [], changed: ['PROJ-2'], provenance: human });
  assert.deepEqual(v.content.untested, ['PROJ-2']);
  assert.match(renderBrief(store, v.id), /Changed areas with no tests/);
});

test('requirementStatus gives one row per current requirement, worst first', () => {
  const store = new TraceStore(':memory:');
  seed(store);
  const rows = requirementStatus(store);
  assert.deepEqual(rows.map((r) => [r.sourceRef, r.status]), [
    ['PROJ-1', 'blocked'],
    ['PROJ-3', 'blocked'],
    ['PROJ-2', 'warning'],
    ['PROJ-4', 'clear'],
  ]);
  const p3 = rows.find((r) => r.sourceRef === 'PROJ-3')!;
  assert.deepEqual({ suspect: p3.suspect, failing: p3.failing, tests: p3.tests, text: p3.text }, { suspect: true, failing: 1, tests: 1, text: 'New wording.' });
  const p1 = rows.find((r) => r.sourceRef === 'PROJ-1')!;
  assert.deepEqual({ open: p1.open, untested: p1.untested }, { open: 1, untested: false });
});

test('requirementStatus limited to changed refs covers only those', () => {
  const store = new TraceStore(':memory:');
  seed(store);
  assert.deepEqual(requirementStatus(store, ['PROJ-4', 'src/unknown.ts']).map((r) => r.sourceRef), ['PROJ-4']);
});

test('the Inspector serves readiness for all requirements, or for the changed refs given', async (t: TestContext) => {
  const store = new TraceStore(':memory:');
  seed(store);
  const server = createInspector(store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await (await fetch(`${base}/api/readiness`)).json()).rows.length, 4);
  const some = await (await fetch(`${base}/api/readiness?changed=PROJ-2,PROJ-4`)).json();
  assert.deepEqual(some.rows.map((r: any) => r.sourceRef), ['PROJ-2', 'PROJ-4']);
});

// --- the CLI ---

function withDb(fn: (db: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-cov-'));
  try {
    const db = join(dir, 'trace.db');
    const store = new TraceStore(db);
    seed(store);
    store.close();
    fn(db);
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

test('the gate reports untested areas as a warning; --require-coverage blocks', () => withDb((db) => {
  const plain = cli(['gate', '--changed', 'PROJ-2'], db);
  assert.equal(plain.code, 0);
  assert.match(plain.out, /1 changed requirement has no tests/);
  assert.equal(cli(['gate', '--changed', 'PROJ-2', '--require-coverage'], db).code, 1);
  assert.equal(cli(['gate', '--changed', 'PROJ-2', '--require-coverage', '--override-reason', 'x', '--approved-by', 'y'], db).code, 1, 'only a test clears it');
  assert.equal(cli(['gate', '--changed', 'PROJ-4', '--require-coverage'], db).code, 0);
}));

test('export --format csv is a traceability matrix, one row per requirement', () => withDb((db) => {
  const lines = cli(['export', '--format', 'csv'], db).out.trim().split('\n');
  assert.equal(lines[0], 'ref,status,open_questions,answered,assumptions,tests,failing,flaky,suspect,untested,text');
  assert.equal(lines.length, 5);
  assert.ok(lines.some((l) => l.startsWith('"PROJ-3",blocked,0,0,0,1,1,0,yes,no,"New wording."')), lines.join('\n'));
}));

test('export --format html is self-contained: no script, no external request', () => withDb((db) => {
  const html = cli(['export', '--format', 'html'], db).out;
  assert.match(html, /<table/);
  assert.match(html, /PROJ-2/);
  assert.doesNotMatch(html, /<script|https?:\/\//i);
}));

test('export --format jsonl dumps every artifact and edge', () => withDb((db) => {
  const lines = cli(['export', '--format', 'jsonl'], db).out.trim().split('\n').map((l) => JSON.parse(l));
  const store = new TraceStore(db);
  assert.equal(lines.filter((l) => l.kind === 'artifact').length, store.list(undefined, 1e9).length);
  assert.ok(lines.some((l) => l.kind === 'edge' && l.relation === 'covers'));
}));

test('export with an unknown format is refused', () => withDb((db) => {
  assert.equal(cli(['export', '--format', 'pdf'], db).code, 1);
}));
