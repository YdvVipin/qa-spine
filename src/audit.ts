import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { TraceStore } from './trace/store.ts';
import type { Artifact, Provenance } from './trace/schema.ts';
import { assertPlainLanguage } from './release.ts';

/**
 * A rubric is published, versioned data — the thing a team argues about in review.
 * `triggers` are advisory hints for the model, not patterns the server runs: a rule
 * can fire legitimately on a synonym nobody listed.
 */
export const RubricRule = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  test: z.string().optional(),
  triggers: z.array(z.string()).optional(),
  ask: z.string().min(1),
});

export const Rubric = z.object({
  version: z.string().min(1),
  rules: z.array(RubricRule).min(1),
});

export type RubricRule = z.infer<typeof RubricRule>;
export type Rubric = z.infer<typeof Rubric>;

/** Resolves from source and from a built `dist` alike: both sit one level under the package root. */
export function rubricsDir(): string {
  return process.env.QA_SPINE_RUBRICS
    ? resolve(process.env.QA_SPINE_RUBRICS)
    : resolve(import.meta.dirname, '..', 'rubrics');
}

/**
 * Read at tool-call time rather than at startup, so a malformed rubric cannot stop the
 * trace tools from working.
 */
export function loadRubric(name = 'ambiguity'): Rubric {
  const path = resolve(rubricsDir(), `${name}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`rubric unreadable at ${path}: ${err instanceof Error ? err.message : err}`);
  }
  const parsed = Rubric.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`rubric ${name} failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

const INSTRUCTIONS =
  'For each rule that fires, return { category, quote, question, confidence }. ' +
  '`category` must be a rule id from this rubric. `quote` must be copied verbatim from the ' +
  'requirement text — it is checked on submit, and a quote that is not present rejects the ' +
  'whole submission. `question` is for a human to answer: never return a rewritten ' +
  'requirement, and write it in plain language a project manager would understand — no ' +
  'internal identifiers, relation names, or system terminology, or the submission is ' +
  'rejected. `confidence` is one of high, medium, low, unknown. Where a sensible default ' +
  'exists, add `suggestedAnswer`: a plain-language answer a human can accept in one step, ' +
  'which is then recorded as an assumption. Submit with audit_submit — ' +
  'with an empty findings list when no rule fires, which records that the audit was clean.';

/** Loads a requirement and proves it is auditable. Shared by both audit tools. */
function requirementFor(store: TraceStore, id: string) {
  const artifact = store.get(id);
  if (!artifact) throw new Error(`no artifact with id ${id}`);
  if (artifact.type !== 'requirement') {
    throw new Error(`artifact ${id} is a ${artifact.type}, not a requirement`);
  }
  const text = artifact.content.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`requirement ${id} has no content.text to audit`);
  }
  return { id: artifact.id, sourceRef: artifact.sourceRef, text };
}

/**
 * Makes no model call. This tool is a librarian: it hands over the text and the rules.
 *
 * ponytail: returns the whole rubric on every call. Fine at four rules; if rubrics grow
 * past what is comfortable in a tool result, split the rubric file by concern (e.g.
 * ambiguity vs. testability) and let the caller ask for one, or paginate `rules`.
 */
export function auditRequirement(store: TraceStore, requirementId: string) {
  return {
    requirement: requirementFor(store, requirementId),
    rubric: loadRubric(),
    instructions: INSTRUCTIONS,
  };
}

/** The shape a finding must arrive in. Deliberately no `suggestedRewrite`: this phase asks, it does not rewrite. */
export const AuditFinding = z.object({
  category: z.string().min(1).describe('A rule id from the rubric returned by audit_requirement.'),
  quote: z.string().min(1).describe('Copied verbatim from the requirement text.'),
  question: z.string().min(1).describe('What a human needs to answer to remove the ambiguity.'),
  confidence: z.enum(['high', 'medium', 'low', 'unknown']),
  severity: z.enum(['high', 'medium', 'low']).optional(),
  suggestedAnswer: z
    .string()
    .min(1)
    .optional()
    .describe('A sensible default a human can accept in one step. Accepting it is recorded as an assumption.'),
});
export type AuditFinding = z.infer<typeof AuditFinding>;

/**
 * Validates every finding and requirement reference before writing any of them. Zod
 * parsing strips unknown keys (e.g., `suggestedRewrite`) and rejects bad enum values.
 * Validation is all-or-nothing: if any finding fails, no artifacts are recorded.
 *
 * ponytail: re-auditing a requirement appends duplicate findings; there is no dedup.
 * Fine while audits are human-triggered one at a time. If that changes, skip findings
 * whose (category, quote) pair already exists on the requirement.
 *
 * ponytail: each store.record() is its own transaction, so a mid-batch failure (e.g.,
 * SQLITE_FULL) leaves earlier findings permanently recorded. To make batch writes truly
 * atomic, add `store.recordMany()` and refactor to batch BEGIN/COMMIT at the store level.
 */
