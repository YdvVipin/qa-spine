/**
 * D4 / B3: one vocabulary. The JSON keeps the codes; every screen a person reads (the gate
 * summary, the brief, the Release page) says Ready to ship, Not ready, Can't tell yet or
 * Shipped anyway, from one table.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';
import { REASONS, type Decision } from '../src/release.ts';
import { DECISION_WORDS, REASON_WORDS, HOW_TO_CLOSE, verdictHeadline } from '../src/words.ts';
import { renderSummary, runGate } from '../src/gate.ts';
import { renderBrief } from '../src/brief.ts';
import { recordVerdict } from '../src/release.ts';
import { passingTest } from './support.ts';

const DECISIONS: Decision[] = ['SHIP', 'HOLD', 'UNKNOWN', 'OVERRIDDEN'];

test('every decision has its sentence and colour, and every reason code has words', () => {
  assert.deepEqual(
    DECISIONS.map((d) => DECISION_WORDS[d].headline),
    ['Ready to ship', 'Not ready', "Can't tell yet", 'Shipped anyway'],
  );
  for (const d of DECISIONS) assert.ok(DECISION_WORDS[d].tone, d);
  for (const code of REASONS) {
    assert.ok(REASON_WORDS[code]?.trim(), `${code} has a plain sentence`);
    assert.ok(HOW_TO_CLOSE[code]?.trim(), `${code} says how to close it`);
    assert.doesNotMatch(REASON_WORDS[code], /[A-Z]{2,}_[A-Z]/, `${code}: no codes in the words`);
  }
});

test('the gate summary opens with the decision in the same words', () => {
  const s = new TraceStore(':memory:');
  const req = s.record({ type: 'requirement', sourceRef: 'QA-1', content: { text: 'Totals are right.' }, provenance: { producer: 'human' } });
  assert.match(renderSummary(runGate(s, { changed: ['QA-1'] })), /^## qa-spine: Can't tell yet/);
  passingTest(s, req.id);
  assert.match(renderSummary(runGate(s, { changed: ['QA-1'] })), /^## qa-spine: Ready to ship/);
  assert.match(renderSummary(runGate(s, { changed: ['QA-1'], advisory: true })), /^## qa-spine: Ready to ship \(advisory: not enforced\)/);
});

test('the brief headline says what was decided in the same words', () => {
  const s = new TraceStore(':memory:');
  const req = s.record({ type: 'requirement', sourceRef: 'QA-1', content: { text: 'Totals are right.' }, provenance: { producer: 'human' } });
  passingTest(s, req.id);
  const v = (verdict: 'ship' | 'hold') =>
    recordVerdict(s, { releaseRef: 'r1', verdict, reason: 'All changed areas pass on this build.', cites: [], changed: ['QA-1'], provenance: { producer: 'human' } });
  assert.match(renderBrief(s, v('ship').id), /<h1>Ready to ship<\/h1>/);
  assert.match(renderBrief(s, v('hold').id), /<h1>Not ready<\/h1>/);
  assert.equal(verdictHeadline({ verdict: 'ship', decision: 'OVERRIDDEN' }).headline, 'Shipped anyway');
  assert.equal(verdictHeadline({ verdict: 'ship' }).headline, 'Ready to ship', 'a 0.3 verdict with no decision');
  assert.equal(verdictHeadline({ verdict: 'ship', override: { reason: 'r' } }).headline, 'Shipped anyway', 'a 0.3 override');
  assert.equal(verdictHeadline({ verdict: 'hold', decision: 'SHIP' }).headline, 'Not ready', 'a hold over a shippable release');
});

test('the old words are gone from what people read', () => {
  const files = ['src/gate.ts', 'src/brief.ts', ...readdirSync('src/inspector/ui').map((f) => join('src/inspector/ui', f))];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const old of ['no blockers', 'release blocked', 'cannot tell — evidence is missing', 'Cleared to ship', 'Not ready to ship']) {
      assert.ok(!text.includes(old), `${f} still says "${old}"`);
    }
  }
});
