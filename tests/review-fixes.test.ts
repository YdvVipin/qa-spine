import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';
import { requirementStatus } from '../src/release.ts';
import { recordAnswer } from '../src/audit.ts';
import { validateFixture, loadLocale } from '../src/fixtures.ts';
import { renderCsv } from '../src/export.ts';

const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-haiku-4-5', promptVersion: 'ambiguity/1' };

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-rf-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1. readiness and export follow the same human-answers policy as the gate
test('requirementStatus applies the human-answers policy, so it cannot contradict the gate', () => {
  const store = new TraceStore(':memory:');
  const req = store.record({ type: 'requirement', sourceRef: 'PROJ-9', content: { text: 'r' }, provenance: human });
  const tc = store.record({ type: 'test_case', content: { name: 't' }, provenance: human, links: [{ to: req.id, relation: 'covers' }] });
  store.record({ type: 'test_run', content: { status: 'passed' }, provenance: human, links: [{ to: tc.id, relation: 'verifies' }] });
  const finding = store.record({ type: 'finding', content: { question: 'q?' }, provenance: ai, links: [{ to: req.id, relation: 'derived_from' }] });
  recordAnswer(store, { findingId: finding.id, answer: 'AI says so.', provenance: ai });
  assert.equal(requirementStatus(store)[0].status, 'clear');
  const [row] = requirementStatus(store, undefined, { requireHumanAnswers: true });
  assert.deepEqual([row.status, row.open], ['blocked', 1]);
});

// 2. rows written in the same millisecond keep their order
test('list() breaks created_at ties by write order, and merge keeps that order', () => withDir((dir) => {
  const src = join(dir, 'src.db');
  new TraceStore(src).close();
  const d = new DatabaseSync(src);
  for (let i = 1; i <= 5; i++) {
    d.prepare('INSERT INTO artifacts VALUES (?, ?, NULL, ?, ?, ?)').run(`requirement_0000000${i}`, 'requirement', `{"text":"r${i}"}`, '{"producer":"human"}', '2026-01-01T00:00:00.000Z');
  }
  d.close();
  const order = (s: TraceStore) => s.list(undefined, 1e9).map((a) => a.content.text);
  assert.deepEqual(order(new TraceStore(src)), ['r5', 'r4', 'r3', 'r2', 'r1']);
  const target = new TraceStore(join(dir, 'target.db'));
  target.mergeFrom(src);
  assert.deepEqual(order(target), ['r5', 'r4', 'r3', 'r2', 'r1']);
}));

// 3. the gate only suggests what would actually unblock it
function gate(args: string[], db: string) {
  try {
    return execFileSync('node', ['src/server.ts', 'gate', ...args], { encoding: 'utf8', env: { ...process.env, QA_SPINE_DB: db } });
  } catch (err: any) {
    return err.stdout as string;
  }
}
test('the override hint appears only when an override would unblock, and warnings stay warnings', () => withDir((dir) => {
  const db = join(dir, 'trace.db');
  const store = new TraceStore(db);
  const req = store.record({ type: 'requirement', sourceRef: 'PROJ-1', content: { text: 'r' }, provenance: human });
  store.record({ type: 'finding', content: { question: 'How quick?' }, provenance: ai, links: [{ to: req.id, relation: 'derived_from' }] });
  store.close();
  const warnOnly = gate(['--changed', 'PROJ-1'], db);
  assert.match(warnOnly, /To ship anyway/, 'an open question alone: an override does unblock');
  assert.match(warnOnly, /1 changed requirement has no tests\*\*:/, 'untested is a warning here');
  assert.doesNotMatch(warnOnly, /add a test to clear/);
  const coverage = gate(['--changed', 'PROJ-1', '--require-coverage'], db);
  assert.match(coverage, /add a test to clear; an override does not/);
  assert.doesNotMatch(coverage, /To ship anyway/, 'an override cannot clear missing coverage');
}));

// 4. inherited object keys are not fields
test('built-in object key names are not mistaken for fields', () => {
  const de = loadLocale('de-DE');
  const closed = { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } };
  assert.equal(validateFixture(closed, JSON.parse('{"id":"x","constructor":1}'), de).length, 1);
  assert.equal(validateFixture({ type: 'object', required: ['toString'] }, {}, de).length, 1);
});

// 5. every CSV cell is quoted, and a formula is defused
test('CSV quotes every text cell and defuses spreadsheet formulas', () => {
  const row = { requirementId: 'r', sourceRef: 'docs/a,b.md', text: '=HYPERLINK("x")', status: 'clear' as const, open: 0, answered: 0, assumptions: 0, tests: 1, failing: 0, flaky: 0, suspect: false, untested: false };
  const line = renderCsv([row]).trim().split('\n')[1];
  assert.equal(line, `"docs/a,b.md",clear,0,0,0,1,0,0,no,no,"'=HYPERLINK(""x"")"`);
});
