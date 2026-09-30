import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore, recordRequirement } from '../src/trace/store.ts';

const human = { producer: 'human' as const };
const req = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'requirement' as const,
  sourceRef: 'PROJ-42',
  content: { text, ...extra },
  provenance: human,
});
const supersedes = (store: TraceStore, id: string) =>
  store.edgesFrom(id).filter((e) => e.relation === 'supersedes').map((e) => e.toArtifactId).sort();

test('recording the same requirement twice writes it once', () => {
  const store = new TraceStore(':memory:');
  const first = recordRequirement(store, req('Refunds are quick.', { summary: 's' }));
  // Same content, keys in a different order.
  const again = recordRequirement(store, { ...req('x'), content: { summary: 's', text: 'Refunds are quick.' } });
  assert.equal(again.id, first.id);
  assert.equal(store.list('requirement').length, 1);
});

test('an edited requirement supersedes the version before it', () => {
  const store = new TraceStore(':memory:');
  const v1 = recordRequirement(store, req('Refunds are quick.'));
  const v2 = recordRequirement(store, req('Refunds complete within 3 business days.'));
  assert.notEqual(v2.id, v1.id);
  assert.deepEqual(supersedes(store, v2.id), [v1.id]);
  const v3 = recordRequirement(store, req('Refunds complete within 2 business days.'));
  assert.deepEqual(supersedes(store, v3.id), [v2.id], 'only the current version, not the whole history');
});

test('an edit folds legacy duplicates into one line', () => {
  const store = new TraceStore(':memory:');
  const a = store.record(req('Refunds are quick.'));
  const b = store.record(req('Refunds are quick.'));
  const next = recordRequirement(store, req('Refunds complete within 3 business days.'));
  assert.deepEqual(supersedes(store, next.id), [a.id, b.id].sort());
});

test('going back to earlier wording is still a new version', () => {
  const store = new TraceStore(':memory:');
  recordRequirement(store, req('A.'));
  const v2 = recordRequirement(store, req('B.'));
  const v3 = recordRequirement(store, req('A.'));
  assert.deepEqual(supersedes(store, v3.id), [v2.id]);
});

test('a requirement with no sourceRef is recorded as before', () => {
  const store = new TraceStore(':memory:');
  recordRequirement(store, { ...req('A.'), sourceRef: undefined });
  recordRequirement(store, { ...req('A.'), sourceRef: undefined });
  assert.equal(store.list('requirement').length, 2);
});

test('the CLI record subcommand versions requirements', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-versions-'));
  try {
    const db = join(dir, 'trace.db');
    const record = (payload: unknown) =>
      JSON.parse(execFileSync('node', ['src/server.ts', 'record'], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, QA_SPINE_DB: db } }));
    const v1 = record(req('Refunds are quick.'));
    assert.equal(record(req('Refunds are quick.')).id, v1.id);
    const v2 = record(req('Refunds complete within 3 business days.'));
    assert.deepEqual(supersedes(new TraceStore(db), v2.id), [v1.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
