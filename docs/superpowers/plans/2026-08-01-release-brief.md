# Release Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn one recorded release verdict into a self-contained HTML page a non-technical project head can read, and stop the agent's own prose from reintroducing the jargon that page strips.

**Architecture:** A pure-presentation module reads one `verdict` artifact plus its cited findings and returns a complete HTML document — no new judgement, no model call, no new store method. A denylist at `recordVerdict` rejects internal terminology where the prose is authored rather than where it is rendered.

**Tech Stack:** TypeScript, Node >= 22.5, `node:sqlite`, `node:test`. No new dependencies.

## Global Constraints

- **No new dependencies.** Only `@modelcontextprotocol/sdk` and `zod` are permitted in `src/`.
- **The brief computes no new judgement.** It renders what `release_submit` recorded. It must never re-evaluate whether a finding is still open — that would make the brief disagree with the verdict it renders.
- **Past tense throughout.** "had not been answered when the release decision was recorded", never "still open" or "currently unanswered".
- **Every interpolated value is escaped.** `content.reason`, `override.reason` and `finding.quote` are free text; two are agent-written. A brief that renders agent prose as markup is an injection bug in a file people forward by email.
- **No ids, no snake_case, no relation names in the page body.** The footer is the single exception and sits below a `<footer>` boundary.
- **The lint denies only unambiguous internals.** Bare `finding`, `trace`, `requirement` and `spine` must be accepted — a denylist over ordinary English would reject legitimate prose on a release-blocking call.
- **The store is append-only.** Never `UPDATE` or `DELETE`.
- **Every rejection writes nothing.** Validate fully before the first `store.record()`.
- Deliberate shortcuts get a `ponytail:` comment naming the ceiling and the upgrade path.
- Spec: `docs/superpowers/specs/2026-08-01-release-brief-design.md`

## File Structure

| File | Responsibility |
| --- | --- |
| `src/release.ts` (modify) | Add the prose lint to `recordVerdict`. |
| `tests/release.test.ts` (modify) | Lint tests, including the false-positive guard. |
| `src/brief.ts` (create) | `renderBrief` — escaping, wording, the HTML document. |
| `tests/brief.test.ts` (create) | All brief tests, including the anti-jargon assertion. |
| `src/server.ts` (modify) | The `brief` subcommand. |
| `README.md` (modify) | A section describing the brief. |

**No change to** `src/inspector/` — its audience and purpose are unchanged — or to `src/trace/`.

---

### Task 1: The prose lint

**Files:**
- Modify: `src/release.ts` (constants near the top; calls inside `recordVerdict` at lines 144-161)
- Test: `tests/release.test.ts` (append)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: no exported symbol. Task 2 relies on the *effect* — that a recorded verdict's `reason` is free of internal terminology.

- [ ] **Step 1: Write the failing tests**

Append to `tests/release.test.ts`:

```ts
test('recordVerdict rejects a reason containing a relation name', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'hold',
      reason: 'The test case was derived_from the ticket and never finished.',
      cites: [open.id], changed: ['PROJ-42'], provenance: ai,
    }),
    /reason contains internal terminology \("derived_from"\)/,
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict rejects a reason containing an internal field name', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'hold',
      reason: 'The sourceRef did not match anything we expected.',
      cites: [open.id], changed: ['PROJ-42'], provenance: ai,
    }),
    /reason contains internal terminology \("sourceRef"\)/,
  );
});

test('recordVerdict rejects a reason containing an artifact id', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'hold',
      reason: 'We are holding because finding_9f8e2b1c was never answered.',
      cites: [open.id], changed: ['PROJ-42'], provenance: ai,
    }),
    /reason contains internal terminology \("finding_9f8e2b1c"\)/,
  );
});

test('recordVerdict accepts ordinary English that merely resembles jargon', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);

  // The false-positive guard, and the whole reason the denylist is narrow: each of
  // these is a sentence a person would plausibly write under release pressure.
  const verdict = recordVerdict(store, {
    releaseRef: 'release/1',
    verdict: 'hold',
    reason:
      'Our finding was that the refund requirement was ambiguous, and we could not ' +
      'trace the root cause before the cutoff. This is the spine of the checkout flow.',
    cites: [open.id],
    changed: ['PROJ-42'],
    provenance: ai,
  });
  assert.equal(verdict.content.verdict, 'hold');
});

test('recordVerdict lints override.reason too, since the brief renders it verbatim', () => {
  const store = new TraceStore(':memory:');
  const { req, open } = seedRelease(store);
  store.record({
    type: 'answer',
    content: { text: 'Retry twice, then alert on-call.' },
    provenance: human,
    links: [{ to: open.id, relation: 'supersedes' }, { to: req.id, relation: 'derived_from' }],
  });

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'ship', reason: 'Everything is answered.',
      cites: [req.id], changed: ['PROJ-42'],
      override: { reason: 'accepted despite test_case coverage gaps' },
      provenance: ai,
    }),
    /override\.reason contains internal terminology \("test_case"\)/,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/release.test.ts`
