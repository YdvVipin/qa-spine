import type { TraceStore } from './trace/store.ts';
import type { RequirementStatus } from './release.ts';
import { esc } from './brief.ts';

/**
 * The traceability matrix in the three shapes people ask for: CSV for a spreadsheet or an
 * auditor, HTML to send (the brief's rules: inline CSS, no script, no external request), and
 * JSONL of every artifact and edge, a complete copy of the ledger.
 */

/** Quoted, and a leading = + - @ defused with an apostrophe so a spreadsheet shows it as text. */
const csvCell = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replaceAll('"', '""')}"`;
const yesNo = (b: boolean) => (b ? 'yes' : 'no');

export function renderCsv(rows: RequirementStatus[]): string {
  const header = 'ref,status,open_questions,answered,assumptions,tests,failing,flaky,suspect,untested,text';
  const body = rows.map((r) =>
    [
      csvCell(r.sourceRef ?? r.requirementId),
      r.status,
      r.open,
      r.answered,
      r.assumptions,
      r.tests,
      r.failing,
      r.flaky,
      yesNo(r.suspect),
      yesNo(r.untested),
      csvCell(r.text),
    ].join(','),
  );
  return [header, ...body].join('\n') + '\n';
}

const STATUS_WORDS = { blocked: 'Blocked', warning: 'Needs attention', clear: 'Clear' };

export function renderMatrixHtml(rows: RequirementStatus[], generatedAt = new Date()): string {
  const notes = (r: RequirementStatus) =>
    [
      r.open ? `${r.open} unanswered question${r.open === 1 ? '' : 's'}` : '',
      r.failing ? `${r.failing} failing test${r.failing === 1 ? '' : 's'}` : '',
      r.flaky ? `${r.flaky} flaky` : '',
      r.suspect ? 'edited since last checked' : '',
      r.untested ? 'no tests' : '',
      r.assumptions ? `${r.assumptions} answer${r.assumptions === 1 ? '' : 's'} accepted as suggested` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Traceability matrix</title>
<style>
  body { margin:0; padding:2rem 1.25rem; font:15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color:#1a1d23; background:#fff; }
  h1 { font-size:1.6rem; margin:0 0 .25rem; } .sub { color:#5c6472; margin:0 0 1.5rem; }
  .wrap { overflow-x:auto; } table { border-collapse:collapse; width:100%; }
  th, td { text-align:left; padding:.5rem .7rem; border-bottom:1px solid #e2e5ea; vertical-align:top; }
  th { font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; color:#5c6472; }
  td.n { font-variant-numeric:tabular-nums; } .blocked { color:#b8431c; font-weight:600; } .warning { color:#8a5a00; font-weight:600; } .clear { color:#1f7a4a; }
</style></head><body>
<h1>Traceability matrix</h1>
<p class="sub">${rows.length} requirement${rows.length === 1 ? '' : 's'} · generated ${esc(generatedAt.toISOString().slice(0, 16).replace('T', ' '))} UTC</p>
<div class="wrap"><table>
<thead><tr><th>Requirement</th><th>Status</th><th>Tests</th><th>Questions answered</th><th>Notes</th><th>Text</th></tr></thead>
<tbody>
${rows
  .map(
    (r) => `<tr><td>${esc(r.sourceRef ?? '(no reference)')}</td><td class="${r.status}">${STATUS_WORDS[r.status]}</td>` +
      `<td class="n">${r.tests}</td><td class="n">${r.answered}</td><td>${esc(notes(r))}</td><td>${esc(r.text)}</td></tr>`,
  )
  .join('\n')}
</tbody></table></div>
</body></html>
`;
}

export function dumpJsonl(store: TraceStore): string {
  const artifacts = store.list(undefined, 1e9).reverse();
  const lines = [
    ...artifacts.map((a) => JSON.stringify({ kind: 'artifact', ...a })),
    ...artifacts.flatMap((a) => store.edgesFrom(a.id).map((e) => JSON.stringify({ kind: 'edge', ...e }))),
  ];
  return lines.join('\n') + '\n';
}
