import type { TraceStore } from './trace/store.ts';
import { RUN_STATUSES, type Artifact, type Edge, type Provenance } from './trace/schema.ts';

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
        suggestedAnswer: unknown;
        /** An AI answer that would retire this question once a person approves it. */
        awaitingApproval: string | null;
      };
    }
  | {
      kind: 'failing_test_on_changed_area';
      artifacts: string[];
      detail: FailingTest;
    };

/** Something on a changed area a person withdrew, with their name and reason. */
export type Retracted = {
  id: string;
  type: string;
  /** What a reader recognises: the ticket key, or the test's name. */
  name: string;
  retractionId: string;
  by: string;
  reason: string;
  at: string;
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
  /**
   * Present only when a later run was recorded by a person and did not clear this failure:
   * the id of that hand-recorded run, and why it did not count. `testRunId` above is still
   * the failing run that decides.
   */
  handRecordedPass?: string;
  heldBecause?: string;
};

const BLOCKING_STATUS = new Set(['failed', 'error']);

export const INGEST_TOOL = 'qa-spine ingest-junit';

/** Recorded by qa-spine's own ingest from a test report, not typed in through a raw write. */
const ingested = (run: Artifact) => run.provenance.producer === 'tool' && run.provenance.tool === INGEST_TOOL;

/**
 * Whether a run may decide a test's state at all. Any run can block, whoever recorded it.
 * Clearing asks more: a run that did not fail, typed in through trace_record or CLI `record`,
 * counts only when it names a person in `provenance.approvedBy`. Otherwise an agent could turn
 * the gate green by recording "passed" after a real failure. The raw paths cannot claim to be
 * the ingest (assertRawRecordAllowed reserves the tool name).
 *
 * ponytail: the name is self-asserted, like an override's. The gate prints it beside the test,
 * so a made-up one is at least visible. Upgrade: authenticated identity (team mode).
 */
const counts = (r: Artifact) =>
  BLOCKING_STATUS.has(String(r.content.status)) || ingested(r) || !!r.provenance.approvedBy?.trim();

/** Why a hand-recorded pass leaves a failing test blocking. Shown in the gate and the brief. */
export const HAND_RECORDED_PASS_HELD = 'latest pass was typed in by hand with no one named in approvedBy';

/** A run that did not fail and is not allowed to clear a failure. */
export const isHandRecordedPass = (run: Artifact): boolean => !counts(run);

/** The build a decision is about. A field left out matches any run; one given matches only runs that carry it. */
export type Scope = { commit?: string; environment?: string };

const inScope = (r: Artifact, scope: Scope) =>
  (!scope.commit || r.content.commit === scope.commit) && (!scope.environment || r.content.environment === scope.environment);

/**
 * What a covering test's runs show, newest first. `passed` and `failing` are evidence; the
 * other three are its absence: `not_run` (no run that counts, for this build), `skipped` (the
 * newest run neither passed nor failed) and `invalid` (a status this version cannot read,
 * written before statuses were checked). Only a pass clears a failure: a skip after one shows
 * nothing was fixed, so the failure still decides.
 */
export type TestState =
  | { state: 'passed' | 'not_run' | 'skipped' | 'invalid'; run?: Artifact }
  | { state: 'failing'; run: Artifact; heldBy?: Artifact };

export function testState(runs: Artifact[], scope: Scope = {}): TestState {
  const eligible = runs.filter((r) => inScope(r, scope));
  const counted = eligible.filter(counts);
  const head = counted[0];
  if (!head) return { state: 'not_run' };
  const status = String(head.content.status);
  const failure = BLOCKING_STATUS.has(status)
    ? head
    : status === 'passed'
      ? undefined
      : counted.find((r) => r.content.status === 'passed' || BLOCKING_STATUS.has(String(r.content.status)));
  if (failure && BLOCKING_STATUS.has(String(failure.content.status))) {
    // Something newer than the failure that did not clear it: a hand-typed pass, or a skip.
    return eligible[0] === failure ? { state: 'failing', run: failure } : { state: 'failing', run: failure, heldBy: eligible[0] };
  }
  if (status === 'passed') return { state: 'passed', run: head };
  return { state: (RUN_STATUSES as readonly string[]).includes(status) ? 'skipped' : 'invalid', run: head };
}