Expected: the four rejection tests FAIL (no error is thrown, so `assert.throws` fails); the false-positive test PASSES already.

- [ ] **Step 3: Add the lint**

In `src/release.ts`, add above `export function recordVerdict`:

```ts
/**
 * Tokens with no innocent English reading. Deliberately narrow: a denylist over
 * ordinary words would reject "our finding was that…" or "could not trace the root
 * cause" on a release-blocking call, which is the worst possible moment to argue
 * about wording.
 *
 * ponytail: a denylist stops mechanical jargon leaks, not prose that is merely bad.
 * Upgrade: a published rubric for brief prose, scored the way rubrics/ambiguity.json
 * already scores requirements.
 *
 * ponytail: `covers` and `reviews` have innocent readings ("this covers the refund
 * flow"), but appear in this system only as relation names and are rare in a release
 * rationale. Upgrade: deny only the snake_case and camelCase forms.
 */
const INTERNAL_TERMS: RegExp[] = [
  /\b(derived_from|supersedes|covers|verifies|contradicts|reviews)\b/i,
  /\b(sourceRef|promptVersion|inputDigest)\b/i,
  /\b(test_case|test_run)\b/i,
  /\b(requirement|finding|test_case|test_run|defect|verdict|review|answer)_[0-9a-f]{8}\b/i,
];

/**
 * The brief renders this text verbatim to a non-technical reader, so the constraint
 * belongs here, where the prose is authored, rather than at render time where the
 * only options are to mangle it or to show it.
 */
function assertPlainLanguage(field: string, text: string): void {
  for (const pattern of INTERNAL_TERMS) {
    const hit = text.match(pattern);
    if (hit) {
      throw new Error(
        `${field} contains internal terminology (${JSON.stringify(hit[0])}) — ` +
          'rewrite in plain language suitable for a project manager',
      );
    }
  }
}
```

Then call it in `recordVerdict`. After the existing blank-`reason` check:

```ts
  const reason = input.reason.trim();
  if (!reason) throw new Error('reason must not be blank');
  assertPlainLanguage('reason', reason);
```

And after the existing blank-`override.reason` check:

```ts
    overrideReason = input.override.reason?.trim() ?? '';
    if (!overrideReason) throw new Error('override.reason must not be blank');
    assertPlainLanguage('override.reason', overrideReason);
```

Note the id pattern is listed after the bare `test_case` pattern deliberately: `\btest_case\b` cannot match inside `test_case_d995b342` because `_` is a word character, so an id is always reported as the id rather than as a fragment.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/release.test.ts`
Expected: PASS, all tests including the five new ones.

- [ ] **Step 5: Run the whole suite**

Run: `npm test && npm run build`
Expected: all PASS, `tsc` clean. Existing release tests use short fixture prose ("holding", "because") that contains none of the denied terms, so nothing should regress. **If an existing test now fails, do not weaken the lint — report which test and what term it tripped.**

- [ ] **Step 6: Commit**

```bash
git add src/release.ts tests/release.test.ts
git commit -m "feat(release): reject internal terminology in verdict prose"
```

---

### Task 2: `renderBrief`

**Files:**
- Create: `src/brief.ts`
- Test: `tests/brief.test.ts`

**Interfaces:**
- Consumes: existing `store.get(id)`, `store.edgesFrom(id)`, `store.edgesTo(id)`.
- Produces: `renderBrief(store: TraceStore, verdictId: string): string` — a complete HTML document. Task 3 wraps it.

- [ ] **Step 1: Write the failing tests**

Create `tests/brief.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/brief.test.ts`
Expected: FAIL — cannot find module `../src/brief.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/brief.ts`:

```ts
import type { TraceStore } from './trace/store.ts';
import type { Artifact } from './trace/schema.ts';

