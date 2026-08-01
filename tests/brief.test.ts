import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceStore } from '../src/trace/store.ts';
import { renderBrief } from '../src/brief.ts';

const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-opus-5', promptVersion: 'sha256:9f2a1c' };

/** A requirement, one unanswered question on it, and a verdict citing that question. */
function seedBrief(
  store: TraceStore,
  opts: { verdict?: 'ship' | 'hold'; reason?: string; override?: { reason: string; findings: string[] } | null;
          unmatched?: string[]; cite?: boolean; quote?: string } = {},
) {
  const req = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-42',
    content: { text: 'Refunds must be processed and the customer notified.' },
    provenance: human,
  });
  const finding = store.record({
    type: 'finding',
    sourceRef: 'PROJ-42',
    content: {
      category: 'AMB-UNTESTABLE',
      quote: opts.quote ?? 'notified',
      question: 'Does the login flow need to support SSO for external partners?',
      confidence: 'unknown',
    },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });
  const verdict = store.record({
    type: 'verdict',
    sourceRef: 'release/2026.8.1',
    content: {
      verdict: opts.verdict ?? 'hold',
      reason: opts.reason ?? 'One question about customer notification was never answered.',
      changed: ['PROJ-42', 'login.spec.ts'],
      unmatched: opts.unmatched ?? ['login.spec.ts'],
      override: opts.override ?? null,
    },
    provenance: ai,
    links: opts.cite === false ? [] : [{ to: finding.id, relation: 'derived_from' }],
  });
  return { req, finding, verdict };
}

/** Everything above the footer — where the no-jargon rule applies. */
const body = (html: string) => html.split(/<footer/i)[0];

test('a hold renders the decision and the reason verbatim', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store);
  const html = renderBrief(store, verdict.id);

  assert.match(html, /Not ready to ship/);
  assert.match(html, /One question about customer notification was never answered\./);
  assert.doesNotMatch(html, /Cleared to ship/);
});

test('a ship renders the cleared decision', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store, { verdict: 'ship', reason: 'Nothing outstanding.' });
  assert.match(renderBrief(store, verdict.id), /Cleared to ship/);
});

test('a cited question appears with its date, in the past tense', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store);
  const html = renderBrief(store, verdict.id);

  assert.match(html, /Does the login flow need to support SSO for external partners\?/);
  assert.match(html, /Question asked on \d{1,2} \w+/);
  assert.match(html, /had not been answered when the release decision was recorded/);
  assert.doesNotMatch(html, /still open|currently unanswered/i);
});

test('a verdict citing no findings omits the questions section entirely', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store, { cite: false });
  assert.doesNotMatch(renderBrief(store, verdict.id), /Questions that were still open/);
});

test('unmatched refs are flagged as uncovered', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store);
  const html = renderBrief(store, verdict.id);

  assert.match(html, /login\.spec\.ts/);
  assert.match(html, /no matching requirement/);
});

test('an override renders the callout, the tension, and its reason', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store, {
    verdict: 'ship',
    reason: 'Shipping the hotfix.',
    override: { reason: 'The open question only affects admin reporting.', findings: [] },
  });
  const html = renderBrief(store, verdict.id);

  assert.match(html, /even though/);
  assert.match(html, /The open question only affects admin reporting\./);
});

test('no override renders no callout', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store);
  assert.doesNotMatch(renderBrief(store, verdict.id), /even though open questions existed/);
});

test('the page body contains no ids, relation names or internal field names', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store);
  const shown = body(renderBrief(store, verdict.id));

  assert.doesNotMatch(
    shown,
    /\b(requirement|finding|test_case|test_run|defect|verdict|review|answer)_[0-9a-f]{8}\b/,
  );
  assert.doesNotMatch(shown, /\b(derived_from|supersedes|covers|verifies|contradicts|reviews)\b/);
  assert.doesNotMatch(shown, /\b(promptVersion|sourceRef|inputDigest|producer|artifact)\b/);
});

test('an empty reason renders the explicit fallback', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store, { reason: '   ' });
  assert.match(renderBrief(store, verdict.id), /No explanation was provided with this decision\./);
});

test('a reviewed verdict says so; an unreviewed one says so too', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store);
  assert.match(renderBrief(store, verdict.id), /No human review was recorded/);

  store.record({
    type: 'review',
    content: { verdict: 'good', note: '' },
    provenance: human,
    links: [{ to: verdict.id, relation: 'reviews' }],
  });
  assert.match(renderBrief(store, verdict.id), /Later reviewed by a person/);
});

test('markup in the reason is escaped, not rendered', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store, {
    reason: 'Held because 5 < 6 & <script>alert("x")</script> was in the diff.',
  });
  const html = renderBrief(store, verdict.id);

  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /5 &lt; 6 &amp;/);
});

test('markup in a quote and an override reason is escaped', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store, {
    verdict: 'ship',
    reason: 'Shipping.',
    quote: '<b>notified</b>',
    override: { reason: 'accepted <img src=x onerror=alert(1)>', findings: [] },
  });
  const html = renderBrief(store, verdict.id);

  assert.doesNotMatch(html, /<b>notified<\/b>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('renderBrief rejects an unknown id and a non-verdict id', () => {
  const store = new TraceStore(':memory:');
  const { req } = seedBrief(store);

  assert.throws(() => renderBrief(store, 'verdict_deadbeef'), /no artifact with id verdict_deadbeef/);
  assert.throws(() => renderBrief(store, req.id), /is a requirement, not a verdict/);
});

test('a citation that no longer resolves does not prevent rendering', () => {
  const store = new TraceStore(':memory:');
  // An override naming a finding that was never written — the brief must still render,
  // and must simply omit the question it cannot resolve rather than failing.
  const orphaned = store.record({
    type: 'verdict',
    sourceRef: 'release/2',
    content: {
      verdict: 'ship', reason: 'Shipping the hotfix.', changed: ['PROJ-42'], unmatched: [],
      override: { reason: 'accepted', findings: ['finding_deadbeef'] },
    },
    provenance: ai,
  });

  const html = renderBrief(store, orphaned.id);
  assert.match(html, /Cleared to ship/);
  assert.match(html, /accepted/);
  assert.doesNotMatch(html, /Questions that were still open/);
});