/** Why a failure still stands under a newer run: shown in the gate, recorded on the verdict. */
const heldBecause = (run: Artifact) =>
  isHandRecordedPass(run)
    ? HAND_RECORDED_PASS_HELD
    : `latest run was ${String(run.content.status)}, which does not show the failure was fixed`;

/**
 * SHIP: the evidence shows it. HOLD: a known blocker — an open question or a failing test.
 * UNKNOWN: evidence is missing, so nobody can say. OVERRIDDEN: a named person accepted the
 * known blockers. An override accepts what is known to be wrong; it cannot vouch for what was
 * never checked, so UNKNOWN reasons survive it.
 */
export type Decision = 'SHIP' | 'HOLD' | 'UNKNOWN' | 'OVERRIDDEN';

/** In this order everywhere they are listed: the known blockers first. */
export const REASONS = [
  'UNANSWERED_FINDING',
  'FAILED_TEST',
  'SCOPE_UNRESOLVED',
  'NO_TEST',
  'NO_REQUIRED_RUN',
  'SKIPPED_REQUIRED_TEST',
  'INVALID_STATUS',
  'STALE_AUDIT',
] as const;
export type ReasonCode = (typeof REASONS)[number];

const KNOWN_BLOCKERS = new Set<ReasonCode>(['UNANSWERED_FINDING', 'FAILED_TEST']);

/** The one place a decision is made. Every surface calls this with the reasons it was given. */
export function decide(reasons: readonly ReasonCode[], overridden = false): Decision {
  const known = reasons.some((r) => KNOWN_BLOCKERS.has(r));
  if (known && !overridden) return 'HOLD';
  if (reasons.some((r) => !KNOWN_BLOCKERS.has(r))) return 'UNKNOWN';
  return known ? 'OVERRIDDEN' : 'SHIP';
}

/** A covering test with no result that shows whether it works, for the build being assessed. */
export type IncompleteTest = {
  testCaseId: string;
  requirementId: string;
  name: string;
  state: 'not_run' | 'skipped' | 'invalid';
  testRunId: string | null;
  status: string | null;
};

