import type { TraceStore } from './trace/store.ts';
import type { Artifact, Edge, Provenance } from './trace/schema.ts';

const INSTRUCTIONS =
  'Write a one-page release brief, then record it with release_submit. Cite an artifact id ' +
  'for every claim you make and never invent one. Each signal is blocking: a `ship` verdict ' +
  'is rejected while any signal is present unless you pass an explicit override with a ' +
  'reason. A failing test whose `flaky` is true failed on a commit it also passed on: say so. ' +
  '`context` is unscored evidence — report any `unmatched` ref, which is code that moved ' +
  'with no requirement covering it, and any test listed in `flaky`.';

/**
 * Something on an area this release touched that blocks a ship: an unanswered
 * requirement-stage question, or a covering test whose latest run failed. Every signal
 * blocks; there is deliberately no `blocking` field, because it would be true on all of them.
 * Add one when a non-blocking signal kind exists.
 */
export type RiskSignal =
  | {
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
    }
  | {
      kind: 'failing_test_on_changed_area';
      artifacts: string[];
      detail: FailingTest;
    };

export type FailingTest = {
  testRunId: string;
  testCaseId: string;
  requirementId: string;
  sourceRef: string | null;
  name: string;
  status: string;
  message: string | null;
  /** Failed on a commit it also passed on. Reported, never excused: it still blocks. */
  flaky: boolean;
};

const BLOCKING_STATUS = new Set(['failed', 'error']);

/** Flaky: ingest saw it pass and fail in one report, or two runs on one commit disagree. */
export function isFlaky(runs: Artifact[]): boolean {
  if (runs.some((r) => r.content.flaky === true)) return true;
  const byCommit = new Map<string, Set<string>>();
  for (const r of runs) {
    const commit = r.content.commit;
    if (typeof commit !== 'string' || !commit) continue;
    const statuses = byCommit.get(commit) ?? new Set();
    statuses.add(String(r.content.status));
    byCommit.set(commit, statuses);
  }
  return [...byCommit.values()].some(
    (s) => s.has('passed') && [...s].some((status) => BLOCKING_STATUS.has(status)),
  );
}

/**
 * Makes no model call. Like `auditRequirement`, this is a librarian: it computes the one
 * deterministic signal and hands over the surrounding evidence for the caller to reason over.
 *
 * Changed-ness is never inferred transitively. `chain()` walks both directions without bound,
 * so deriving it through edges would let one changed file mark every requirement in the store
 * as changed, and every release would block on everything.
 *
 * ponytail: a finding retires the moment anything supersedes it, regardless of what wrote that
 * edge — `openFindings` only checks that a `supersedes` edge exists, not that it came from
 * `audit_answer`. So `trace_record` can retire a live finding directly (or write a `type:
 * 'verdict'` artifact outright, bypassing this gate altogether), leaving no signal, no
 * override, and no trace here that either happened — the same hole `audit_answer` documents
 * for its own guard at src/audit.ts:206-213. Upgrade path: same as there, a store-level
 * guard or constraint that only the gated recorders can satisfy, once this project has a
 * migration story.
 */
