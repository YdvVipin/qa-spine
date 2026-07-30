import type { TraceStore } from './trace/store.ts';
import type { Artifact, Edge, Provenance } from './trace/schema.ts';

const INSTRUCTIONS =
  'Write a one-page release brief, then record it with release_submit. Cite an artifact id ' +
  'for every claim you make and never invent one. Each signal is blocking: a `ship` verdict ' +
  'is rejected while any signal is present unless you pass an explicit override with a ' +
  'reason. `context` is unscored evidence — report failing test runs you find there, and ' +
  'report any `unmatched` ref, which is code that moved with no requirement covering it.';

/**
 * One unresolved requirement-stage question on something this release touched. Every signal
 * blocks; there is deliberately no `blocking` field, because it would be true on all of them.
 * Add one when a second, non-blocking signal kind exists.
 */
export type RiskSignal = {
  kind: 'unresolved_finding_on_changed_area';
  artifacts: string[];
  detail: {
    findingId: string;
    requirementId: string;
    sourceRef: string | null;
    category: unknown;
    quote: unknown;
    question: unknown;
    confidence: unknown;
  };
};

/**
 * Makes no model call. Like `auditRequirement`, this is a librarian: it computes the one
 * deterministic signal and hands over the surrounding evidence for the caller to reason over.
 *
 * Changed-ness is never inferred transitively. `chain()` walks both directions without bound,
 * so deriving it through edges would let one changed file mark every requirement in the store
 * as changed, and every release would block on everything.
 */
export function assessReleaseRisk(
  store: TraceStore,
  input: { changed: string[]; releaseRef?: string },
) {
  const changed = [...new Set(input.changed)];
  if (!changed.length) throw new Error('changed must not be empty');

  const matched = store.bySourceRef(changed);
  const matchedRefs = new Set(matched.map((a) => a.sourceRef));
  const unmatched = changed.filter((ref) => !matchedRefs.has(ref));
  const requirements = matched.filter((a) => a.type === 'requirement');

  // ponytail: one openFindings query per changed requirement. Fine for a release; batch into
  // a single query if a release ever touches hundreds of requirements.
  const signals: RiskSignal[] = requirements.flatMap((req) =>
    store.openFindings(500, req.id).map((f) => ({
      kind: 'unresolved_finding_on_changed_area' as const,
      artifacts: [f.id, req.id],
      detail: {
        findingId: f.id,
        requirementId: req.id,
        sourceRef: req.sourceRef,
        category: f.content.category ?? null,
        quote: f.content.quote ?? null,
        question: f.content.question ?? null,
        confidence: f.content.confidence ?? null,
      },
    })),
  );

  // ponytail: merges whole chain() results, which on a densely linked store could be a large
  // subgraph. Bound the walk by depth if that becomes a problem.
  const nodes = new Map<string, Artifact>();
  const edges = new Map<string, Edge>();
  for (const artifact of matched) {
    const chain = store.chain(artifact.id);
    if (!chain) continue;
    for (const node of chain.nodes) nodes.set(node.id, node);
    for (const e of chain.edges) {
      edges.set(`${e.fromArtifactId}>${e.toArtifactId}:${e.relation}`, e);
    }
  }

  return {
    release: { ref: input.releaseRef ?? null, changed },
    matched: { requirements: requirements.map((r) => r.id), unmatched },
    signals,
    context: { nodes: [...nodes.values()], edges: [...edges.values()] },
    instructions: INSTRUCTIONS,
  };
}

/**
 * Records a release verdict, refusing a `ship` while any signal is live.
 *
 * The signals are recomputed here from `changed` and are never taken from the caller. An
 * agent that supplied its own signal list could wave a release through by omitting the
 * blocker, which is precisely what this phase exists to prevent — so the cost is that
 * `changed` must be passed again after `assess_release_risk`.
 *
 * ponytail: the override is unstructured free text and is not gated on `approvedBy`. Anyone
 * who can call this can ship over a blocker by supplying a reason. Visibility, not
 * prevention — the same trade-off as an AI answer resolving a finding in phase 2.5. Upgrade
 * path: require `provenance.approvedBy` before an override counts.
 */
export function recordVerdict(
  store: TraceStore,
  input: {
    releaseRef: string;
    verdict: 'ship' | 'hold';
    reason: string;
    cites: string[];
    changed: string[];
    override?: { reason: string };
    provenance: Provenance;
  },
): Artifact {
  const reason = input.reason.trim();
  if (!reason) throw new Error('reason must not be blank');

  const cites = [...new Set(input.cites)];
  for (const id of cites) {
    if (!store.get(id)) throw new Error(`cites unknown artifact ${id}`);
  }

  const overrideReason = input.override?.reason.trim();
  const override = overrideReason ? { reason: overrideReason } : null;
  if (override && input.verdict === 'hold') {
    throw new Error('override is only meaningful with a ship verdict');
  }

  const { signals } = assessReleaseRisk(store, { changed: input.changed });
  if (input.verdict === 'ship' && signals.length && !override) {
    const named = signals
      .map((s) => `${s.detail.findingId} (${s.detail.sourceRef ?? 'no sourceRef'})`)
      .join(', ');
    throw new Error(
      `cannot ship: ${signals.length} unresolved finding(s) on changed areas: ${named} — ` +
        'answer them with audit_answer, or pass override with a reason',
    );
  }

  return store.record({
    type: 'verdict',
    sourceRef: input.releaseRef,
    content: { verdict: input.verdict, reason, changed: [...new Set(input.changed)], override },
    provenance: input.provenance,
    links: cites.map((to) => ({ to, relation: 'derived_from' as const })),
  });
}
