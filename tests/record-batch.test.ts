/**
 * E5: `qa-spine record --batch` reads one JSON object per line and writes them in one process and
 * one transaction. Every line is checked as `record` checks one; any bad line names its line
 * number and nothing from the batch is written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';

const CLI = resolve('src/cli.ts');
const human = { producer: 'human' };

function withStore(fn: (db: string, reqId: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-batch-'));
  try {
    const db = join(dir, 'trace.db');
    const s = new TraceStore(db);
    const req = s.record({ type: 'requirement', sourceRef: 'QA-1', content: { text: 'Totals include tax.' }, provenance: { producer: 'human' } });
    s.close();
    fn(db, req.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function batch(db: string, lines: string[]) {
  try {
    return { code: 0, out: JSON.parse(execFileSync('node', [CLI, 'record', '--batch'], { input: lines.join('\n'), encoding: 'utf8', env: { ...process.env, QA_SPINE_DB: db } })) };
  } catch (err: any) {
    return { code: err.status as number, out: JSON.parse(err.stdout) };
  }
}
const rows = (db: string) => {
  const s = new TraceStore(db);
  const n = s.list(undefined, 1e9).length;
  s.close();
  return n;
};
const testCase = (reqId: string, i: number) => JSON.stringify({ type: 'test_case', content: { name: `case ${i}` }, provenance: human, links: [{ to: reqId, relation: 'covers' }] });

test('50 lines in one process: 50 ids back, in order, all recorded', () => {
  withStore((db, reqId) => {
    const r = batch(db, Array.from({ length: 50 }, (_, i) => testCase(reqId, i + 1)));
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.equal(r.out.ids.length, 50);
    const s = new TraceStore(db);
    assert.deepEqual(r.out.ids.map((id: string) => s.get(id)?.content.name), Array.from({ length: 50 }, (_, i) => `case ${i + 1}`));
    s.close();
    assert.equal(rows(db), 51);
  });
});

test('a bad line names its line number, and nothing from the batch is written', () => {
  withStore((db, reqId) => {
    const lines = Array.from({ length: 10 }, (_, i) => testCase(reqId, i + 1));
    lines[6] = JSON.stringify({ type: 'test_run', content: { status: 'completed' }, provenance: human });
    const r = batch(db, lines);
    assert.equal(r.code, 1);
    assert.match(r.out.error, /^line 7: test_run status "completed"/);
    assert.equal(rows(db), 1, 'the six lines before it were rolled back');
  });
});

test('a line that is not JSON, or a gated type, is refused the same way', () => {
  withStore((db, reqId) => {
    const notJson = batch(db, [testCase(reqId, 1), '', '{oops']);
    assert.equal(notJson.code, 1);
    assert.match(notJson.out.error, /^line 3: not valid JSON/);
    const gated = batch(db, [JSON.stringify({ type: 'verdict', content: {}, provenance: human })]);
    assert.match(gated.out.error, /^line 1: a verdict cannot be recorded directly/);
    assert.equal(rows(db), 1);
  });
});

test('requirements in a batch version as they do one at a time', () => {
  withStore((db) => {
    const v2 = JSON.stringify({ type: 'requirement', sourceRef: 'QA-1', content: { text: 'Totals include tax and fees.' }, provenance: human });
    const v3 = JSON.stringify({ type: 'requirement', sourceRef: 'QA-1', content: { text: 'Totals include tax, fees and tips.' }, provenance: human });
    const r = batch(db, [v2, v3]);
    assert.equal(r.code, 0, JSON.stringify(r.out));
    const s = new TraceStore(db);
    const v3Id = r.out.ids[1];
    assert.equal(s.linkedFrom(r.out.ids[0], 'supersedes', 'requirement')[0]?.id, v3Id, 'v3 supersedes v2');
    s.close();
  });
});

test('an empty batch is an error, not a silent success', () => {
  withStore((db) => {
    const r = batch(db, ['', '  ']);
    assert.equal(r.code, 1);
    assert.match(r.out.error, /no lines/);
  });
});
