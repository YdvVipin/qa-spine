import type { TraceStore } from './trace/store.ts';
import type { Artifact } from './trace/schema.ts';
import { flakyOn, isHandRecordedPass } from './release.ts';

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
export const esc = (value: unknown): string =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/**
 * "1 August 2026" — a date a project head reads without decoding.
 *
 * I2: `timeZone: 'UTC'` is load-bearing. Without it this formats in whatever zone the
 * rendering machine happens to be in, while `utcStamp` below is fixed UTC — so a verdict
 * recorded at 2026-08-01T00:30Z could show "31 July 2026" in the body and
 * "2026-08-01 00:30 UTC" in the footer, one calendar day apart, on the same page.
 * Exported so the fix can be pinned by a test independent of the host's actual timezone.
 */
export const longDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

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
  const dropped: string[] = Array.isArray(c.droppedFromAssessment) ? c.droppedFromAssessment : [];
  const suspect: string[] = Array.isArray(c.suspect) ? c.suspect : [];
  const untested: string[] = Array.isArray(c.untested) ? c.untested : [];
  // Copied onto the verdict when it was recorded, so a later undo does not change this page.
  const retracted: { type?: string; name?: string; by?: string; reason?: string; at?: string }[] = Array.isArray(c.retracted)
    ? c.retracted
    : [];
  const WITHDRAWN_KIND: Record<string, string> = { requirement: 'Requirement', test_case: 'Test', test_run: 'Test result' };
  // Each answer that accepted a suggested default, beside the question it answered.
  const assumptions = (Array.isArray(c.assumptions) ? c.assumptions : []).flatMap((id: string) => {
    const answer = store.get(id);
    const findingId = answer && store.edgesFrom(answer.id).find((e) => e.relation === 'supersedes')?.toArtifactId;
    const finding = findingId ? store.get(findingId) : undefined;
    return answer && finding ? [{ question: String(finding.content.question ?? ''), answer: String(answer.content.text ?? '') }] : [];
  });

  // C1: section 3 is built from `content.liveFindings` alone — the findings that were
  // actually open (unresolved) when the verdict was recorded — never from `cites` (the
  // derived_from edges below). `cites` means "artifacts this brief refers to", and
  // release_submit's own instructions tell the agent to cite an artifact for every claim,
  // including a finding cited to say it was resolved — so a cites-based section 3 could
  // render an already-answered finding as an open question, and, the other way round,
  // render no section at all for a hold that cites a failing test run instead of any
  // finding. `liveFindings` is recomputed signals and is immune to both.
  const liveFindings: string[] | undefined = Array.isArray(c.liveFindings) ? c.liveFindings : undefined;

  // ponytail: verdicts recorded before `liveFindings` existed (this branch) have no way to
  // acquire it — the store is append-only, so there is no backfill. Fall back to the old
  // cites-based reconstruction, but soften the claim: these findings were *cited* in the
  // decision, not provably *unanswered* by it — that is the ceiling of what an old verdict
  // can honestly say. Upgrade path: none without a migration story for this project (see
  // the matching note in release.ts, recordVerdict).
  const usingFallback = liveFindings === undefined;
  // N2: `liveFindings` comes straight from `signals`, a flatMap over every changed
  // requirement — a finding derived_from two changed requirements appears in it twice,
  // which without dedup rendered the same question block twice.
  const findingIds = usingFallback
    ? [...new Set<string>([
        ...store.edgesFrom(verdict.id).filter((e) => e.relation === 'derived_from').map((e) => e.toArtifactId),
        ...(Array.isArray(override?.findings) ? override.findings : []),
      ])]
    : [...new Set(liveFindings)];
  // A citation that no longer resolves is skipped rather than fatal — the footer's id
  // is enough for someone to investigate, and a missing link must not withhold the brief.
  // A finding with no question text (e.g. examples/seed-demo.ts writes `why` and
  // `suggestedRewrite`, never `question`) has nothing to tell this reader — skip it
  // entirely rather than render a box with a date and a note explaining nothing. Filtering
  // here, not just in questionBlocks below, means the questions.length check further down
  // already omits the section heading too when every candidate lacks question text.
  const questions = findingIds
    .map((id) => store.get(id))
    .filter((a): a is Artifact => !!a && a.type === 'finding')
    .filter((f) => String(f.content.question ?? '').trim());

  // M4: computed for every verdict, and now shown on both branches below — a human-written
  // verdict used to never say whether anyone reviewed it.
  const reviewed = store.edgesTo(verdict.id).some((e) => e.relation === 'reviews');
  const reviewNote = reviewed ? 'Later reviewed by a person' : 'No human review was recorded';
  const p = verdict.provenance;
  // Three producers, three bylines. `tool` must not fall through to "Written by a person":
  // a verdict a pipeline recorded has no human author, and saying otherwise on the one page
  // a non-technical reader actually reads is the worst place in the product to be wrong
  // about who decided something.
  const author =
    p.producer === 'ai'
      ? `Written by an AI (${esc(p.model)})`
      : p.producer === 'tool'
        ? `Recorded automatically by ${esc(p.tool)}`
        : 'Written by a person';
  const approved = p.approvedBy ? ` · Approved by ${esc(p.approvedBy)}` : '';
  const who = `${author}${approved} · ${reviewNote}`;

  // The tests that were failing at decision time. Verdicts from before test results were
  // signals have no `liveTestRuns` and render no section, exactly as they did then.
  // Flakiness is judged from the runs recorded up to the verdict, not after: a rerun
  // tomorrow must not change what this page says about today's decision.
  const liveTestRuns: string[] = Array.isArray(c.liveTestRuns) ? [...new Set<string>(c.liveTestRuns)] : [];
  const failingTests = liveTestRuns.flatMap((runId) => {
    const run = store.get(runId);
    const tcId = run && store.edgesFrom(run.id).find((e) => e.relation === 'verifies')?.toArtifactId;
    const tc = tcId ? store.get(tcId) : undefined;
    if (!run || !tc) return [];
    // asOf: a run retracted after the decision still counts here, as it did then.
    const history = store
      .linkedFrom(tc.id, 'verifies', 'test_run', { asOf: verdict.createdAt })
      .filter((r) => r.createdAt <= verdict.createdAt);
    // A pass typed in by a person after this failure did not clear it (decidingRun in
    // release.ts). Say so, or "last run" reads as false next to a later pass in the record.
    const handPassLater = history.some((r) => r.id !== run.id && isHandRecordedPass(r) && r.createdAt >= run.createdAt);
    return [
      {
        run,
        name: String(tc.content.name ?? 'an unnamed test'),
        flaky: flakyOn(history),
        handPassLater,
      },
    ];
  });
  const testBlocks = failingTests
    .map(({ run, name, flaky, handPassLater }) => {
      const message = String(run.content.message ?? '').trim();
      return `
      <div class="q">
        <div class="q-when">${handPassLater ? 'Last counted run' : 'Last run'} on ${esc(longDate(run.createdAt))}${run.content.status === 'error' ? ' · could not run to completion' : ''}</div>
        <div class="q-ask">${esc(name)}</div>
        ${message ? `<p class="q-quote">${esc(message)}</p>` : ''}
        ${flaky ? '<p class="q-note">This test also passed on the same version of the code, so it may be unreliable rather than a real fault.</p>' : ''}
        ${handPassLater ? '<p class="q-note">A later pass was entered by hand rather than coming from a test run, so it did not count without a named approver.</p>' : ''}
      </div>`;
    })
    .join('');

  const overrodeQuestions = !override || !Array.isArray(override.testRuns) || (Array.isArray(override.findings) && override.findings.length > 0);
  const overrodeTests = Array.isArray(override?.testRuns) && override.testRuns.length > 0;
  const overrideTension = [
    ...(overrodeQuestions ? ['open questions existed'] : []),
    ...(overrodeTests ? ['tests were failing'] : []),
  ].join(' and ');

  const questionBlocks = questions
    .map((f) => {
      const quote = String(f.content.quote ?? '').trim();
      const note = usingFallback
        ? 'This question was cited in the release decision. Whether it was still open at the time was not recorded.'
        : 'This question was raised while the work was being specified and had not been answered when the release decision was recorded.';
      return `
      <div class="q">
        <div class="q-when">Question asked on ${esc(longDate(f.createdAt))}</div>
        <div class="q-ask">${esc(f.content.question ?? '')}</div>
        ${quote ? `<p class="q-quote">About the wording: "${esc(quote)}"</p>` : ''}
        <p class="q-note">${note}</p>
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
  <p class="sub">Release ${esc(verdict.sourceRef ?? 'unrecorded')} · decision recorded on ${esc(longDate(verdict.createdAt))}.</p>

  <h2>Why this decision was made</h2>
  <p>${reason ? esc(reason) : 'No explanation was provided with this decision.'}</p>

  ${
    questions.length
      ? // N1: the heading is the strongest claim on the page — on the fallback branch,
        // "still open when this decision was made" is exactly the fact C1 established the
        // ledger never recorded for a pre-liveFindings verdict, so it must not claim more
        // than the softened note below it does. The approved wording stays exactly as-is
        // on the liveFindings-present branch, where it's true.
        `<h2>${usingFallback ? 'Questions cited in this decision' : 'Questions that were still open when this decision was made'}</h2>${questionBlocks}`
      : ''
  }

  ${
    dropped.length
      ? `<div class="override">
    <strong>This decision covered fewer areas than were assessed earlier.</strong>
    <p>Assessed, but left out of this decision:</p>
    <ul>${dropped.map((ref) => `<li>${esc(ref)}</li>`).join('')}</ul>
  </div>`
      : ''
  }

  ${
    assumptions.length
      ? `<h2>Answered by accepting a suggested default</h2>
  <p>These questions were answered by accepting the audit's suggestion as written. Nobody is
  recorded as having reworded or reconsidered them.</p>
  ${assumptions
    .map(
      (a: { question: string; answer: string }) => `<div class="q">
        <div class="q-ask">${esc(a.question)}</div>
        <p class="q-note">Answer: ${esc(a.answer)}</p>
      </div>`,
    )
    .join('')}`
      : ''
  }

  ${
    suspect.length
      ? `<h2>Requirements that changed after they were last checked</h2>
  <p>These were edited after their wording was last reviewed for unclear points, so questions
  answered and tests written against the earlier wording may no longer fit.</p>
  <ul>${suspect.map((ref) => `<li>${esc(ref)}</li>`).join('')}</ul>`
      : ''
  }

  ${
    untested.length
      ? `<h2>Changed areas with no tests</h2>
  <p>Nothing records a test for these, so nothing checked that they still work.</p>
  <ul>${untested.map((ref) => `<li>${esc(ref)}</li>`).join('')}</ul>`
      : ''
  }

  ${failingTests.length ? `<h2>Tests that were failing when this decision was made</h2>${testBlocks}` : ''}

  ${
    retracted.length
      ? `<h2>Withdrawn as recorded by mistake</h2>
  <p>A person withdrew these before the decision, so they did not count towards it.</p>
  ${retracted
    .map(
      (r) => `<div class="q">
        <div class="q-when">${esc(WITHDRAWN_KIND[String(r.type)] ?? 'Record')} · withdrawn by ${esc(r.by)}${r.at ? ` on ${esc(longDate(r.at))}` : ''}</div>
        <div class="q-ask">${esc(r.name)}</div>
        <p class="q-note">Reason given: ${esc(r.reason)}</p>
      </div>`,
    )
    .join('')}`
      : ''
  }

  ${
    changed.length
      ? // A heading with an empty list under it (e.g. a verdict recorded before `changed`
        // existed, like this store's own legacy verdict_cb0d0a62) reads as a rendering
        // failure, not as "nothing to show" — omit the whole section, heading included.
        `<h2>What this release touches</h2>
  <ul>${changed
    .map(
      (ref) =>
        `<li>${esc(ref)}${unmatched.has(ref) ? ' <span class="uncovered">— changed, but no requirement covers it</span>' : ''}</li>`,
    )
    .join('')}</ul>`
      : ''
  }

  <h2>Who made this decision</h2>
  <p class="who">${who}</p>
  ${
    override
      ? `<div class="override">
    <strong>⚠ This release was cleared even though ${overrideTension}.</strong>
    <p>Reason given at the time:</p>
    <p>"${esc(override.reason ?? '')}"</p>
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
