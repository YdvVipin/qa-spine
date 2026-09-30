import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';

const human = { producer: 'human' as const };

/** A shared base, copied to two stores that each then record something of their own. */
function diverged(dir: string) {
  const a = join(dir, 'a.db');
  const b = join(dir, 'b.db');
  const base = new TraceStore(a);
  const req = base.record({ type: 'requirement', sourceRef: 'PROJ-1', content: { text: 'r' }, provenance: human });
  base.close();
  copyFileSync(a, b);
  const sa = new TraceStore(a);
  sa.record({ type: 'test_case', content: { name: 'from a' }, provenance: human, links: [{ to: req.id, relation: 'covers' }] });
  const sb = new TraceStore(b);
  const onlyB = sb.record({ type: 'test_case', content: { name: 'from b' }, provenance: human, links: [{ to: req.id, relation: 'covers' }] });
  sb.close();
  return { a: sa, b, req, onlyB };
}

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-merge-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('merging a diverged store brings in what it has and this one lacks, ids and times intact', () => withDir((dir) => {
  const { a, b, req, onlyB } = diverged(dir);
  const result = a.mergeFrom(b);
  assert.deepEqual(result, { artifacts: 1, edges: 1 });
  const copied = a.get(onlyB.id)!;
  assert.deepEqual(copied, onlyB);
  assert.deepEqual(a.edgesFrom(onlyB.id).map((e) => [e.toArtifactId, e.relation]), [[req.id, 'covers']]);
  assert.equal(a.list('test_case').length, 2);
  const v = a.verify();
  assert.equal(v.ok, true, JSON.stringify(v.problems));
}));

test('merging the same store twice adds nothing the second time', () => withDir((dir) => {
  const { a, b } = diverged(dir);
  a.mergeFrom(b);
  const before = a.list(undefined, 1e9).length;
  assert.deepEqual(a.mergeFrom(b), { artifacts: 0, edges: 0 });
  assert.equal(a.list(undefined, 1e9).length, before);
}));

test('a store that fails verification is refused and nothing is merged', () => withDir((dir) => {
  const { a, b, onlyB } = diverged(dir);
  const d = new DatabaseSync(b);
  d.exec('DROP TRIGGER artifacts_no_update');
  d.prepare(`UPDATE artifacts SET content = '{"name":"edited"}' WHERE id = ?`).run(onlyB.id);
  d.close();
  const before = a.list(undefined, 1e9).length;
  assert.throws(() => a.mergeFrom(b), /failed verification/);
  assert.equal(a.list(undefined, 1e9).length, before);
}));

test('the same id with different content in each store is a conflict, and nothing is merged', () => withDir((dir) => {
  const { a, b, req } = diverged(dir);
  // Reachable only by hand-building a store: a legacy row (no chain, so it verifies) that
  // reuses the shared requirement's id with other content.
  const c = join(dir, 'c.db');
  const sc = new TraceStore(c);
  sc.close();
  const d = new DatabaseSync(c);
  d.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?)').run(req.id, 'requirement', 'PROJ-1', '{"text":"different"}', '{"producer":"human"}', req.createdAt);
  d.close();
  const before = a.list(undefined, 1e9).length;
  assert.throws(() => a.mergeFrom(c), new RegExp(`${req.id}.*differs`));
  assert.equal(a.list(undefined, 1e9).length, before);
  void b;
}));

test('qa-spine merge prints what it brought in; a missing file is refused', () => withDir((dir) => {
  const { a, b } = diverged(dir);
  a.close();
  const run = (args: string[]) => {
    try {
      return { code: 0, out: execFileSync('node', ['src/server.ts', 'merge', ...args], { encoding: 'utf8', env: { ...process.env, QA_SPINE_DB: join(dir, 'a.db') } }), err: '' };
    } catch (err: any) {
      return { code: err.status as number, out: err.stdout as string, err: err.stderr as string };
    }
  };
  const ok = run([b]);
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(ok.out), { artifacts: 1, edges: 1 });
  const missing = run([join(dir, 'nope.db')]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no trace store at/);
}));
