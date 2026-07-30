import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceStore } from '../src/trace/store.ts';

const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-opus-5', promptVersion: 'ambiguity/1' };

test('bySourceRef returns artifacts matching the given refs', () => {
  const store = new TraceStore(':memory:');
  const req = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-42',
    content: { text: 'Refunds must be processed quickly.' },
    provenance: human,
  });
  store.record({
    type: 'requirement',
    sourceRef: 'PROJ-99',
    content: { text: 'Unrelated requirement.' },
    provenance: human,
  });

  const found = store.bySourceRef(['PROJ-42', 'src/never-seen.ts']);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, req.id);
});

test('bySourceRef returns [] for an empty ref list instead of throwing', () => {
  const store = new TraceStore(':memory:');
  // `IN ()` is a SQLite syntax error, so the guard is load-bearing.
  assert.deepEqual(store.bySourceRef([]), []);
});
