import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { TraceStore } from './trace/store.ts';
import type { Artifact, Provenance } from './trace/schema.ts';

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
  'requirement. `confidence` is one of high, medium, low, unknown. Submit with audit_submit.';

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
 * past what is comfortable in a tool result, return only rules whose triggers appear.
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
  if (!input.findings.length) throw new Error('findings must not be empty');

  const findings = z.array(AuditFinding).parse(input.findings);

  const rubric = loadRubric();
  const ids = new Set(rubric.rules.map((r) => r.id));

  for (const f of findings) {
    if (!ids.has(f.category)) {
      throw new Error(
        `unknown rule "${f.category}" — rubric ${rubric.version} defines: ${[...ids].join(', ')}`,
      );
    }
    // The Inspector already runs this comparison at render time to flag a bad quote.
    // Running it at write time makes a hallucinated quote unrecordable instead.
    if (!requirement.text.includes(f.quote)) {
      throw new Error(`quote not found in requirement text: "${f.quote}"`);
    }
  }

  return findings.map((f) =>
    store.record({
      type: 'finding',
      sourceRef: requirement.sourceRef,
      content: { ...f },
      // promptVersion is the one provenance field the server can honestly author, and
      // it is what makes a rubric edit measurable against the exported review labels.
      provenance: { ...input.provenance, promptVersion: rubric.version },
      links: [{ to: requirement.id, relation: 'derived_from' }],
    }),
  );
}
