import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { TraceStore } from '../src/trace/store.ts';
import { renderBrief, longDate } from '../src/brief.ts';
import { recordVerdict } from '../src/release.ts';

const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-opus-5', promptVersion: 'sha256:9f2a1c' };

/**
 * A requirement, one unanswered question on it, and a verdict citing that question.
 *
 * `content.liveFindings` defaults to mirror what `recordVerdict` would actually compute
 * (the cited finding when it's live, none when `cite: false`) so these fixtures exercise
 * the same non-fallback path production verdicts take. Pass `liveFindings: 'omit'` to get
 * a pre-C1 verdict instead — see the dedicated C1 tests below.
 */
function seedBrief(
  store: TraceStore,
  opts: { verdict?: 'ship' | 'hold'; reason?: string; override?: { reason: string; findings: string[] } | null;
          unmatched?: string[]; cite?: boolean; quote?: string; liveFindings?: string[] | 'omit' } = {},
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
  const content: Record<string, unknown> = {
    verdict: opts.verdict ?? 'hold',
    reason: opts.reason ?? 'One question about customer notification was never answered.',
    changed: ['PROJ-42', 'login.spec.ts'],
    unmatched: opts.unmatched ?? ['login.spec.ts'],
    override: opts.override ?? null,
  };
  if (opts.liveFindings !== 'omit') {
    content.liveFindings = opts.liveFindings ?? (opts.cite === false ? [] : [finding.id]);
  }
  const verdict = store.record({
    type: 'verdict',
    sourceRef: 'release/2026.8.1',
    content,
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
  assert.doesNotMatch(html, /\b(is|are|remains|remain) still open\b|\bcurrently unanswered\b/i);
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
  assert.match(html, /no requirement covers it/);
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
  assert.doesNotMatch(shown, /\bderived_from\b/);
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

// --- C1: section 3 comes from content.liveFindings, never from `cites` -----------------

test('C1: a finding cited to say it was resolved does not render as an open question', () => {
  const store = new TraceStore(':memory:');
  const req = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-1',
    content: { text: 'Refunds must be processed quickly.' },
    provenance: human,
  });
  const finding = store.record({
    type: 'finding',
    sourceRef: 'PROJ-1',
    content: { category: 'AMB-VAGUE-QUANT', quote: 'quickly', question: 'How quick counts as quick?', confidence: 'high' },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });
  store.record({
    type: 'answer',
    content: { text: 'Within 24 hours.' },
    provenance: human,
    links: [{ to: finding.id, relation: 'supersedes' }, { to: req.id, relation: 'derived_from' }],
  });

  // The agent cites the now-resolved finding as support for the ship decision — a
  // legitimate use of `cites` that the old cites-based section 3 rendered as an open
  // question anyway, because it never checked whether anything had answered it.
  const verdict = recordVerdict(store, {
    releaseRef: 'release/1', verdict: 'ship', reason: 'All requirement questions were answered.',
    cites: [finding.id], changed: ['PROJ-1'], provenance: ai,
  });

  const html = renderBrief(store, verdict.id);
  assert.doesNotMatch(html, /Questions that were still open/);
  assert.doesNotMatch(html, /How quick counts as quick\?/);
});

test('C1: a genuinely open finding still renders when the verdict cites a test run instead', () => {
  const store = new TraceStore(':memory:');
  const req = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-1',
    content: { text: 'Refunds must be processed and the customer notified.' },
    provenance: human,
  });
  const finding = store.record({
    type: 'finding',
    sourceRef: 'PROJ-1',
    content: {
      category: 'AMB-UNTESTABLE',
      quote: 'notified',
      question: 'Is the customer notified by email or by SMS?',
      confidence: 'unknown',
    },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });
  const testCase = store.record({
    type: 'test_case',
    sourceRef: 'tests/refund.spec.ts:1',
    content: { name: 'refund completes' },
    provenance: human,
    links: [{ to: req.id, relation: 'covers' }],
  });
  const run = store.record({
    type: 'test_run',
    sourceRef: 'ci/run/1',
    content: { status: 'failed', message: 'timed out' },
    provenance: human,
    links: [{ to: testCase.id, relation: 'verifies' }],
  });

  // The brief cites the failing run rather than the open finding — the old cites-based
  // section 3 rendered nothing in this case, hiding a genuinely open question.
  const verdict = recordVerdict(store, {
    releaseRef: 'release/1', verdict: 'hold', reason: 'A test run failed and blocks this release.',
    cites: [run.id], changed: ['PROJ-1'], provenance: ai,
  });

  const html = renderBrief(store, verdict.id);
  assert.match(html, /Questions that were still open/);
  assert.match(html, /Is the customer notified by email or by SMS\?/);
});