export function submitFindings(
  store: TraceStore,
  input: { requirementId: string; findings: AuditFinding[]; provenance: Provenance },
): Artifact[] {
  const requirement = requirementFor(store, input.requirementId);

  const findings = z.array(AuditFinding).parse(input.findings);

  const rubric = loadRubric();
  const ids = new Set(rubric.rules.map((r) => r.id));

  for (const f of findings) {
    if (!ids.has(f.category)) {
      throw new Error(
        `unknown rule "${f.category}" — rubric ${rubric.version} defines: ${[...ids].join(', ')}`,
      );
    }
    if (!f.quote.trim()) {
      throw new Error(`quote is blank: "${f.quote}"`);
    }
    // The Inspector already runs this comparison at render time to flag a bad quote.
    // Running it at write time makes a hallucinated quote unrecordable instead.
    if (!requirement.text.includes(f.quote)) {
      throw new Error(`quote not found in requirement text: "${f.quote}"`);
    }
    // I3: `question` is the other field the brief renders verbatim from AI prose (release.ts
    // only ever lints `reason` and `override.reason`), and audit_submit constrained it with
    // only z.string().min(1) — so a question naming an artifact id or a snake_case relation
    // sailed straight onto the page. Fix at the authoring end, per the same principle
    // release.ts already uses: the constraint belongs where the prose is written, not at
    // render time where the only options are to mangle it or show it. `quote` is
    // deliberately left unlinted — it's a verbatim substring of the requirement, checked
    // just above, and linting it would make legitimate requirements unrecordable.
    assertPlainLanguage('question', f.question);
    // Accepting a suggestion puts it on the brief word for word, so it gets the same lint.
    if (f.suggestedAnswer !== undefined) assertPlainLanguage('suggestedAnswer', f.suggestedAnswer);
  }

  // promptVersion is the one provenance field the server can honestly author, and it is what
  // makes a rubric edit measurable against the exported review labels.
  const provenance = { ...input.provenance, promptVersion: rubric.version };

  // Nothing found is a result too: it is what shows an edited requirement was re-checked,
  // and it is the true negative a rubric measurement needs.
  if (!findings.length) {
    return [
      store.record({
        type: 'audit',
        sourceRef: requirement.sourceRef,
        content: { rubricVersion: rubric.version, findings: 0 },
        provenance,
        links: [{ to: requirement.id, relation: 'derived_from' }],
      }),
    ];
  }

  return store.transaction(() => findings.map((f) =>
    store.record({
      type: 'finding',
      sourceRef: requirement.sourceRef,
      content: { ...f },
      provenance,
      links: [{ to: requirement.id, relation: 'derived_from' }],
    }),
  ));
}

/** The requirement a finding came from, if that edge is intact. */
function requirementOf(store: TraceStore, findingId: string): Artifact | undefined {
  return store
    .edgesFrom(findingId)
    .filter((e) => e.relation === 'derived_from')
    .map((e) => store.get(e.toArtifactId))
    .find((a) => a?.type === 'requirement');
}

/**
 * Every question still waiting on an answer, each carrying enough of its requirement to be
 * answered without a second call. A finding whose parent requirement is missing still
 * appears, with `requirement: null` — a broken edge must not hide work from the queue.
 */
export function openQuestions(store: TraceStore, requirementId?: string) {
  const open = store.openFindings(500, requirementId).map((f) => {
    const parent = requirementOf(store, f.id);
    return {
      findingId: f.id,
      category: f.content.category ?? null,
      quote: f.content.quote ?? null,
      question: f.content.question ?? null,
      confidence: f.content.confidence ?? null,
      suggestedAnswer: f.content.suggestedAnswer ?? null,
      requirement: parent
        ? { id: parent.id, sourceRef: parent.sourceRef, text: String(parent.content.text ?? '') }
        : null,
    };
  });
  return { open };
}

/**
 * Records a human's or an agent's answer to an open question. The `supersedes` edge is what
 * retires the finding — the chain view already treats a finding with nothing superseding it
 * as unresolved, so this needs no new concept.
 *
 * Provenance is recorded exactly as given. Unlike `submitFindings`, the server does not own
 * this artifact and has no rubric version to stamp: an AI answer stays visibly an AI answer.
 */
