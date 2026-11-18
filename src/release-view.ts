/**
 * What the Release page shows a release manager, as data: one sentence, three lists (passed,
 * failed, no evidence), the recorded decision if there is one, and which decisions are allowed.
 *
 * The decision is runGate's, the one evaluator every other surface uses; this module only
 * arranges its result in plain words. A release's stories come from the link while it is
 * undecided (`?release=1.4&changed=PROJ-1,PROJ-2`, the link RatifyQA sends), and from its latest
 * verdict once decided, so the ledger holds nothing new: a store stays readable by 0.3.
 */
import type { TraceStore } from './trace/store.ts';
import type { Artifact } from './trace/schema.ts';
import { runGate } from './gate.ts';
import { INGEST_TOOL, JIRA_KEY, defectOf, recordVerdict, type Decision } from './release.ts';
import { DECISION_WORDS, verdictHeadline, type Tone } from './words.ts';

export class ReleaseNotFound extends Error {}

export type ReleaseScope = { changed: string[]; commit?: string; environment?: string };

export type ReleaseView = {
  release: string;
  scope: ReleaseScope & { source: 'link' | 'decision' };
  /** The evidence today, from the one evaluator. */
  decision: Decision;
  headline: string;
  tone: Tone;
  /** The headline with what lies behind it, e.g. "Not ready: 2 tests failed". */
  summary: string;
  passed: { story: string; title: string; test: string; when: string; by: string }[];
  failed: { story: string; title: string; what: string; when: string; bug: string | null; by: string | null }[];
  missing: { story: string; title: string; what: string }[];
  /** The latest recorded decision on this release, as it was recorded, with how much has changed since. */
  decided: {
    headline: string;
    tone: Tone;
    verdict: 'ship' | 'hold';
    by: string | null;
    when: string;
    reason: string;
    defects: string[];
    changedSince: number;
  } | null;
  /** Ship only when ready; Hold always; Ship anyway only for Not ready, never for Can't tell yet. */
  actions: { ship: boolean; hold: boolean; shipAnyway: boolean };
};