test('C1: liveFindings present and empty renders no questions section, even with cites', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store, { liveFindings: [] });
  assert.doesNotMatch(renderBrief(store, verdict.id), /Questions that were still open/);
});

test('C1: liveFindings absent (pre-migration verdict) falls back to cites with softened copy', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store, { liveFindings: 'omit' });
  const html = renderBrief(store, verdict.id);

  assert.match(html, /Does the login flow need to support SSO for external partners\?/);
  assert.doesNotMatch(html, /had not been answered when the release decision was recorded/);
  assert.match(html, /This question was cited in the release decision\./);
  // N1: the heading is the strongest claim on the page. It must not assert "still open
  // when this decision was made" — exactly the fact this branch cannot establish — even
  // though the softened note underneath it got that right.
  assert.match(html, /<h2>Questions cited in this decision<\/h2>/);
  assert.doesNotMatch(html, /Questions that were still open when this decision was made/);
});

test('N1: the approved heading is untouched on the liveFindings-present branch', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store);
  assert.match(renderBrief(store, verdict.id), /<h2>Questions that were still open when this decision was made<\/h2>/);
});

test('N2: a finding live on two changed requirements renders only once', () => {
  const store = new TraceStore(':memory:');
  const reqA = store.record({
    type: 'requirement', sourceRef: 'PROJ-1',
    content: { text: 'Refunds must be processed quickly.' }, provenance: human,
  });
  const reqB = store.record({
    type: 'requirement', sourceRef: 'PROJ-2',
    content: { text: 'Refunds must be processed quickly.' }, provenance: human,
  });
  // One finding, derived_from both requirements — assessReleaseRisk's flatMap over changed
  // requirements would surface it twice in `signals` before the dedup.
  const finding = store.record({
    type: 'finding', sourceRef: 'PROJ-1',
    content: { category: 'AMB-VAGUE-QUANT', quote: 'quickly', question: 'How quick counts as quick?', confidence: 'high' },
    provenance: ai,
    links: [{ to: reqA.id, relation: 'derived_from' }, { to: reqB.id, relation: 'derived_from' }],
  });

  const verdict = recordVerdict(store, {
    releaseRef: 'release/1', verdict: 'hold', reason: 'Holding pending an answer.',
    cites: [finding.id], changed: ['PROJ-1', 'PROJ-2'], provenance: ai,
  });

  const html = renderBrief(store, verdict.id);
  const occurrences = html.match(/How quick counts as quick\?/g) ?? [];
  assert.equal(occurrences.length, 1);
});

// --- I1: the release id is visible, not just in <title> --------------------------------

test('I1: the sub-line names the release so a printed page is not anonymous', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store);
  const html = renderBrief(store, verdict.id);
  const sub = html.match(/<p class="sub">([\s\S]*?)<\/p>/)?.[1] ?? '';
  assert.match(sub, /release\/2026\.8\.1/);
});

// --- I2: longDate must not drift a calendar day from the UTC footer stamp --------------

test('I2: longDate formats in UTC regardless of the host timezone', () => {
  // 2026-08-01T00:30:00Z renders on the same calendar day whether or not the fix is in
  // place under UTC, Europe/Berlin, or Asia/Kolkata (all at or east of UTC) — so asserting
  // in-process is only a real regression guard on a host west of UTC. TZ can't be forced
  // reliably for an already-running process (Node/ICU can cache the offset), so this
  // forces it on a child process instead, the same way tests/brief-cli.test.ts forces
  // QA_SPINE_DB for the CLI.
  const out = execFileSync(
    'node',
    ['-e', "import('./src/brief.ts').then(({ longDate }) => console.log(longDate('2026-08-01T00:30:00Z')))"],
    { encoding: 'utf8', env: { ...process.env, TZ: 'America/Los_Angeles' } },
  ).trim();
  assert.equal(out, '1 August 2026', 'must read 1 August even from a timezone west of UTC');

  // Sanity: the pure function still behaves in-process too.
  assert.equal(longDate('2026-08-01T00:30:00Z'), '1 August 2026');
});

