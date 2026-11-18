/**
 * E3: an automated run recorded with producer "tool" is shown as automated, not as typed in by a
 * person. The 0.4 rule is unchanged: such a pass counts only with a name in approvedBy (or when it
 * arrives through ingest-junit, whose tool name a raw write cannot claim).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceStore, assertRawRecordAllowed } from '../src/trace/store.ts';
import { releaseView } from '../src/release-view.ts';

const robot = { producer: 'tool' as const, tool: 'ratifyqa-runner', toolVersion: '1.2.0' };

function withTest(status: string, provenance: Record<string, unknown>) {
  const s = new TraceStore(':memory:');
  const req = s.record({ type: 'requirement', sourceRef: 'QA-1', content: { text: 'Totals include tax.' }, provenance: { producer: 'human' } });
  const tc = s.record({ type: 'test_case', content: { name: 'total has tax' }, provenance: robot, links: [{ to: req.id, relation: 'covers' }] });
  const run = { type: 'test_run' as const, content: { status }, provenance: provenance as any, links: [{ to: tc.id, relation: 'verifies' as const }] };
  assertRawRecordAllowed(s, run);
  s.record(run);
  return releaseView(s, { release: 'r', changed: ['QA-1'] });
}

test('a raw write may say it came from a tool, but never claim to be qa-spine\'s own ingest', () => {
  const s = new TraceStore(':memory:');
  assert.doesNotThrow(() => assertRawRecordAllowed(s, { type: 'test_run', provenance: robot }));
  assert.throws(() => assertRawRecordAllowed(s, { type: 'test_run', provenance: { tool: 'qa-spine ingest-junit' } }), /reserved/);
});

test('an automated pass with nobody named does not count, and the page says it was automated', () => {
  const v = withTest('passed', robot);
  assert.equal(v.decision, 'UNKNOWN');
  assert.deepEqual(v.missing.map((m) => m.what), ['total has tax passed in an automated run (ratifyqa-runner), but no test report or named person backs it']);
});

test('an automated failure counts, and is shown as found by the automated run', () => {
  const v = withTest('failed', robot);
  assert.equal(v.decision, 'HOLD');
  assert.equal(v.failed[0].by, 'automated run (ratifyqa-runner)');
});

test('an automated pass someone vouches for counts, and names them', () => {
  const v = withTest('passed', { ...robot, approvedBy: 'priya' });
  assert.equal(v.decision, 'SHIP');
  assert.equal(v.passed[0].by, 'priya');
});