/** Flakiness is judged on the runs that count: a hand-recorded pass cannot make a failure look flaky either. */
export const flakyOn = (runs: Artifact[]): boolean => isFlaky(runs.filter((r) => !isHandRecordedPass(r)));

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
 * Counts as a person's answer: not produced by AI, or an AI artifact whose latest review by a
 * person is a thumbs-up (the Inspector's 👍, or `qa-spine approve`).
 */
function isHumanOrApproved(store: TraceStore, a: Artifact): boolean {
  if (a.provenance.producer !== 'ai') return true;
  const review = store.linkedFrom(a.id, 'reviews', 'review').find((r) => r.provenance.producer === 'human');
  return review?.content.verdict === 'good';
}

/**
 * The findings on a requirement that are still open. Under the human-answers policy an AI
 * answer does not retire a question until a person approves it, so those stay open, carrying
 * the answer that awaits approval. The gate, the verdict, the readiness view and the exports
 * all read open questions through here, so none of them can disagree with another.
 */
function openFindingsOn(store: TraceStore, reqId: string, requireHuman: boolean): { f: Artifact; awaiting: string | null }[] {
  if (!requireHuman) return store.openFindings(500, reqId).map((f) => ({ f, awaiting: null }));
  return store.linkedFrom(reqId, 'derived_from', 'finding').flatMap((f): { f: Artifact; awaiting: string | null }[] => {
    const resolvers = store
      .edgesTo(f.id)
      .filter((e) => e.relation === 'supersedes' && !store.isRetracted(e.fromArtifactId))
      .flatMap((e) => store.get(e.fromArtifactId) ?? []);
    if (!resolvers.length) return [{ f, awaiting: null }];
    return resolvers.some((r) => isHumanOrApproved(store, r)) ? [] : [{ f, awaiting: resolvers[0].id }];
  });
}

/** Not retracted, and not replaced by a newer version of itself that is in force. */
const isCurrent = (store: TraceStore, req: Artifact) =>
  !store.isRetracted(req.id) && !store.linkedFrom(req.id, 'supersedes', 'requirement').length;

/** The requirement versions this one replaced. */
const previousVersions = (store: TraceStore, req: Artifact) =>
  store
    .edgesFrom(req.id)
    .filter((e) => e.relation === 'supersedes' && store.get(e.toArtifactId)?.type === 'requirement')
    .map((e) => e.toArtifactId);

/** Every version of a requirement not retracted: all requirements sharing its sourceRef, or just itself. */
const allVersions = (store: TraceStore, req: Artifact) =>
  req.sourceRef
    ? store.bySourceRef([req.sourceRef]).filter((a) => a.type === 'requirement' && !store.isRetracted(a.id))
    : [req];

/** Edited since it was last audited: replaced an earlier version, and no finding or audit since. */
const isSuspect = (store: TraceStore, req: Artifact) =>
  previousVersions(store, req).length > 0 &&
  !store.linkedFrom(req.id, 'derived_from', 'finding').length &&
  !store.linkedFrom(req.id, 'derived_from', 'audit').length;

/**
 * The current versions of a test case: itself if nothing replaced it, otherwise the test
 * cases at the end of every `supersedes` chain that starts at it. A heal records a new test
 * case that `supersedes` the one it repaired; from then on the replacement's runs decide,
 * not the old case's last failure. Nothing is deleted or rewritten: the old case, its runs
 * and the `supersedes` edge stay in the ledger, in `chain()` and in the Inspector. Like
 * `isCurrent` for requirements, "replaced" means any test case points a `supersedes` edge at
 * it; edges always run new -> existing, so the replacement is the later record.
 */
export function currentTestCases(store: TraceStore, tc: Artifact): Artifact[] {
  const heads = new Map<string, Artifact>();
  const seen = new Set([tc.id]);
  const queue = [tc];
  while (queue.length) {
    const t = queue.shift()!;
    const next = store.linkedFrom(t.id, 'supersedes', 'test_case');
    if (!next.length) heads.set(t.id, t);
    for (const n of next) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      queue.push(n);
    }
  }
  // Only a cycle (possible through store.link, never through a heal) leaves no head. Fall
  // back to the case itself rather than letting a covering test silently vanish.
  return heads.size ? [...heads.values()] : [tc];
}

/** Each test case replaced by its current version(s), each once. */
function currentOf(store: TraceStore, cases: Artifact[]): Artifact[] {
  const tests = new Map<string, Artifact>();
  for (const tc of cases) for (const cur of currentTestCases(store, tc)) tests.set(cur.id, cur);
  return [...tests.values()];
}

/** Current test cases covering any version of the requirement, each once. */
function coveringTests(store: TraceStore, req: Artifact): Artifact[] {
  return currentOf(store, allVersions(store, req).flatMap((v) => store.linkedFrom(v.id, 'covers', 'test_case')));
}

export type RequirementStatus = {
  requirementId: string;
  sourceRef: string | null;
  text: string;
  status: 'blocked' | 'unknown' | 'warning' | 'clear';
  open: number;
  answered: number;
  assumptions: number;
  tests: number;
  failing: number;
  /** Covering tests with no run showing whether they work: never run, skipped, or unreadable. */
  incomplete: number;
  flaky: number;
  suspect: boolean;
  untested: boolean;
};

/**
 * One row per current requirement — every one in the store, or those among `changed` — with
 * what the gate would say about it. Worst first: blocked (an open question or a failing
 * test), then unknown (no tests, or tests with no result that counts), then warning (edited
 * since its audit), then clear. The Inspector's readiness view and the exports are both this
 * list; neither decides anything the gate does not.
 */
