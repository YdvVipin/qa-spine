import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';

const human = { producer: 'human' as const };

function withDb(fn: (db: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-chain-'));
  try {
    fn(join(dir, 'trace.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A requirement, a finding derived from it, and a test covering it: three rows, two edges. */
function seed(store: TraceStore) {
  const req = store.record({ type: 'requirement', sourceRef: 'PROJ-1', content: { text: 'r' }, provenance: human });
  const finding = store.record({
    type: 'finding', content: { quote: 'r' }, provenance: human, links: [{ to: req.id, relation: 'derived_from' }],
  });
  store.transaction(() =>
    store.record({ type: 'test_case', content: { name: 't' }, provenance: human, links: [{ to: req.id, relation: 'covers' }] }),
  );
  return { req, finding };
}

/** Raw access, as someone with the file and the sqlite3 CLI would have. */
function raw(db: string, sql: string, ...params: any[]) {
  const d = new DatabaseSync(db);
  try {
    d.prepare(sql).run(...params);
  } finally {
    d.close();
  }
}

test('a store written through qa-spine verifies clean', () => {
  const store = new TraceStore(':memory:');
  seed(store);
  const r = store.verify();
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.chained, 5);
  assert.equal(r.legacy, 0);
  assert.match(r.head!, /^[0-9a-f]{64}$/);
});

test('the head changes with every write', () => {
  const store = new TraceStore(':memory:');
  seed(store);
  const before = store.verify().head;
  store.record({ type: 'requirement', content: { text: 'more' }, provenance: human });
  assert.notEqual(store.verify().head, before);
});

test('an edited row is found, even with the triggers dropped first', () => withDb((db) => {
  const { req } = seed(new TraceStore(db));
  raw(db, 'DROP TRIGGER artifacts_no_update');
  raw(db, `UPDATE artifacts SET content = '{"text":"edited"}' WHERE id = ?`, req.id);
  const r = new TraceStore(db).verify();
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, [{ kind: 'artifact', ref: req.id, problem: 'changed after it was recorded' }]);
}));

test('a deleted row is found', () => withDb((db) => {
  const { finding } = seed(new TraceStore(db));
  raw(db, 'DROP TRIGGER artifacts_no_delete');
  raw(db, 'DROP TRIGGER edges_no_delete');
  raw(db, 'DELETE FROM edges WHERE from_id = ?', finding.id);
  raw(db, 'DELETE FROM artifacts WHERE id = ?', finding.id);
  const r = new TraceStore(db).verify();
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems.map((p) => p.problem).sort(), ['deleted', 'deleted']);
}));

test('a row inserted behind qa-spine is found, triggers intact', () => withDb((db) => {
  const { finding } = seed(new TraceStore(db));
  // The quiet way to retire a question: an answer and a supersedes edge, straight into SQLite.
  raw(db, `INSERT INTO artifacts VALUES ('answer_deadbeef','answer',NULL,'{}','{"producer":"human"}','2026-09-29T00:00:00.000Z')`);
  raw(db, `INSERT INTO edges VALUES ('answer_deadbeef', ?, 'supersedes', '2026-09-29T00:00:00.000Z')`, finding.id);
  const r = new TraceStore(db).verify();
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.problems.map((p) => [p.kind, p.problem]).sort(),
    [['artifact', 'not written by qa-spine'], ['edge', 'not written by qa-spine']],
  );
}));

test('an edited chain row is found', () => withDb((db) => {
  seed(new TraceStore(db));
  raw(db, 'DROP TRIGGER chain_no_update');
  raw(db, `UPDATE chain SET hash = ? WHERE seq = 2`, '0'.repeat(64));
  assert.equal(new TraceStore(db).verify().ok, false);
}));

test('the chain table itself is append-only', () => withDb((db) => {
  seed(new TraceStore(db));
  assert.throws(() => raw(db, 'DELETE FROM chain'), /append-only/);
  assert.throws(() => raw(db, `UPDATE chain SET hash = 'x'`), /append-only/);
}));

/** A store as a qa-spine from before the chain would have left it: no chain table. */
function legacyStore(db: string) {
  const d = new DatabaseSync(db);
  d.exec(`CREATE TABLE artifacts (id TEXT PRIMARY KEY, type TEXT NOT NULL, source_ref TEXT, content TEXT NOT NULL, provenance TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE edges (from_id TEXT NOT NULL, to_id TEXT NOT NULL, relation TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (from_id, to_id, relation));
          INSERT INTO artifacts VALUES ('requirement_0000000a','requirement','OLD-1','{"text":"old"}','{"producer":"human"}','2026-01-01T00:00:00.000Z');
          INSERT INTO artifacts VALUES ('finding_0000000b','finding',NULL,'{}','{"producer":"human"}','2026-01-01T00:00:00.000Z');
          INSERT INTO edges VALUES ('finding_0000000b','requirement_0000000a','derived_from','2026-01-01T00:00:00.000Z');`);
  d.close();
}

test('a store from before the chain verifies as legacy, not as tampered', () => withDb((db) => {
  legacyStore(db);
  const r = new TraceStore(db).verify();
  assert.equal(r.ok, true);
  assert.equal(r.chained, 0);
  assert.equal(r.legacy, 3);
  assert.equal(r.head, null);
}));

test('writing to a legacy store chains the new rows and leaves the old ones legacy', () => withDb((db) => {
  legacyStore(db);
  const store = new TraceStore(db);
  store.record({ type: 'test_case', content: { name: 'new' }, provenance: human, links: [{ to: 'requirement_0000000a', relation: 'covers' }] });
  const r = store.verify();
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.legacy, 3);
  assert.equal(r.chained, 2);
}));