export function assessReleaseRisk(
  store: TraceStore,
  input: { changed: string[]; releaseRef?: string },
) {
  const changed = [...new Set(input.changed.map((r) => r.trim()).filter((r) => r))];
  if (!changed.length) throw new Error('changed must not be empty');

  const matched = store.bySourceRef(changed);
  const matchedRefs = new Set(matched.map((a) => a.sourceRef));
  const unmatched = changed.filter((ref) => !matchedRefs.has(ref));
  const requirements = matched.filter((a) => a.type === 'requirement');

  // ponytail: one openFindings query per changed requirement. Fine for a release; batch into
  // a single query if a release ever touches hundreds of requirements.
  // ponytail: an orphaned finding (no derived_from edge to a requirement) never reaches
  // `signals` — not because it "cannot be attributed to a changed area": bySourceRef(changed)
  // already attributed it, it is sitting in `matched` a few lines up, matched by the same
  // exact-sourceRef rule as everything else. It is dropped because `requirements` above keeps
  // only `matched.filter(a => a.type === 'requirement')`, and openFindings(500, req.id) below
  // only returns findings linked to that one requirement id — an orphan satisfies neither.
  // The real reason to exclude it: a finding with no parent requirement has no requirement
  // stage to be a "requirement-stage finding" of. openQuestions in src/audit.ts (see the
  // comment at src/audit.ts:167) deliberately disagrees and surfaces exactly this case, with
  // `requirement: null`, so a broken edge cannot hide work from the audit queue — the two
  // modules read the same shape differently on purpose. Upgrade: surface orphaned findings
  // here too, as unresolved context rather than a blocking signal.
  const findingSignals: RiskSignal[] = requirements.flatMap((req) =>
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

  // The latest run decides: a later pass clears an earlier failure without superseding it.
  // Every covering test counts, whoever recorded it, not only ingested ones.
  const flaky: { testCaseId: string; requirementId: string; name: string }[] = [];
  const testSignals: RiskSignal[] = requirements.flatMap((req) =>
    store.linkedFrom(req.id, 'covers', 'test_case').flatMap((tc) => {
      const runs = store.linkedFrom(tc.id, 'verifies', 'test_run');
      const latest = runs[0];
      if (!latest) return [];
      const name = String(tc.content.name ?? tc.sourceRef ?? tc.id);
      const unreliable = isFlaky(runs);
      if (unreliable) flaky.push({ testCaseId: tc.id, requirementId: req.id, name });
      const status = String(latest.content.status);
      if (!BLOCKING_STATUS.has(status)) return [];
      return [
        {
          kind: 'failing_test_on_changed_area' as const,
          artifacts: [latest.id, tc.id, req.id],
          detail: {
            testRunId: latest.id,
            testCaseId: tc.id,
            requirementId: req.id,
            sourceRef: req.sourceRef,
            name,
            status,
            message: typeof latest.content.message === 'string' ? latest.content.message : null,
            flaky: unreliable,
          },
        },
      ];
    }),
  );
  const signals = [...findingSignals, ...testSignals];

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
    flaky,
    context: { nodes: [...nodes.values()], edges: [...edges.values()] },
    instructions: INSTRUCTIONS,
  };
}

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
 * ponytail: covers only snake_case relations, camelCase field names, and artifact ids.
 * Ordinary English verbs that happen to be relation names (supersedes, covers, verifies,
 * contradicts, reviews) are deliberately allowed — they are not jargon to a project manager.
 */
const INTERNAL_TERMS: RegExp[] = [
  /\bderived_from\b/i,
  // M2: source_ref and prompt_version are the literal column/field names an agent sees if
  // it reads the schema directly, not just their camelCase wire-format twins.
  /\b(sourceRef|source_ref|promptVersion|prompt_version|inputDigest)\b/i,
  /\b(test_cases?|test_runs?)\b/i,
  // M1: `[0-9a-f]{8}` also matches eight plain digits, so a date-shaped suffix like
  // defect_20260731 was rejected even though real ids (randomUUID().slice(0,8)) always
  // contain at least one a-f letter — hex has 16 symbols, an all-digit run is one in 6500.
  /\b(requirement|finding|test_case|test_run|defect|verdict|review|answer)_(?!\d{8}\b)[0-9a-f]{8}\b/i,
];

/**
 * The brief renders this text verbatim to a non-technical reader, so the constraint
 * belongs here, where the prose is authored, rather than at render time where the
 * only options are to mangle it or to show it.
 *
 * I3: also exported and reused by `submitFindings` in audit.ts to lint `question`, the other
 * field the brief renders verbatim from AI prose.
 */
