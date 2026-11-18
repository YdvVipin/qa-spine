/**
 * D1: the Release page as a release manager reads it. renderRelease is a pure function of the
 * view, so its text can be checked here: one sentence, three lists, plain words, and nothing an
 * engineer would recognise as an id, a relation, a status code or a reason code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceStore } from '../src/trace/store.ts';
import { ingestJunit } from '../src/junit.ts';
import { recordVerdict, REASONS } from '../src/release.ts';
import { RUN_STATUSES, Relation } from '../src/trace/schema.ts';
import { releaseView } from '../src/release-view.ts';
// @ts-ignore: plain browser JavaScript, no types
import { renderRelease, previewText } from '../src/inspector/ui/release.js';

const human = { producer: 'human' as const };

function seed(title = 'Refunds post within a day.') {
  const s = new TraceStore(':memory:');
  const story = (key: string, text: string) => s.record({ type: 'requirement', sourceRef: key, content: { text }, provenance: human });
  story('QA-1', 'Totals include tax.');
  const qa2 = story('QA-2', title);
  const qa3 = story('QA-3', 'Receipts are emailed.');
  ingestJunit(s, { reports: [{ file: 'r.xml', xml: '<testsuite><testcase classname="cart" name="QA-1 total has tax"/></testsuite>' }], runRef: 'ci/1' });
  const refund = s.record({ type: 'test_case', content: { name: 'refund posts next day' }, provenance: human, links: [{ to: qa2.id, relation: 'covers' }] });
  s.record({ type: 'test_run', content: { status: 'failed', bug_key: 'BUG-7' }, provenance: { ...human, approvedBy: 'priya' }, links: [{ to: refund.id, relation: 'verifies' }] });
  s.record({ type: 'test_case', content: { name: 'receipt email arrives' }, provenance: human, links: [{ to: qa3.id, relation: 'covers' }] });
  return s;
}

function states() {
  const s = seed();
  const ready = releaseView(s, { release: 'shop-1.4', changed: ['QA-1'] });
  const notReady = releaseView(s, { release: 'shop-1.5', changed: ['QA-1', 'QA-2'] });
  const cantTell = releaseView(s, { release: 'shop-1.6', changed: ['QA-1', 'QA-3', 'QA-404'] });
  recordVerdict(s, {
    releaseRef: 'shop-1.7', verdict: 'ship', reason: 'Refund fix ships next week; low volume.', cites: [], changed: ['QA-1', 'QA-2'],
    override: { reason: 'Refund fix ships next week; low volume.', defects: ['BUG-7'] }, provenance: { ...human, approvedBy: 'rahul' },
  });
  const shippedAnyway = releaseView(s, { release: 'shop-1.7' });
  return { ready, notReady, cantTell, shippedAnyway };
}

/** What a reader sees: tags out, entities decoded. */
const textOf = (html: string) =>
  html.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

test('each state opens on its sentence, in its colour', () => {
  const { ready, notReady, cantTell, shippedAnyway } = states();
  const cases: [any, RegExp, string][] = [
    [ready, /Ready to ship: 1 test passed, nothing missing/, 'tone-ready'],
    [notReady, /Not ready: 1 test failed/, 'tone-not-ready'],
    [cantTell, /Can't tell yet: 2 stories have no evidence/, 'tone-cant-tell'],
    [shippedAnyway, /Shipped anyway/, 'tone-shipped-anyway'],
  ];
  for (const [view, sentence, tone] of cases) {
    const html = renderRelease(view);
    assert.match(textOf(html), sentence);
    assert.ok(html.includes(tone), tone);
  }
});

test('the page text carries no ids, relation names, status codes or reason codes', () => {
  const banned = [
    /\b[a-z]+(?:_[a-z]+)?_[0-9a-f]{8}\b/, // artifact ids
    new RegExp(`\\b(${Relation.options.join('|')})\\b`),
    new RegExp(`\\b(${RUN_STATUSES.filter((s) => s.includes('_')).join('|')})\\b`),
    new RegExp(`\\b(${REASONS.join('|')})\\b`),
    /\b(SHIP|HOLD|UNKNOWN|OVERRIDDEN|test_run|test_case|sourceRef|approvedBy)\b/,
  ];
  for (const [name, view] of Object.entries(states())) {
    const text = textOf(renderRelease(view));
    for (const b of banned) assert.doesNotMatch(text, b, `${name}: ${text.match(b)?.[0]}`);
  }
});

test('three lists, each with a count; the failure shows its bug and who found it', () => {
  const text = textOf(renderRelease(states().notReady));
  assert.match(text, /Failed \(1\)/);
  assert.match(text, /No evidence \(0\)/);
  assert.match(text, /Passed \(1\)/);
  assert.match(text, /refund posts next day/);
  assert.match(text, /bug BUG-7/);
  assert.match(text, /found by priya/);
});

test('only the decisions the release allows are offered', () => {
  const { ready, notReady, cantTell } = states();
  const offered = (v: any) => [...renderRelease(v).matchAll(/data-action="([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(offered(ready), ['ship', 'hold']);
  assert.deepEqual(offered(notReady), ['hold', 'ship_anyway']);
  assert.deepEqual(offered(cantTell), ['hold']);
  assert.match(textOf(renderRelease(cantTell)), /cannot be shipped until every story has evidence/);
  assert.doesNotMatch(textOf(renderRelease(cantTell)), /Ship anyway/, 'not mentioned where it is not offered');
});

test('a refusal and a recorded decision use separate lines: an alert for one, a status for the other', () => {
  const html = renderRelease(states().ready);
  assert.match(html, /<p class="error" role="alert"><\/p>/);
  assert.match(html, /<p class="done" role="status"><\/p>/);
});

test('the page says a typed name is not a sign-in, and links to the evidence', () => {
  const html = renderRelease(states().ready);
  assert.match(textOf(html), /recorded as you type it/);
  assert.match(html, /href="\/#\/"[^>]*>Evidence</);
});

test('a decided release shows who decided, when, and what changed since', () => {
  const text = textOf(renderRelease(states().shippedAnyway));
  assert.match(text, /Decided on \d{1,2} [A-Z][a-z]{2} \d{4} by rahul: Shipped anyway/);
  assert.match(text, /Nothing has changed since|has changed since|have changed since/);
  assert.match(text, /BUG-7/);
});

test('story text is escaped, never run as HTML', () => {
  const s = seed('<img src=x onerror="alert(1)"> refunds');
  const html = renderRelease(releaseView(s, { release: '<b>r</b>', changed: ['QA-2'] }));
  assert.doesNotMatch(html, /<img|<b>r<\/b>/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test('before confirming, the page says exactly what will be recorded', () => {
  const { notReady } = states();
  const p = previewText('ship_anyway', { name: 'rahul', reason: 'Refund fix ships next week; low volume.', defects: ['BUG-7'] }, notReady);
  assert.match(p, /Shipped anyway/);
  assert.match(p, /rahul/);
  assert.match(p, /Refund fix ships next week; low volume\./);
  assert.match(p, /BUG-7/);
  assert.match(p, /refund posts next day/);
  assert.match(previewText('hold', { name: 'rahul', reason: '' }, notReady), /Not ready, held by rahul/);
});