// --- I4: mutation-survival gaps from the reviewer's isolated worktree ------------------

test('I4a: a changed ref that IS covered does not carry the uncovered note', () => {
  const store = new TraceStore(':memory:');
  // seedBrief: changed = ['PROJ-42', 'login.spec.ts'], unmatched = ['login.spec.ts'] —
  // PROJ-42 is covered. `unmatched.has(ref)` → `unmatched.size` would wrongly flag it too,
  // since unmatched.size is 1 (truthy) for every ref once anything is uncovered.
  const { verdict } = seedBrief(store);
  const html = renderBrief(store, verdict.id);

  assert.match(html, /<li>PROJ-42<\/li>/);
  assert.doesNotMatch(html, /PROJ-42[^<]*<span class="uncovered">/);
});

test('I4b: the quote is rendered when present on a finding', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store, { quote: 'notified' });
  assert.match(renderBrief(store, verdict.id), /About the wording: "notified"/);
});

test('I4c: a question shows the finding\'s date, not the verdict\'s', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const store = new TraceStore(':memory:');

  t.mock.timers.setTime(new Date('2026-01-05T10:00:00Z').getTime());
  const req = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-1',
    content: { text: 'Refunds must be processed and the customer notified.' },
    provenance: human,
  });
  const finding = store.record({
    type: 'finding',
    sourceRef: 'PROJ-1',
    content: { category: 'AMB-UNTESTABLE', quote: 'notified', question: 'Is the customer notified by email or SMS?', confidence: 'unknown' },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });

  t.mock.timers.setTime(new Date('2026-02-20T10:00:00Z').getTime());
  const verdict = store.record({
    type: 'verdict',
    sourceRef: 'release/x',
    content: {
      verdict: 'hold', reason: 'Holding.', changed: ['PROJ-1'], unmatched: [],
      override: null, liveFindings: [finding.id],
    },
    provenance: ai,
    links: [{ to: finding.id, relation: 'derived_from' }],
  });

  const html = renderBrief(store, verdict.id);
  assert.match(html, /Question asked on 5 January 2026/);
  assert.doesNotMatch(html, /Question asked on 20 February 2026/);
});

test('I4d: an inbound edge that is not "reviews" does not count as a review', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store);
  store.record({
    type: 'defect',
    content: { note: 'unrelated defect pointing at the verdict' },
    provenance: human,
    links: [{ to: verdict.id, relation: 'contradicts' }],
  });

  // `.some(e => e.relation === 'reviews')` → `.length > 0` would call this reviewed,
  // since some inbound edge exists — just not a `reviews` one.
  assert.match(renderBrief(store, verdict.id), /No human review was recorded/);
});

test('I4e: the model name appears in the "Written by an AI" line', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store);
  assert.match(renderBrief(store, verdict.id), /Written by an AI \(claude-opus-5\)/);
});

test('I4f: the footer disclaimer is present', () => {
  const store = new TraceStore(':memory:');
  const { verdict } = seedBrief(store);
  assert.match(
    renderBrief(store, verdict.id),
    /This is a historical record of a decision\. It does not reflect later answers or changes\./,
  );
});

// --- M4: a human-written verdict also states whether it was reviewed -------------------

test('M4: a human-written verdict states its review status on both branches', () => {
  const store = new TraceStore(':memory:');
  const verdict = store.record({
    type: 'verdict',
    sourceRef: 'release/3',
    content: {
      verdict: 'ship', reason: 'Looks good.', changed: ['PROJ-1'], unmatched: [],
      override: null, liveFindings: [],
    },
    provenance: human,
  });

  assert.match(renderBrief(store, verdict.id), /Written by a person.*No human review was recorded/s);

  store.record({
    type: 'review',
    content: { verdict: 'good', note: '' },
    provenance: human,
    links: [{ to: verdict.id, relation: 'reviews' }],
  });
  assert.match(renderBrief(store, verdict.id), /Written by a person.*Later reviewed by a person/s);
});
