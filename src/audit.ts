import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { TraceStore } from './trace/store.ts';

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
