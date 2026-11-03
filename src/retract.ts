import type { TraceStore } from './trace/store.ts';
import type { Artifact } from './trace/schema.ts';

/** Types that have their own way out, and what to do instead. */
const NOT_RETRACTABLE: Partial<Record<Artifact['type'], string>> = {
  finding: 'answer it instead (qa-spine answer, or the Inspector\'s audit queue) — a question is retired by an answer',
  verdict: 'record a new decision instead — a release decision is a record of what was known at the time',
};

/**
 * Withdraws an artifact recorded by mistake. Nothing is removed: a `retraction` naming who and
 * why is appended with a `retracts` edge, and every "what is current" view stops counting the
 * target. Undo is the same act aimed at the retraction.
 *
 * Only a person does this — the CLI and the Inspector call it; no MCP tool does, so an agent
 * cannot withdraw its own failing test run.
 *
 * ponytail: `by` is whatever name was typed. The CLI cannot check it and the Inspector has no
 * login; it is a name on the record, not an identity. Upgrade: take it from a signed commit or
 * an authenticated session once the Inspector has one.
 *
 * ponytail: check-then-write, like recordAnswer — two people retracting the same artifact at
 * the same moment both succeed. Harmless: either retraction withdraws it, and undoing one
 * leaves the other in force, which the second person can see.
 */
export function recordRetraction(store: TraceStore, input: { id: string; by: string; reason: string }): Artifact {
  const by = input.by?.trim();
  if (!by) throw new Error('a retraction needs a name: who is withdrawing this');
  const reason = input.reason?.trim();
  if (!reason) throw new Error('a retraction needs a reason: why this was a mistake');

  const target = store.get(input.id);
  if (!target) throw new Error(`no artifact with id ${input.id}`);
  const instead = NOT_RETRACTABLE[target.type];
  if (instead) throw new Error(`a ${target.type} cannot be retracted — ${instead}`);

  const existing = store.retractionOf(target.id);
  if (existing) {
    throw new Error(
      `${target.id} is already retracted by ${existing.content.retractedBy} (${existing.id}) — ` +
        `to put it back, retract ${existing.id}`,
    );
  }

  return store.record({
    type: 'retraction',
    content: {
      reason,
      retractedBy: by,
      // Kept on the record so a list of retractions reads without a lookup per row.
      targetType: target.type,
      ...(target.type === 'retraction' ? { undo: true } : {}),
    },
    provenance: { producer: 'human', approvedBy: by, approvedAt: new Date().toISOString() },
    links: [{ to: target.id, relation: 'retracts' }],
  });
}