export function requirementStatus(
  store: TraceStore,
  changed?: string[],
  opts: { requireHumanAnswers?: boolean } = {},
): RequirementStatus[] {
  const requireHuman = opts.requireHumanAnswers ?? process.env.QA_SPINE_REQUIRE_HUMAN_ANSWERS === '1';
  const candidates = changed
    ? store.bySourceRef(changed).filter((a) => a.type === 'requirement')
    : store.list('requirement', 1e9);
  const rank = { blocked: 0, unknown: 1, warning: 2, clear: 3 };
  return candidates
    .filter((req) => isCurrent(store, req))
    .map((req) => {
      const versions = allVersions(store, req);
      const answers = versions.flatMap((v) => store.linkedFrom(v.id, 'derived_from', 'answer'));
      const tests = coveringTests(store, req);
      const runs = tests.map((tc) => store.linkedFrom(tc.id, 'verifies', 'test_run'));
      const states = runs.map((r) => testState(r).state);
      const open = versions.reduce((n, v) => n + openFindingsOn(store, v.id, requireHuman).length, 0);
      const failing = states.filter((s) => s === 'failing').length;
      const incomplete = states.filter((s) => s !== 'failing' && s !== 'passed').length;
      const suspect = isSuspect(store, req);
      const untested = tests.length === 0;
      const status: RequirementStatus['status'] =
        open || failing ? 'blocked' : untested || incomplete ? 'unknown' : suspect ? 'warning' : 'clear';
      return {
        requirementId: req.id,
        sourceRef: req.sourceRef,
        text: String(req.content.text ?? ''),
        status,
        open,
        answered: answers.length,
        assumptions: answers.filter((a) => a.content.assumption === true).length,
        tests: tests.length,
        failing,
        incomplete,
        flaky: runs.filter(flakyOn).length,
        suspect,
        untested,
      };
    })
    .sort((a, b) => rank[a.status] - rank[b.status] || String(a.sourceRef).localeCompare(String(b.sourceRef)));
}

/**
 * Makes no model call. Like `auditRequirement`, this is a librarian: it computes the one
 * deterministic signal and hands over the surrounding evidence for the caller to reason over.
 *
 * Changed-ness is never inferred transitively. `chain()` walks both directions without bound,
 * so deriving it through edges would let one changed file mark every requirement in the store
 * as changed, and every release would block on everything.
 *
 * A finding retires the moment anything not retracted supersedes it — `openFindings` checks
 * for such a `supersedes` edge. The raw write paths refuse to create one onto a finding, and refuse
 * `verdict` outright (`assertRawRecordAllowed` in src/trace/store.ts), so only `audit_answer`
 * retires a question and only `release_submit` records a decision. Code importing the store
 * directly is not guarded; `qa-spine verify` is what catches a row that did not come through here.
 */