export function recordAnswer(
  store: TraceStore,
  input: { findingId: string; answer: string; provenance: Provenance; by?: string },
): Artifact {
  const finding = store.get(input.findingId);
  if (!finding) throw new Error(`no artifact with id ${input.findingId}`);
  if (finding.type !== 'finding') {
    throw new Error(`artifact ${input.findingId} is a ${finding.type}, not a finding`);
  }

  const answer = input.answer.trim();
  if (!answer) throw new Error('answer must not be blank');

  // ponytail: check-then-write, reachable across processes, not just within one — `npm run
  // inspect` and the MCP server each open the same dbPath() as a separate process, so two
  // processes can both pass this check before either writes, leaving two `supersedes` edges
  // on one finding. `trace_record` also bypasses this guard entirely, since it writes
  // straight to the store. Upgrade path: a partial unique index —
  // `CREATE UNIQUE INDEX ... ON edges(to_id) WHERE relation = 'supersedes'` — deliberately
  // not added here, since it would hard-fail on any existing store that already holds two
  // `supersedes` edges on one finding, and this project has no migration story.
  // A retracted answer no longer resolves anything: its question is open again and answerable.
  const resolver = store
    .edgesTo(input.findingId)
    .find((e) => e.relation === 'supersedes' && !store.isRetracted(e.fromArtifactId));
  if (resolver) {
    throw new Error(
      `finding ${input.findingId} is already resolved by ${resolver.fromArtifactId} — ` +
        'if that answer was a mistake, retract it first (qa-spine retract)',
    );
  }

  const requirement = requirementOf(store, input.findingId);
  return store.record({
    type: 'answer',
    sourceRef: requirement?.sourceRef ?? finding.sourceRef,
    content: {
      text: answer,
      // Accepting the audit's suggested default word for word is an assumption, not a
      // decision someone thought through, and the brief says which answers were which.
      ...(answer === String(finding.content.suggestedAnswer ?? '').trim() ? { assumption: true } : {}),
      ...(input.by?.trim() ? { answeredBy: input.by.trim() } : {}),
    },
    provenance: input.provenance,
    links: [
      { to: input.findingId, relation: 'supersedes' },
      // A finding without a parent requirement is still answerable.
      ...(requirement ? [{ to: requirement.id, relation: 'derived_from' as const }] : []),
    ],
  });
}

export type RubricReportRow = {
  promptVersion: string;
  model: string;
  rule: string;
  findings: number;
  reviewed: number;
  good: number;
  bad: number;
  /** good / reviewed. Null when nothing was reviewed: no data is not the same as 0%. */
  precision: number | null;
};

/**
 * Turns the review labels the Inspector collects into "is this rubric version any good?":
 * per rubric version, model and rule, how many findings were raised and how many a person
 * marked good or bad. The latest review of a finding is the one that counts. Clean audits are
 * counted apart, as the true negatives; without them a rubric that flags everything would look
 * as good as one that flags only what matters.
 *
 * ponytail: precision only. Recall needs ambiguities the rubric missed, which nothing records
 * yet. Upgrade: let a reviewer add a missed-ambiguity note on a clean audit, and count those.
 */
export function rubricReport(store: TraceStore): {
  rows: RubricReportRow[];
  cleanAudits: { promptVersion: string; model: string; count: number }[];
} {
  const rows = new Map<string, RubricReportRow>();
  for (const f of store.list('finding', 1e9)) {
    const promptVersion = f.provenance.promptVersion ?? '(none)';
    const model = f.provenance.model ?? f.provenance.producer;
    const rule = String(f.content.category ?? '(none)');
    const key = JSON.stringify([promptVersion, model, rule]);
    const row = rows.get(key) ?? { promptVersion, model, rule, findings: 0, reviewed: 0, good: 0, bad: 0, precision: null };
    row.findings++;
    const latest = store.linkedFrom(f.id, 'reviews', 'review')[0];
    if (latest?.content.verdict === 'good' || latest?.content.verdict === 'bad') {
      row.reviewed++;
      row[latest.content.verdict]++;
    }
    rows.set(key, row);
  }
  for (const row of rows.values()) row.precision = row.reviewed ? row.good / row.reviewed : null;

  const clean = new Map<string, { promptVersion: string; model: string; count: number }>();
  for (const a of store.list('audit', 1e9)) {
    const promptVersion = a.provenance.promptVersion ?? '(none)';
    const model = a.provenance.model ?? a.provenance.producer;
    const key = JSON.stringify([promptVersion, model]);
    const entry = clean.get(key) ?? { promptVersion, model, count: 0 };
    entry.count++;
    clean.set(key, entry);
  }

  const order = (a: { promptVersion: string; model: string }, b: { promptVersion: string; model: string }) =>
    a.promptVersion.localeCompare(b.promptVersion) || a.model.localeCompare(b.model);
  return {
    rows: [...rows.values()].sort((a, b) => order(a, b) || a.rule.localeCompare(b.rule)),
    cleanAudits: [...clean.values()].sort(order),
  };
}

export function renderRubricReport(report: ReturnType<typeof rubricReport>): string {
  const pct = (p: number | null) => (p === null ? '—' : `${Math.round(p * 100)}%`);
  const lines = [
    '## Rubric report',
    '',
    'Precision is the share of reviewed findings a person marked good. Compare versions on the',
    'same rule and model; a row with few reviews says little.',
    '',
    '| Rubric | Model | Rule | Findings | Reviewed | Good | Bad | Precision |',
    '|---|---|---|---|---|---|---|---|',
    ...report.rows.map((r) =>
      `| ${r.promptVersion} | ${r.model} | ${r.rule} | ${r.findings} | ${r.reviewed} | ${r.good} | ${r.bad} | ${pct(r.precision)} |`,
    ),
  ];
  if (report.cleanAudits.length) {
    lines.push('', 'Clean audits (nothing found):');
    for (const c of report.cleanAudits) lines.push(`- ${c.promptVersion} · ${c.model}: ${c.count} clean audit${c.count === 1 ? '' : 's'}`);
  }
  return lines.join('\n');
}
