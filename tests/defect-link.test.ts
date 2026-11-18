/**
 * C1: the bug is part of the record. A test run may carry `defect: {key, url?, state?}`, checked
 * on write through every path; the free-text `bug_key` RatifyQA sent before stays readable. The
 * brief and the Release page show each failure with its bug.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceStore } from '../src/trace/store.ts';
import { recordVerdict, defectOf } from '../src/release.ts';
import { renderBrief } from '../src/brief.ts';
import { releaseView } from '../src/release-view.ts';

const human = { producer: 'human' as const };

function withFailingTest() {
  const s = new TraceStore(':memory:');
  const req = s.record({ type: 'requirement', sourceRef: 'QA-2', content: { text: 'Refunds post within a day.' }, provenance: human });
  const tc = s.record({ type: 'test_case', content: { name: 'refund posts next day' }, provenance: human, links: [{ to: req.id, relation: 'covers' }] });
  const fail = (content: Record<string, unknown>) =>
    s.record({ type: 'test_run', content: { status: 'failed', ...content }, provenance: { ...human, approvedBy: 'priya' }, links: [{ to: tc.id, relation: 'verifies' }] });
  return { s, fail };
}

test('a well-formed defect is recorded and read back', () => {
  const { s, fail } = withFailingTest();
  const run = fail({ defect: { key: 'SHOP-91', url: 'https://jira.example.com/browse/SHOP-91', state: 'open' } });
  assert.deepEqual(defectOf(run), { key: 'SHOP-91', url: 'https://jira.example.com/browse/SHOP-91', state: 'open' });
  assert.equal(releaseView(s, { release: 'r', changed: ['QA-2'] }).failed[0].bug, 'SHOP-91');
});

test('a malformed defect is refused, naming the field, and nothing is written', () => {
  const { s, fail } = withFailingTest();
  const cases: [unknown, RegExp][] = [
    ['SHOP-91', /defect must be an object/],
    [{ key: 'shop 91' }, /defect\.key "shop 91" is not a Jira key/],
    [{ key: 'SHOP-91', url: 'javascript:alert(1)' }, /defect\.url must be an http\(s\) link/],
    [{ key: 'SHOP-91', state: '' }, /defect\.state/],
  ];
  for (const [defect, message] of cases) assert.throws(() => fail({ defect }), message, JSON.stringify(defect));
  assert.equal(s.list('test_run').length, 0);
});

test('the bug_key RatifyQA sent before is still read as the bug', () => {
  const { s, fail } = withFailingTest();
  const run = fail({ bug_key: 'SHOP-90' });
  assert.deepEqual(defectOf(run), { key: 'SHOP-90' });
  assert.equal(releaseView(s, { release: 'r', changed: ['QA-2'] }).failed[0].bug, 'SHOP-90');
});

test('the brief lists each failure with its bug, linked only when a link was recorded', () => {
  const { s, fail } = withFailingTest();
  fail({ defect: { key: 'SHOP-91', url: 'https://jira.example.com/browse/SHOP-91' } });
  const v = recordVerdict(s, { releaseRef: 'r1', verdict: 'hold', reason: 'The refund failure needs a fix first.', cites: [], changed: ['QA-2'], provenance: human });
  const html = renderBrief(s, v.id);
  assert.match(html, /Bug: <a href="https:\/\/jira\.example\.com\/browse\/SHOP-91" rel="noopener noreferrer">SHOP-91<\/a>/);

  const old = withFailingTest();
  old.fail({ bug_key: 'SHOP-90' });
  const v2 = recordVerdict(old.s, { releaseRef: 'r2', verdict: 'hold', reason: 'The refund failure needs a fix first.', cites: [], changed: ['QA-2'], provenance: human });
  assert.match(renderBrief(old.s, v2.id), /Bug: SHOP-90</);
});
