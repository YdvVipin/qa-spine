/**
 * D1: what the Release page shows, as data. The decision comes from the one evaluator (runGate),
 * never a second computation; the three lists say what passed, what failed, and what has no
 * evidence. A release's stories come from the link, or, once decided, from its verdict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceStore } from '../src/trace/store.ts';
import { runGate } from '../src/gate.ts';
import { ingestJunit } from '../src/junit.ts';
import { recordVerdict } from '../src/release.ts';
import { releaseView, ReleaseNotFound } from '../src/release-view.ts';

const human = { producer: 'human' as const };

/** QA-1 passes, QA-2 fails (bug BUG-7), QA-3 has a test with no result, QA-4 has no test, QA-5 has an open question. */
function seed() {
  const s = new TraceStore(':memory:');
  const story = (key: string, text: string) => s.record({ type: 'requirement', sourceRef: key, content: { text }, provenance: human });
  story('QA-1', 'Totals include tax.');
  const qa2 = story('QA-2', 'Refunds post within a day.');
  const qa3 = story('QA-3', 'Receipts are emailed.');
  story('QA-4', 'Coupons stack.');
  const qa5 = story('QA-5', 'Checkout is fast.');
  ingestJunit(s, { reports: [{ file: 'r.xml', xml: '<testsuite><testcase classname="cart" name="QA-1 total has tax"/></testsuite>' }], runRef: 'ci/1' });
  const refundTest = s.record({ type: 'test_case', content: { name: 'refund posts next day' }, provenance: human, links: [{ to: qa2.id, relation: 'covers' }] });
  s.record({ type: 'test_run', content: { status: 'failed', bug_key: 'BUG-7' }, provenance: { ...human, approvedBy: 'priya' }, links: [{ to: refundTest.id, relation: 'verifies' }] });
  s.record({ type: 'test_case', content: { name: 'receipt email arrives' }, provenance: human, links: [{ to: qa3.id, relation: 'covers' }] });
  s.record({
    type: 'finding',
    sourceRef: 'QA-5',
    content: { category: 'AMB-VAGUE-QUANT', quote: 'fast', question: 'How many seconds is fast?', confidence: 'high' },
    provenance: { producer: 'ai', model: 'm', promptVersion: 'ambiguity/1' },
    links: [{ to: qa5.id, relation: 'derived_from' }],
  });
  return s;
}

test('a ready release: Ready to ship, its passing test listed, and only Ship or Hold offered', () => {
  const v = releaseView(seed(), { release: 'shop-1.4', changed: ['QA-1'] });
  assert.equal(v.decision, 'SHIP');
  assert.equal(v.headline, 'Ready to ship');
  assert.equal(v.tone, 'ready');
  assert.deepEqual(v.passed.map((p) => [p.story, p.test, p.by]), [['QA-1', 'QA-1 total has tax', 'test report']]);
  assert.deepEqual([v.failed.length, v.missing.length], [0, 0]);
  assert.deepEqual(v.actions, { ship: true, hold: true, shipAnyway: false });
  assert.equal(v.scope.source, 'link');
});

test('a release with a failure: Not ready, the failure with its bug and who found it, Ship anyway offered', () => {
  const v = releaseView(seed(), { release: 'shop-1.5', changed: ['QA-1', 'QA-2'] });
  assert.equal(v.decision, 'HOLD');
  assert.equal(v.summary, 'Not ready: 1 test failed');
  assert.deepEqual(v.failed.map((f) => [f.story, f.what, f.bug, f.by]), [['QA-2', 'refund posts next day', 'BUG-7', 'priya']]);
  assert.equal(v.passed.length, 1);
  assert.deepEqual(v.actions, { ship: false, hold: true, shipAnyway: true });
});

test('an unanswered question is Not ready, and is listed with the question itself', () => {
  const v = releaseView(seed(), { release: 'shop-1.5', changed: ['QA-5'] });
  assert.equal(v.decision, 'HOLD');
  assert.deepEqual(v.failed.map((f) => [f.story, f.what]), [['QA-5', 'Question not answered: How many seconds is fast?']]);
});

test("missing evidence: Can't tell yet, what is missing for each story, and no way to ship", () => {
  const v = releaseView(seed(), { release: 'shop-1.6', changed: ['QA-1', 'QA-3', 'QA-4', 'QA-404'] });
  assert.equal(v.decision, 'UNKNOWN');
  assert.equal(v.headline, "Can't tell yet");
  assert.equal(v.summary, "Can't tell yet: 3 stories have no evidence");
  assert.deepEqual(
    v.missing.map((m) => [m.story, m.what]),
    [
      ['QA-3', 'receipt email arrives has no result yet'],
      ['QA-4', 'No test covers this story'],
      ['QA-404', 'This story is not in the record yet'],
    ],
  );
  assert.deepEqual(v.actions, { ship: false, hold: true, shipAnyway: false });
});

test('the decision is always the one evaluator\'s', () => {
  const s = seed();
  for (const changed of [['QA-1'], ['QA-1', 'QA-2'], ['QA-3'], ['QA-4'], ['QA-5'], ['QA-404'], ['QA-1', 'QA-2', 'QA-3']]) {
    assert.equal(releaseView(s, { release: 'r', changed }).decision, runGate(s, { changed }).decision, changed.join(','));
  }
});

test('a release nobody has decided and no link names stories for says how to open it', () => {
  assert.throws(() => releaseView(seed(), { release: 'shop-9' }), (err: unknown) => {
    assert.ok(err instanceof ReleaseNotFound);
    assert.match(String((err as Error).message), /\?release=shop-9&changed=/);
    return true;
  });
});

test('once decided, the release opens by id alone, and says what has changed since', () => {
  const s = seed();
  recordVerdict(s, { releaseRef: 'shop-1.4', verdict: 'ship', reason: 'Every story passes on this build.', cites: [], changed: ['QA-1'], provenance: { ...human, approvedBy: 'rahul' } });
  const before = releaseView(s, { release: 'shop-1.4' });
  assert.equal(before.scope.source, 'decision');
  assert.deepEqual(before.scope.changed, ['QA-1']);
  assert.equal(before.decided?.headline, 'Ready to ship');
  assert.equal(before.decided?.by, 'rahul');
  assert.equal(before.decided?.changedSince, 0);

  ingestJunit(s, { reports: [{ file: 'r.xml', xml: '<testsuite><testcase classname="cart" name="QA-1 total has tax"><failure/></testcase></testsuite>' }], runRef: 'ci/2' });
  const after = releaseView(s, { release: 'shop-1.4' });
  assert.equal(after.decided?.changedSince, 1);
  assert.equal(after.decided?.headline, 'Ready to ship', 'the recorded decision does not change');
  assert.equal(after.decision, 'HOLD', 'the evidence today does');
});

test('a hold reads as Not ready, with who held it', () => {
  const s = seed();
  recordVerdict(s, { releaseRef: 'shop-1.5', verdict: 'hold', reason: 'The refund failure needs a fix first.', cites: [], changed: ['QA-2'], provenance: { ...human, approvedBy: 'rahul' } });
  const v = releaseView(s, { release: 'shop-1.5' });
  assert.equal(v.decided?.headline, 'Not ready');
  assert.equal(v.decided?.by, 'rahul');
});