export function assertPlainLanguage(field: string, text: string): void {
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
 *
 * ponytail: assess-then-record race: if a superseding answer is recorded between
 * assessReleaseRisk and store.record, the signals list is stale. The cost of re-checking
 * signals post-write exceeds the risk, since this is an uncommon window. Upgrade path:
 * transaction-like semantics if the race becomes a problem.
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
  const releaseRef = input.releaseRef.trim();
  if (!releaseRef) throw new Error('releaseRef must not be blank');

  const reason = input.reason.trim();
  if (!reason) throw new Error('reason must not be blank');
  assertPlainLanguage('reason', reason);

  if (input.verdict !== 'ship' && input.verdict !== 'hold') {
    throw new Error(`verdict must be 'ship' or 'hold', got ${JSON.stringify(input.verdict)}`);
  }

  if (!Array.isArray(input.cites)) throw new Error('cites must be an array');
  const cites = [...new Set(input.cites)];
  for (const id of cites) {
    if (!store.get(id)) throw new Error(`cites unknown artifact ${id}`);
  }

  let overrideReason: string | null = null;
  if (input.override) {
    overrideReason = input.override.reason?.trim() ?? '';
    if (!overrideReason) throw new Error('override.reason must not be blank');
    assertPlainLanguage('override.reason', overrideReason);
  }
  if (overrideReason && input.verdict === 'hold') {
    throw new Error('override is only meaningful with a ship verdict');
  }

  const { release, signals, matched } = assessReleaseRisk(store, { changed: input.changed });
  const liveFindings = signals.flatMap((s) => (s.kind === 'unresolved_finding_on_changed_area' ? [s.detail.findingId] : []));
  const failing = signals.flatMap((s) => (s.kind === 'failing_test_on_changed_area' ? [s.detail] : []));
  const liveTestRuns = [...new Set(failing.map((t) => t.testRunId))];
  if (input.verdict === 'ship' && signals.length && !overrideReason) {
    const counts = [
      ...(liveFindings.length ? [`${liveFindings.length} unresolved finding(s)`] : []),
      ...(failing.length ? [`${failing.length} failing test(s)`] : []),
    ];
    const named = signals
      .map((s) =>
        s.kind === 'unresolved_finding_on_changed_area'
          ? `${s.detail.findingId} (${s.detail.sourceRef ?? 'no sourceRef'})`
          : `${s.detail.testRunId} (${s.detail.name}${s.detail.flaky ? ', flaky' : ''})`,
      )
      .join(', ');
    throw new Error(
      `cannot ship: ${counts.join(' and ')} on changed areas: ${named} — ` +
        'answer questions with audit_answer, fix or rerun failing tests, or pass override with a reason',
    );
  }

  // An override that actually overrides something needs a name against it. Free text alone
  // was tolerable while overriding required a person at a terminal; a pipeline that can
  // record one widens that to anyone able to edit a workflow file, so "who accepted this
  // risk" stops being optional. Gated on `signals.length` for the same reason the override
  // itself is (see below): an override that overrode nothing is discarded, not enforced, so
  // demanding a name for it would reject the defensive caller I1 exists to tolerate.
  if (overrideReason && signals.length && !input.provenance.approvedBy?.trim()) {
    throw new Error(
      'override requires provenance.approvedBy naming who accepted the risk',
    );
  }

  // I1/I2: record an override only when it actually overrode a live signal — otherwise a
  // defensively-always-sent override would land on a clean release, and the Inspector's
  // "⚠ shipped over unresolved findings" callout would be asserting something false. And
  // when it did override something, record which findings were live at decision time: "we
  // shipped over an open question, and here is who said that was fine" is only half a fact
  // without knowing which question.
  const override =
    overrideReason && signals.length
      ? { reason: overrideReason, findings: liveFindings, ...(liveTestRuns.length ? { testRuns: liveTestRuns } : {}) }
      : null;

  return store.record({
    type: 'verdict',
    sourceRef: releaseRef,
    content: {
      verdict: input.verdict,
      reason,
      // reuse the normalization assessReleaseRisk already did, rather than re-deriving
      // an identical `changed` list here — a duplicate that could silently drift.
      changed: release.changed,
      unmatched: matched.unmatched,
      override,
      // C1: the findings actually open at decision time, on every verdict — not just when
      // there is an override. `cites` (below, the derived_from edges) means "artifacts this
      // brief refers to", which release_submit's own instructions tell the agent to use for
      // every claim, including a finding cited to say it was resolved. Section 3 of the
      // brief must not be built from `cites`, or a resolved finding renders as an open
      // question, and a hold that cites a failing test run instead of any finding renders no
      // questions section even though one was live. `signals` is the one place that already
      // means "open right now" — see brief.ts for the read side and its fallback for
      // verdicts recorded before this field existed.
      liveFindings,
      // The failing runs that were latest at decision time, by the same reasoning as
      // liveFindings: the brief must say what was failing *then*, not what fails now.
      liveTestRuns,
    },
    provenance: input.provenance,
    links: cites.map((to) => ({ to, relation: 'derived_from' as const })),
  });
}