test('a rolled-back transaction leaves no chain rows behind', () => {
  const store = new TraceStore(':memory:');
  seed(store);
  assert.throws(() =>
    store.transaction(() => {
      store.record({ type: 'requirement', content: { text: 'x' }, provenance: human });
      throw new Error('boom');
    }),
  );
  const r = store.verify();
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.chained, 5);
});

test('a row inserted with a rowid below 1 is not mistaken for a legacy row', () => withDb((db) => {
  seed(new TraceStore(db));
  raw(db, `INSERT INTO artifacts(rowid, id, type, source_ref, content, provenance, created_at)
           VALUES (-1, 'verdict_deadbeef', 'verdict', NULL, '{}', '{"producer":"human"}', '2026-01-01T00:00:00.000Z')`);
  const r = new TraceStore(db).verify();
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, [{ kind: 'artifact', ref: 'verdict_deadbeef', problem: 'not written by qa-spine' }]);
}));

test('a row slipped into a gap in the legacy range is found', () => withDb((db) => {
  legacyStore(db);
  raw(db, `INSERT INTO artifacts(rowid, id, type, source_ref, content, provenance, created_at)
           VALUES (5, 'requirement_0000000c', 'requirement', NULL, '{}', '{"producer":"human"}', '2026-01-01T00:00:00.000Z')`);
  new TraceStore(db).record({ type: 'requirement', content: { text: 'new' }, provenance: human });
  raw(db, `INSERT INTO artifacts(rowid, id, type, source_ref, content, provenance, created_at)
           VALUES (4, 'answer_0000000d', 'answer', NULL, '{}', '{"producer":"human"}', '2026-01-01T00:00:00.000Z')`);
  const r = new TraceStore(db).verify();
  assert.equal(r.ok, false);
  assert.match(r.problems.map((p) => p.problem).join(), /added among the rows from before the chain/);
}));

test('a chain that was wiped is reported, not taken for a legacy store', () => withDb((db) => {
  seed(new TraceStore(db));
  raw(db, 'DROP TRIGGER chain_no_delete');
  raw(db, 'DELETE FROM chain');
  const r = new TraceStore(db).verify();
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, [{ kind: 'chain', ref: 'chain', problem: 'the hash chain was removed' }]);
}));

test('a first write that rolls back leaves the store unmarked, not "chain removed"', () => withDb((db) => {
  const store = new TraceStore(db);
  assert.throws(() =>
    store.transaction(() => {
      store.record({ type: 'requirement', content: { text: 'x' }, provenance: human });
      throw new Error('boom');
    }),
  );
  assert.deepEqual(store.verify(), { ok: true, chained: 0, legacy: 0, head: null, problems: [] });
}));
