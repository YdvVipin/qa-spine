import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';

function verify(db: string) {
  try {
    return { code: 0, out: execFileSync('node', ['src/server.ts', 'verify'], { encoding: 'utf8', env: { ...process.env, QA_SPINE_DB: db } }), err: '' };
  } catch (err: any) {
    return { code: err.status, out: err.stdout as string, err: err.stderr as string };
  }
}

function withDir(fn: (db: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-spine-verify-'));
    try {
      await fn(join(dir, 'trace.db'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('verify exits 0 on an intact store and prints the head', withDir((db) => {
  new TraceStore(db).record({ type: 'requirement', content: { text: 'r' }, provenance: { producer: 'human' } });
  const { code, out } = verify(db);
  assert.equal(code, 0);
  const r = JSON.parse(out);
  assert.equal(r.ok, true);
  assert.match(r.head, /^[0-9a-f]{64}$/);
}));

test('verify exits 1 and names the problem on a tampered store', withDir((db) => {
  const req = new TraceStore(db).record({ type: 'requirement', content: { text: 'r' }, provenance: { producer: 'human' } });
  const d = new DatabaseSync(db);
  d.exec('DROP TRIGGER artifacts_no_update');
  d.prepare(`UPDATE artifacts SET content = '{"text":"x"}' WHERE id = ?`).run(req.id);
  d.close();
  const { code, out } = verify(db);
  assert.equal(code, 1);
  assert.equal(JSON.parse(out).problems[0].ref, req.id);
}));

test('verify on a store that does not exist exits 2 and creates nothing', withDir((db) => {
  const { code, err } = verify(db);
  assert.equal(code, 2);
  assert.match(err, /no trace store/);
  assert.throws(() => new DatabaseSync(db, { readOnly: true }));
}));

test('concurrent writers leave a chain that verifies', withDir(async (db) => {
  new TraceStore(db).close(); // create the schema once, so the writers only race on writes
  const write = (i: number) =>
    new Promise<void>((resolve, reject) => {
      const child = execFile('node', ['src/server.ts', 'record'], { env: { ...process.env, QA_SPINE_DB: db } }, (err) =>
        err ? reject(err) : resolve(),
      );
      child.stdin!.end(JSON.stringify({ type: 'requirement', content: { text: `r${i}` }, provenance: { producer: 'human' } }));
    });
  await Promise.all(Array.from({ length: 8 }, (_, i) => write(i)));
  const { code, out } = verify(db);
  assert.equal(code, 0, out);
  assert.equal(JSON.parse(out).chained, 8);
}));