/** The latest verdict recorded for a release, if any. */
export function latestVerdict(store: TraceStore, release: string): Artifact | undefined {
  return store
    .bySourceRef([release])
    .filter((a) => a.type === 'verdict' && !store.isRetracted(a.id))
    .reduce<Artifact | undefined>((latest, v) => (!latest || store.insertedAfter(v.id, latest.id) ? v : latest), undefined);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const title = (req: Artifact | undefined) => {
  const text = String(req?.content.title ?? req?.content.text ?? '').split('\n')[0].trim();
  return text.length > 90 ? `${text.slice(0, 87)}…` : text;
};

export function releaseView(store: TraceStore, input: { release: string } & Partial<ReleaseScope>): ReleaseView {
  const release = input.release.trim();
  const verdict = latestVerdict(store, release);
  const fromLink = (input.changed ?? []).map((c) => c.trim()).filter(Boolean);
  let scope: ReleaseView['scope'];
  if (fromLink.length) {
    scope = { changed: fromLink, ...(input.commit ? { commit: input.commit } : {}), ...(input.environment ? { environment: input.environment } : {}), source: 'link' };
  } else if (verdict) {
    const c = verdict.content as Record<string, any>;
    scope = { changed: c.changed ?? [], ...(c.commit ? { commit: c.commit } : {}), ...(c.environment ? { environment: c.environment } : {}), source: 'decision' };
  } else {
    throw new ReleaseNotFound(
      `Release "${release}" has not been decided yet, and this link does not say which stories it contains. ` +
        `Open it as ?release=${encodeURIComponent(release)}&changed=PROJ-1,PROJ-2 (the stories in the release).`,
    );
  }

  const g = runGate(store, { changed: scope.changed, commit: scope.commit, environment: scope.environment });
  const req = (id: string) => store.get(id);
  const storyOf = (id: string) => req(id)?.sourceRef ?? id;
  const onBuild = scope.commit || scope.environment ? ' on this build' : '';
  const reporter = (run: Artifact | undefined) =>
    run?.provenance.approvedBy?.trim() || (run?.provenance.tool === INGEST_TOOL ? 'test report' : null);

  const passed = g.passing.map((p) => ({ story: storyOf(p.requirementId), title: title(req(p.requirementId)), test: p.name, when: p.at, by: p.by ?? 'test report' }));
  const failed = [
    ...g.failingTests.map((f) => {
      const run = store.get(f.testRunId);
      const bug = defectOf(run)?.key ?? null;
      return {
        story: storyOf(f.requirementId),
        title: title(req(f.requirementId)),
        what: f.name,
        when: run?.createdAt ?? '',
        bug,
        by: reporter(run),
      };
    }),
    ...g.signals.map((q) => ({
      story: q.sourceRef ?? storyOf(q.requirementId),
      title: title(req(q.requirementId)),
      what: `Question not answered: ${String(q.question)}`,
      when: store.get(q.findingId)?.createdAt ?? '',
      bug: null,
      by: null,
    })),
  ];
  const missing = [
    ...g.incomplete.map((t) => ({
      story: storyOf(t.requirementId),
      title: title(req(t.requirementId)),
      what:
        t.state === 'skipped'
          ? `${t.name} was skipped the last time it ran`
          : t.state === 'invalid'
            ? `${t.name} has a result that could not be read`
            : t.status === 'passed'
              ? `${t.name} passed, but nobody is named as having run it`
              : `${t.name} has no result${onBuild} yet`,
    })),
    ...g.untested.map((u) => ({ story: u.sourceRef ?? storyOf(u.requirementId), title: title(req(u.requirementId)), what: 'No test covers this story' })),
    ...g.unmatched.sample.map((ref) => ({ story: ref, title: '', what: 'This story is not in the record yet' })),
  ];

  const words = DECISION_WORDS[g.decision];
  const failedTests = g.failingTests.length;
  const questions = g.signals.length;
  const detail =
    g.decision === 'SHIP'
      ? `${plural(passed.length, 'test', 'tests')} passed, nothing missing`
      : g.decision === 'HOLD'
        ? [failedTests ? plural(failedTests, 'test failed', 'tests failed') : '', questions ? plural(questions, 'question unanswered', 'questions unanswered') : '']
            .filter(Boolean)
            .join(' and ')
        : plural(new Set(missing.map((m) => m.story)).size, 'story has no evidence', 'stories have no evidence');

  let decided: ReleaseView['decided'] = null;
  if (verdict) {
    const c = verdict.content as Record<string, any>;
    const said = verdictHeadline(c);
    // Results recorded, or withdrawn, on this release's tests after the decision.
    const tests = new Set([...g.passing, ...g.failingTests, ...g.incomplete].map((t) => t.testCaseId));
    let changedSince = 0;
    for (const tc of tests) {
      for (const run of store.linkedFrom(tc, 'verifies', 'test_run', { includeRetracted: true })) {
        if (store.insertedAfter(run.id, verdict.id)) changedSince++;
        const withdrawn = store.retractionOf(run.id);
        if (withdrawn && store.insertedAfter(withdrawn.id, verdict.id)) changedSince++;
      }
    }
    decided = {
      headline: said.headline,
      tone: said.tone,
      verdict: c.verdict === 'ship' ? 'ship' : 'hold',
      by: verdict.provenance.approvedBy?.trim() || null,
      when: verdict.createdAt,
      reason: String(c.reason ?? ''),
      defects: Array.isArray(c.override?.defects) ? c.override.defects.map(String) : [],
      changedSince,
    };
  }

  return {
    release,
    scope,
    decision: g.decision,
    headline: words.headline,
    tone: words.tone,
    summary: `${words.headline}: ${detail}`,
    passed,
    failed,
    missing,
    decided,
    actions: { ship: g.decision === 'SHIP', hold: true, shipAnyway: g.decision === 'HOLD' },
  };
}

/** A decision the page cannot record, with the HTTP status that says why: 400 fix the form, 409 the release is not in that state. */
export class DecisionRefused extends Error {
  readonly status: 400 | 409;
  constructor(status: 400 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

export type DecideInput = { release: string; action: 'ship' | 'hold' | 'ship_anyway'; name?: string; reason?: string; defects?: string[] } & Partial<ReleaseScope>;

/**
 * Ship, Hold or Ship anyway, from the Release page. The rules are checked against the evidence
 * now, not as it was when the page loaded: a result that lands between loading and clicking
 * changes what may be recorded.
 *
 * - Every decision names a person (a claimed name: the Inspector has no sign-in).
 * - Ship only when Ready to ship. Hold always; a blank note becomes "Held by <name> …".
 * - Ship anyway only when Not ready, never Can't tell yet: a reason of 20+ characters and at
 *   least one Jira key, recorded as the override's `defects`.
 */
export function decideRelease(store: TraceStore, input: DecideInput): ReleaseView {
  const name = input.name?.trim() ?? '';
  if (!name) throw new DecisionRefused(400, 'Type your name: every decision is recorded with who made it.');
  const view = releaseView(store, input);
  const now = view.headline;
  const record = (verdict: 'ship' | 'hold', reason: string, override?: { reason: string; defects: string[] }) => {
    try {
      recordVerdict(store, {
        releaseRef: view.release,
        verdict,
        reason,
        cites: [],
        changed: view.scope.changed,
        commit: view.scope.commit,
        environment: view.scope.environment,
        ...(override ? { override } : {}),
        provenance: { producer: 'human', approvedBy: name },
      });
    } catch (err) {
      throw new DecisionRefused(400, err instanceof Error ? err.message : String(err));
    }
    return releaseView(store, { release: view.release, ...view.scope });
  };

  if (input.action === 'hold') {
    return record('hold', input.reason?.trim() || `Held by ${name} on the Release page.`);
  }
  if (input.action === 'ship') {
    if (!view.actions.ship) throw new DecisionRefused(409, `Ship is only for Ready to ship; this release is ${now} (${view.summary}).`);
    return record('ship', input.reason?.trim() || `Shipped by ${name}: every test on every story passed.`);
  }
  if (input.action === 'ship_anyway') {
    if (view.decision === 'UNKNOWN') {
      throw new DecisionRefused(409, `Can't tell yet cannot be shipped anyway: nothing shows these stories work. ${view.summary}.`);
    }
    if (!view.actions.shipAnyway) throw new DecisionRefused(409, `Ship anyway is only for Not ready; this release is now ${now}.`);
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 20) throw new DecisionRefused(400, 'Say why it ships anyway, in 20 characters or more.');
    const defects = [...new Set((input.defects ?? []).map((d) => String(d).trim()).filter(Boolean))];
    if (!defects.length) throw new DecisionRefused(400, 'Give the Jira bug that tracks each failure, e.g. ABC-123.');
    const bad = defects.find((d) => !JIRA_KEY.test(d));
    if (bad) throw new DecisionRefused(400, `"${bad}" is not a Jira key like ABC-123.`);
    return record('ship', reason, { reason, defects });
  }
  throw new DecisionRefused(400, `Unknown decision ${JSON.stringify(input.action)}: use ship, hold or ship_anyway.`);
}