/**
 * Renders one recorded verdict as a self-contained page for a non-technical reader.
 *
 * It computes no new judgement. Everything here was recorded by `release_submit`,
 * which is what lets the brief be trusted: it cannot disagree with the ledger,
 * because it is the ledger.
 *
 * ponytail: one verdict per brief — no release spanning several, no comparison
 * across releases. Upgrade: accept several ids and render a section each.
 */

/** `&` first, or the other replacements re-escape their own output. */
const esc = (value: unknown): string =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** "1 August 2026" — a date a project head reads without decoding. */
const longDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** "2026-08-01 09:14 UTC" — the footer's precise stamp, for someone tracing back. */
const utcStamp = (iso: string): string =>
  `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const STYLE = `
  :root { --ink:#1a1d23; --dim:#5c6472; --line:#e2e5ea; --warn-bg:#fdf6e3; --warn-line:#d9a441; --note:#f5f7fa; }
  * { box-sizing: border-box; }
  body { margin:0; padding:2.5rem 1.25rem 4rem; background:#fff; color:var(--ink);
         font:16px/1.65 -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width:680px; margin:0 auto; }
  h1 { font-size:2.25rem; line-height:1.15; margin:0 0 .35rem; letter-spacing:-.02em; }
  h2 { font-size:1rem; letter-spacing:.06em; text-transform:uppercase; color:var(--dim);
       margin:2.5rem 0 .75rem; font-weight:600; }
  p { margin:0 0 1rem; }
  .sub { color:var(--dim); margin-bottom:2rem; }
  .q { background:var(--note); border-left:3px solid var(--line); border-radius:0 4px 4px 0;
       padding:.9rem 1.1rem; margin-bottom:1rem; }
  .q-when { color:var(--dim); font-size:.875rem; margin-bottom:.35rem; }
  .q-ask { font-size:1.05rem; margin-bottom:.6rem; }
  .q-note, .q-quote { color:var(--dim); font-size:.9rem; margin:0; }
  .q-quote { font-style:italic; margin-bottom:.4rem; }
  ul { list-style:none; padding:0; margin:0; }
  li { padding:.4rem 0; border-bottom:1px solid var(--line); }
  li:last-child { border-bottom:0; }
  .uncovered { color:var(--dim); }
  .who { color:var(--dim); }
  .override { background:var(--warn-bg); border-left:3px solid var(--warn-line);
              border-radius:0 4px 4px 0; padding:1rem 1.15rem; margin-top:1.25rem; }
  .override strong { display:block; margin-bottom:.6rem; }
  footer { max-width:680px; margin:3.5rem auto 0; padding-top:1.25rem; border-top:1px solid var(--line);
           color:var(--dim); font-size:.8rem; }
  @media print { body { padding:0; } h1 { font-size:2.6rem; } footer { page-break-inside:avoid; } }
`;

export function renderBrief(store: TraceStore, verdictId: string): string {
  const verdict = store.get(verdictId);
  if (!verdict) throw new Error(`no artifact with id ${verdictId}`);
  if (verdict.type !== 'verdict') {
    throw new Error(`artifact ${verdictId} is a ${verdict.type}, not a verdict`);
  }

  const c = verdict.content as Record<string, any>;
  const shipped = c.verdict === 'ship';
  const reason = String(c.reason ?? '').trim();
  const changed: string[] = Array.isArray(c.changed) ? c.changed : [];
  const unmatched = new Set<string>(Array.isArray(c.unmatched) ? c.unmatched : []);
  const override = c.override && typeof c.override === 'object' ? c.override : null;

  // Cited findings: the derived_from edges plus anything the override names.
  const citedIds = new Set<string>([
    ...store.edgesFrom(verdict.id).filter((e) => e.relation === 'derived_from').map((e) => e.toArtifactId),
    ...(Array.isArray(override?.findings) ? override.findings : []),
  ]);
  // A citation that no longer resolves is skipped rather than fatal — the footer's id
  // is enough for someone to investigate, and a missing link must not withhold the brief.
  const questions = [...citedIds]
    .map((id) => store.get(id))
    .filter((a): a is Artifact => !!a && a.type === 'finding');

  const reviewed = store.edgesTo(verdict.id).some((e) => e.relation === 'reviews');
  const p = verdict.provenance;
  const who =
    p.producer === 'ai'
      ? `Written by an AI (${esc(p.model)}) · ${reviewed ? 'Later reviewed by a person' : 'No human review was recorded'}`
      : 'Written by a person';

  const questionBlocks = questions
    .map((f) => {
      const quote = String(f.content.quote ?? '').trim();
      return `
      <div class="q">
        <div class="q-when">Question asked on ${esc(longDate(f.createdAt))}</div>
        <div class="q-ask">${esc(f.content.question ?? '')}</div>
        ${quote ? `<p class="q-quote">About the wording: “${esc(quote)}”</p>` : ''}
        <p class="q-note">This question was raised while the work was being specified and had not
        been answered when the release decision was recorded.</p>
      </div>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Release ${esc(verdict.sourceRef ?? '')} — ${shipped ? 'cleared to ship' : 'not ready to ship'}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>${shipped ? 'Cleared to ship' : 'Not ready to ship'}</h1>
  <p class="sub">A formal release decision was recorded on ${esc(longDate(verdict.createdAt))}.</p>

  <h2>Why this decision was made</h2>
  <p>${reason ? esc(reason) : 'No explanation was provided with this decision.'}</p>

  ${questions.length ? `<h2>Questions that were still open when this decision was made</h2>${questionBlocks}` : ''}

  <h2>What this release touches</h2>
  <ul>${changed
    .map(
      (ref) =>
        `<li>${esc(ref)}${unmatched.has(ref) ? ' <span class="uncovered">— changed, but no requirement covers it</span>' : ''}</li>`,
    )
    .join('')}</ul>

  <h2>Who made this decision</h2>
  <p class="who">${who}</p>
  ${
    override
      ? `<div class="override">
    <strong>⚠ This release was cleared even though open questions existed.</strong>
    <p>Reason given at the time:</p>
    <p>“${esc(override.reason ?? '')}”</p>
  </div>`
      : ''
  }
</main>
<footer>
  Record ID: ${esc(verdict.id)} · Recorded ${esc(utcStamp(verdict.createdAt))}<br>
  This is a historical record of a decision. It does not reflect later answers or changes.
</footer>
</body>
</html>`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/brief.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Run the whole suite and build**

Run: `npm test && npm run build`
Expected: all PASS, `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add src/brief.ts tests/brief.test.ts
git commit -m "feat(brief): render a verdict as a page a project head can read"
```

---

### Task 3: The `brief` subcommand and the README

**Files:**
- Modify: `src/server.ts` (import near line 16; a new case in the CLI switch)
- Modify: `README.md`

**Interfaces:**
- Consumes: `renderBrief(store, verdictId)` from Task 2.
- Produces: the CLI contract `node dist/server.js brief <verdictId>`.

- [ ] **Step 1: Add the import**

In `src/server.ts`, after the existing `./release.ts` import:

```ts
import { renderBrief } from './brief.ts';
```

- [ ] **Step 2: Add the subcommand**

In the `switch (process.argv[2])` block, after the `record` case and before `default`:

```ts
    case 'brief': {
      // Unlike `record`, errors go to stderr: this output is a document being
      // redirected to a file, so a failed run must leave an empty file rather
      // than a file containing an error page.
      const id = process.argv[3];
      if (!id) {
        console.error('usage: qa-spine brief <verdictId>');
        process.exitCode = 1;
        break;
      }
      try {
        console.log(renderBrief(store, id));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
      break;
    }
```

- [ ] **Step 3: Verify the subcommand end to end**

```bash
npm run build
rm -f /tmp/brief-check.db
QA_SPINE_DB=/tmp/brief-check.db node -e "
const { TraceStore } = await import('./src/trace/store.ts');
const s = new TraceStore('/tmp/brief-check.db');
const ai = { producer:'ai', model:'claude-opus-5', promptVersion:'sha256:9f2a1c' };
const req = s.record({ type:'requirement', sourceRef:'PROJ-42', content:{ text:'Refunds must be processed.' }, provenance:{ producer:'human' } });
const f = s.record({ type:'finding', sourceRef:'PROJ-42', content:{ category:'AMB-UNTESTABLE', quote:'processed', question:'What happens when notification delivery fails?', confidence:'unknown' }, provenance: ai, links:[{ to:req.id, relation:'derived_from' }] });
const v = s.record({ type:'verdict', sourceRef:'release/2026.8.1', content:{ verdict:'hold', reason:'One question about customer notification was never answered.', changed:['PROJ-42','src/refund.ts'], unmatched:['src/refund.ts'], override:null }, provenance: ai, links:[{ to:f.id, relation:'derived_from' }] });
console.log(v.id);
"
```

Take the printed id, then:

```bash
QA_SPINE_DB=/tmp/brief-check.db node dist/server.js brief <thatId> > /tmp/brief.html
echo "exit: $?"
head -c 200 /tmp/brief.html
```

Expected: exit 0, the file starts with `<!doctype html>`. Open it in a browser and confirm the six blocks read as intended.

Then the failure path:

```bash
QA_SPINE_DB=/tmp/brief-check.db node dist/server.js brief verdict_deadbeef > /tmp/bad.html
echo "exit: $?"
wc -c /tmp/bad.html
```

Expected: exit 1, the message on stderr, and `/tmp/bad.html` **zero bytes** — no error page in the file.

Clean up `/tmp/brief-check.db`, `/tmp/brief.html`, `/tmp/bad.html`.

- [ ] **Step 4: Update the README**

Add after the "Release risk" section:

````markdown
## The release brief

The Inspector is an instrument for judging agent output; it assumes you know what an
artifact and a relation are, and it is loopback-only, so a project manager cannot open
it at all. The brief is the other half: one command turns a recorded verdict into a
self-contained HTML page you can send them.

```bash
node dist/server.js brief verdict_a1b2c3d4 > release-brief.html
```

Inline CSS, no JavaScript, no external requests — it survives email, Confluence and
printing. It answers the questions a project head actually has: are we ready to ship,
what was unanswered, what does this touch, and who decided.

It renders a verdict that already exists and computes nothing, so **the brief cannot
disagree with the ledger, because it is the ledger.** It also renders the decision *as
recorded*: if a question cited by a hold has since been answered, the brief for that
release still shows it was open when the call was made, and the footer says so. A brief
is a record of a decision, not a live status page.

No artifact ids, relation names or internal field names appear in the body — the footer
carries the record id for anyone tracing back, and a test asserts the rest of the page
stays clean.

The page can only be as plain as the prose inside it, so `release_submit` rejects a
`reason` or an `override.reason` containing internal terminology — relation names, field
names, artifact ids — and asks for a rewrite. The list is deliberately narrow: ordinary
English that merely resembles jargon ("our finding was that…", "could not trace the root
cause") is accepted, because rejecting a legitimate sentence on a release-blocking call
is worse than letting one awkward word through.
````

- [ ] **Step 5: Run the whole suite once more**

Run: `npm test && npm run build`
Expected: all PASS, `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts README.md
git commit -m "feat(cli): add a brief subcommand and document it"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| Prose lint at `release_submit`, narrow denylist | 1 |
| False-positive guard (`finding`/`trace`/`requirement`/`spine` accepted) | 1 (test) |
| `renderBrief`, cited findings, review lookup | 2 |
| Six blocks with the specified copy | 2 |
| Empty-reason fallback | 2 (test 9) |
| "No human review was recorded" / "Later reviewed by a person" | 2 (test 10) |
| Override callout with "even though" | 2 (test 6) |
| Footer with the historical-record disclaimer | 2 |
| Escaping on all three free-text fields | 2 (tests 11, 12) |
| No ids / relations / field names in the body | 2 (test 8) |
| Past-tense wording | 2 (test 3 asserts the absence of "still open") |
| Missing citation does not break rendering | 2 (test 14) |
| `brief` subcommand, errors to stderr | 3 |
| Empty file on failure | 3 (step 3) |
| README section | 3 |
| 4 `ponytail:` ceilings | 1 (×2), 2 (×1), plus the spec's own list |

**Placeholder scan:** none — every step carries runnable code or an exact command.

**Type consistency:** `renderBrief(store, verdictId): string` is identical in Task 2's definition, Task 2's tests, and Task 3's call site. `assertPlainLanguage(field, text)` is used with the two field names the tests assert on: `reason` and `override.reason`.

**Deliberate deviation from the spec, flagged:** the spec's lint section names only `reason`. This plan lints `override.reason` as well, and Task 1 test 5 pins it. The rationale is the spec's own — the constraint belongs where prose is authored, and `override.reason` is rendered verbatim to the same reader. Linting one and not the other leaves an obvious hole, and "shipped over finding_2b3c" is exactly the sentence an agent writes in an override.

**One risk worth stating:** Task 1 adds validation to a merged, working tool. Existing tests use short fixture prose ("holding", "because", "hotfix") that trips none of the denied terms, so the suite should stay green — but if it does not, the correct response is to report which test tripped which term, never to weaken the lint to make a test pass.
