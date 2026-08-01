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
        ${quote ? `<p class="q-quote">About the wording: "${esc(quote)}"</p>` : ''}
        <p class="q-note">This question was raised while the work was being specified and had not been answered when the release decision was recorded.</p>
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
