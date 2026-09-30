import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';
import { rubricReport, renderRubricReport } from '../src/audit.ts';

const human = { producer: 'human' as const };
const ai = (promptVersion: string, model = 'claude-haiku-4-5') => ({ producer: 'ai' as const, model, promptVersion });

function finding(store: TraceStore, reqId: string, category: string, provenance: ReturnType<typeof ai>) {
  return store.record({ type: 'finding', content: { category, quote: 'q', question: 'q?' }, provenance, links: [{ to: reqId, relation: 'derived_from' }] });
}
const review = (store: TraceStore, id: string, verdict: 'good' | 'bad') =>
  store.record({ type: 'review', content: { verdict, note: '' }, provenance: human, links: [{ to: id, relation: 'reviews' }] });

function seed() {
  const store = new TraceStore(':memory:');
  const req = store.record({ type: 'requirement', content: { text: 'r' }, provenance: human });
  const a = finding(store, req.id, 'AMB-VAGUE-QUANT', ai('ambiguity/1'));
  const b = finding(store, req.id, 'AMB-VAGUE-QUANT', ai('ambiguity/1'));
  finding(store, req.id, 'AMB-VAGUE-QUANT', ai('ambiguity/1')); // never reviewed
  const c = finding(store, req.id, 'AMB-VAGUE-QUANT', ai('ambiguity/2'));
  review(store, a.id, 'good');
  review(store, b.id, 'good');
  review(store, b.id, 'bad'); // changed their mind: the latest review counts
  review(store, c.id, 'good');
  store.record({ type: 'audit', content: { findings: 0 }, provenance: ai('ambiguity/2'), links: [{ to: req.id, relation: 'derived_from' }] });
  return store;
}

test('findings are counted per rubric version, model and rule, with the latest review each', () => {
  const { rows } = rubricReport(seed());
  const v1 = rows.find((r) => r.promptVersion === 'ambiguity/1')!;
  assert.deepEqual(
    { findings: v1.findings, reviewed: v1.reviewed, good: v1.good, bad: v1.bad, precision: v1.precision },
    { findings: 3, reviewed: 2, good: 1, bad: 1, precision: 0.5 },
  );
  assert.equal(v1.model, 'claude-haiku-4-5');
  assert.equal(v1.rule, 'AMB-VAGUE-QUANT');
  assert.equal(rows.find((r) => r.promptVersion === 'ambiguity/2')!.precision, 1);
});

test('clean audits are counted per version, as the true negatives', () => {
  assert.deepEqual(rubricReport(seed()).cleanAudits, [{ promptVersion: 'ambiguity/2', model: 'claude-haiku-4-5', count: 1 }]);
});

test('precision is null, not zero, when nothing was reviewed', () => {
  const store = new TraceStore(':memory:');
  const req = store.record({ type: 'requirement', content: { text: 'r' }, provenance: human });
  finding(store, req.id, 'AMB-OPEN-LIST', ai('ambiguity/1'));
  assert.equal(rubricReport(store).rows[0].precision, null);
});

test('the Markdown report is a table a person can compare versions in', () => {
  const md = renderRubricReport(rubricReport(seed()));
  assert.match(md, /\| ambiguity\/1 \| claude-haiku-4-5 \| AMB-VAGUE-QUANT \| 3 \| 2 \| 1 \| 1 \| 50% \|/);
  assert.match(md, /\| ambiguity\/2 \| claude-haiku-4-5 \| AMB-VAGUE-QUANT \| 1 \| 1 \| 1 \| 0 \| 100% \|/);
  assert.match(md, /ambiguity\/2.*1 clean audit/);
});

test('qa-spine rubric-report prints the table, and --json the data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-rubric-'));
  try {
    const db = join(dir, 'trace.db');
    const store = new TraceStore(db);
    const req = store.record({ type: 'requirement', content: { text: 'r' }, provenance: human });
    review(store, finding(store, req.id, 'AMB-OPEN-LIST', ai('ambiguity/1')).id, 'bad');
    store.close();
    const run = (args: string[]) => execFileSync('node', ['src/server.ts', 'rubric-report', ...args], { encoding: 'utf8', env: { ...process.env, QA_SPINE_DB: db } });
    assert.match(run([]), /\| ambiguity\/1 \| claude-haiku-4-5 \| AMB-OPEN-LIST \| 1 \| 1 \| 0 \| 1 \| 0% \|/);
    assert.equal(JSON.parse(run(['--json'])).rows[0].bad, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the ambiguity/2 candidate loads, keeps every v1 rule as it was, and adds the new ones', async () => {
  const { loadRubric } = await import('../src/audit.ts');
  const v1 = loadRubric();
  const v2 = loadRubric('candidates/ambiguity-2');
  assert.equal(v2.version, 'ambiguity/2');
  for (const rule of v1.rules) assert.deepEqual(v2.rules.find((r) => r.id === rule.id), rule, rule.id);
  const added = v2.rules.map((r) => r.id).filter((id) => !v1.rules.some((r) => r.id === id));
  assert.deepEqual(added.sort(), ['AMB-CONTRADICTION', 'AMB-DATA-RULE', 'AMB-MISSING-ERROR-PATH', 'AMB-PERMISSION', 'AMB-UNSTATED-CLOCK']);
});