export function assessReleaseRisk(
  store: TraceStore,
  input: { changed: string[]; releaseRef?: string; requireHumanAnswers?: boolean; blockOnSuspect?: boolean } & Scope,
) {
  const scope: Scope = { commit: input.commit?.trim() || undefined, environment: input.environment?.trim() || undefined };
  const changed = [...new Set(input.changed.map((r) => r.trim()).filter((r) => r))];
  if (!changed.length) throw new Error('changed must not be empty');

  // A retracted artifact matches nothing: a ref covered only by a withdrawn requirement is
  // code that moved with nothing in force covering it. The withdrawal is reported below.
  const everMatched = store.bySourceRef(changed);
  const matched = everMatched.filter((a) => !store.isRetracted(a.id));
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
  const requireHuman = input.requireHumanAnswers ?? process.env.QA_SPINE_REQUIRE_HUMAN_ANSWERS === '1';
  const openOn = (reqId: string) => openFindingsOn(store, reqId, requireHuman);

  const findingSignals: RiskSignal[] = requirements.flatMap((req) =>
    openOn(req.id).map(({ f, awaiting }) => ({
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
        suggestedAnswer: f.content.suggestedAnswer ?? null,
        awaitingApproval: awaiting,
      },
    })),
  );

  // The latest run that counts decides (testState): a later pass clears an earlier failure
  // without superseding it; a skip does not. A test case a heal replaced no longer decides
  // anything; its current version does (`currentTestCases`). Every covering test counts,
  // whoever recorded it, not only ingested ones — but a pass typed in by hand clears only with
  // a name on it, and is reported in `handEntered`. Tests are those of every version of each
  // current requirement, the same set readiness and coverage read.
  const current = requirements.filter((req) => isCurrent(store, req));
  const flaky: { testCaseId: string; requirementId: string; name: string }[] = [];
  const handEntered: { testCaseId: string; testRunId: string; requirementId: string; name: string; status: string; by: string }[] = [];
  const incomplete: IncompleteTest[] = [];
  const testSignals: RiskSignal[] = current.flatMap((req) =>
    coveringTests(store, req).flatMap((tc) => {
      const runs = store.linkedFrom(tc.id, 'verifies', 'test_run');
      const t = testState(runs, scope);
      const name = String(tc.content.name ?? tc.sourceRef ?? tc.id);
      if (t.state !== 'passed' && t.state !== 'failing') {
        incomplete.push({
          testCaseId: tc.id,
          requirementId: req.id,
          name,
          state: t.state,
          testRunId: t.run?.id ?? null,
          status: t.run ? String(t.run.content.status) : null,
        });
        return [];
      }
      const latest = t.run!;
      const unreliable = flakyOn(runs);
      if (unreliable) flaky.push({ testCaseId: tc.id, requirementId: req.id, name });
      const status = String(latest.content.status);
      if (!BLOCKING_STATUS.has(status) && !ingested(latest)) {
        handEntered.push({
          testCaseId: tc.id,
          testRunId: latest.id,
          requirementId: req.id,
          name,
          status,
          by: String(latest.provenance.approvedBy),
        });
      }
      if (t.state !== 'failing') return [];
      const heldPass = t.heldBy;
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
            ...(heldPass && isHandRecordedPass(heldPass) ? { handRecordedPass: heldPass.id } : {}),
            ...(heldPass ? { heldBecause: heldBecause(heldPass) } : {}),
          },
        },
      ];
    }),
  );
  const signals = [...findingSignals, ...testSignals];

  // Withdrawn on these areas: a requirement, a covering test, or a failed run that would count
  // here if nobody had retracted it. Retracting is how a blocker can legitimately leave the gate,
  // so it is never silent — the gate prints these and the verdict records them.
  const retracted = new Map<string, Retracted>();
  const noteRetracted = (a: Artifact, name: string) => {
    const r = store.retractionOf(a.id);
    if (!r || retracted.has(a.id)) return;
    retracted.set(a.id, {
      id: a.id,
      type: a.type,
      name,
      retractionId: r.id,
      by: String(r.content.retractedBy ?? ''),
      reason: String(r.content.reason ?? ''),
      at: r.createdAt,
    });
  };
  for (const req of everMatched) if (req.type === 'requirement') noteRetracted(req, req.sourceRef ?? req.id);
  for (const req of requirements) {
    for (const tc of store.linkedFrom(req.id, 'covers', 'test_case', { includeRetracted: true })) {
      const name = String(tc.content.name ?? tc.sourceRef ?? tc.id);
      noteRetracted(tc, name);
      if (store.isRetracted(tc.id)) continue;
      for (const run of store.linkedFrom(tc.id, 'verifies', 'test_run', { includeRetracted: true })) {
        if (BLOCKING_STATUS.has(String(run.content.status))) noteRetracted(run, name);
      }
    }
  }

  // Suspect: the current version of a requirement that replaced an earlier one and has not
  // been audited since — its tests and answers were written against wording that changed.
  // A warning, not a signal: the gate blocks on it only when asked to.
  const suspect = current.flatMap((req) => {
    const previousIds = previousVersions(store, req);
    return isSuspect(store, req) ? [{ requirementId: req.id, sourceRef: req.sourceRef, previousIds }] : [];
  });

  // Untested: no test covers the requirement in any of its versions. Nothing shows it works.
  const untested = current.flatMap((req) =>
    coveringTests(store, req).length ? [] : [{ requirementId: req.id, sourceRef: req.sourceRef }],
  );

  const has = (state: IncompleteTest['state']) => incomplete.some((t) => t.state === state);
  const present: Record<ReasonCode, boolean> = {
    UNANSWERED_FINDING: findingSignals.length > 0,
    FAILED_TEST: testSignals.length > 0,
    SCOPE_UNRESOLVED: requirements.length === 0,
    NO_TEST: untested.length > 0,
    NO_REQUIRED_RUN: has('not_run'),
    SKIPPED_REQUIRED_TEST: has('skipped'),
    INVALID_STATUS: has('invalid'),
    // Opt-in: an edit since the last audit is reported either way, and blocks only when asked.
    STALE_AUDIT: !!input.blockOnSuspect && suspect.length > 0,
  };
  const reasons = REASONS.filter((code) => present[code]);

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
    release: { ref: input.releaseRef ?? null, changed, ...scope },
    decision: decide(reasons),
    reasons,
    matched: { requirements: requirements.map((r) => r.id), unmatched },
    signals,
    incomplete,
    flaky,
    handEntered,
    retracted: [...retracted.values()],
    suspect,
    untested,
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
    /** The `changed` of an earlier assessment of this release, when the caller has one. */
    assessedChanged?: string[];
    /** AI answers retire a question only once a person approves them. Default: the env var. */
    requireHumanAnswers?: boolean;
    blockOnSuspect?: boolean;
  } & Scope,
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

  const { release, signals, matched, suspect, untested, retracted, reasons } = assessReleaseRisk(store, {
    changed: input.changed,
    requireHumanAnswers: input.requireHumanAnswers,
    commit: input.commit,
    environment: input.environment,
    blockOnSuspect: input.blockOnSuspect,
  });
  // An override can accept known blockers, never missing evidence: checked before the
  // blocker message below, so "pass override" is never offered as a fix for UNKNOWN.
  const missing = reasons.filter((r) => !KNOWN_BLOCKERS.has(r));
  if (input.verdict === 'ship' && missing.length && (overrideReason || !signals.length)) {
    throw new Error(
      `cannot ship: the evidence is incomplete (${missing.join(', ')}) — add tests, run them on this ` +
        'build, or record a hold. An override accepts a known risk; it cannot vouch for what was never checked',
    );
  }
  const liveFindings = signals.flatMap((s) => (s.kind === 'unresolved_finding_on_changed_area' ? [s.detail.findingId] : []));
  const failing = signals.flatMap((s) => (s.kind === 'failing_test_on_changed_area' ? [s.detail] : []));
  const liveTestRuns = [...new Set(failing.map((t) => t.testRunId))];
  // Answers on the changed requirements that accepted a suggested default, so the brief can
  // say which decisions rest on an assumption nobody reworded.
  const assumptions = matched.requirements.flatMap((reqId) =>
    store.linkedFrom(reqId, 'derived_from', 'answer').filter((a) => a.content.assumption === true).map((a) => a.id),
  );
  const inVerdict = new Set(release.changed);
  const dropped = [...new Set((input.assessedChanged ?? []).map((r) => r.trim()).filter((r) => r && !inVerdict.has(r)))];
  if (input.verdict === 'ship' && signals.length && !overrideReason) {
    const counts = [
      ...(liveFindings.length ? [`${liveFindings.length} unresolved finding(s)`] : []),
      ...(liveTestRuns.length ? [`${liveTestRuns.length} failing test(s)`] : []),
    ];
    const named = signals
      .map((s) =>
        s.kind === 'unresolved_finding_on_changed_area'
          ? `${s.detail.findingId} (${s.detail.sourceRef ?? 'no sourceRef'})`
          : `${s.detail.testRunId} (${s.detail.name}${s.detail.flaky ? ', flaky' : ''}${s.detail.heldBecause ? `, ${s.detail.heldBecause}` : ''})`,
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
      // What the evidence showed, beside what the person decided: a hold can be recorded over
      // a release the evidence would ship, and a reader should see both.
      decision: decide(reasons, !!override),
      reasons,
      ...(release.commit ? { commit: release.commit } : {}),
      ...(release.environment ? { environment: release.environment } : {}),
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
      // Areas an earlier assessment of this release covered that this verdict leaves out.
      // Not refused — splitting a release into two decisions is legitimate — but recorded,
      // so a quietly narrowed list is visible instead of looking like a clean release.
      ...(dropped.length ? { droppedFromAssessment: dropped } : {}),
      // What a person had withdrawn from these areas at decision time, with their name and
      // reason, copied rather than referenced: undoing a retraction later must not change
      // what this decision says it was based on.
      ...(retracted.length ? { retracted } : {}),
      ...(assumptions.length ? { assumptions } : {}),
      // Requirements edited since they were last audited, as the refs a reader recognises.
      ...(suspect.length ? { suspect: [...new Set(suspect.map((s) => s.sourceRef ?? s.requirementId))] } : {}),
      ...(untested.length ? { untested: [...new Set(untested.map((u) => u.sourceRef ?? u.requirementId))] } : {}),
    },
    provenance: input.provenance,
    links: cites.map((to) => ({ to, relation: 'derived_from' as const })),
  });
}
