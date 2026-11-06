import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { TraceStore } from './trace/store.ts';
import {
  assessReleaseRisk,
  decide,
  recordVerdict,
  type Decision,
  type FailingTest,
  type IncompleteTest,
  type ReasonCode,
  type Retracted,
} from './release.ts';
import { renderBrief } from './brief.ts';

export const TOOL = 'qa-spine gate';

/** Jira-shaped by default, because most teams are. A flag rather than a constant: the key
 *  shape is an organisation's choice, and this has to work for projects that are not Jira's. */
export const DEFAULT_TICKET_PATTERN = '[A-Z][A-Z0-9]+-\\d+';

export type GateOptions = {
  changed: string[];
  /** Free text, such as a PR title: only the ticket keys in it are assessed, never the text itself. */
  text?: string[];
  since?: string;
  ticketPattern?: string;
  releaseRef?: string;
  record?: boolean;
  reason?: string;
  overrideReason?: string;
  approvedBy?: string;
  briefPath?: string;
  /** Block while a changed requirement was edited after its last audit. Off by default. */
  blockOnSuspect?: boolean;
  /** Only runs on this commit count. Left out, runs on any commit do. */
  commit?: string;
  /** Only runs in this environment count. Left out, runs in any do. */
  environment?: string;
  /** Report the decision without enforcing it: the CLI exits 0, the JSON still says HOLD or UNKNOWN. */
  advisory?: boolean;
  /** An AI answer retires a question only once a person approves it. Default: the env var. */
  requireHumanAnswers?: boolean;
  cwd?: string;
  /** Passed in rather than imported: VERSION lives in server.ts, which imports this module. */
  toolVersion?: string;
};

export type GateResult = {
  /** SHIP and OVERRIDDEN exit 0, HOLD 1, UNKNOWN 2 — unless `enforcement` is advisory. */
  decision: Decision;
  /** Every reason the evidence fell short, known blockers first. Empty only on SHIP. */
  reasons: ReasonCode[];
  enforcement: 'enforcing' | 'advisory';
  /** True on SHIP and OVERRIDDEN. Kept for readers of the 0.3 JSON; read `decision`. */
  shippable: boolean;
  commit: string | null;
  environment: string | null;
  releaseRef: string | null;
  changed: string[];
  matched: { requirements: string[] };
  unmatched: { count: number; sample: string[] };
  signals: {
    findingId: string;
    requirementId: string;
    sourceRef: string | null;
    category: unknown;
    quote: unknown;
    question: unknown;
    confidence: unknown;
    suggestedAnswer: unknown;
    awaitingApproval: string | null;
  }[];
  /** Covering tests whose latest run failed. Separate from `signals` so existing readers of
   *  the JSON, which expect every signal to be a question, keep working. */
  failingTests: FailingTest[];
  /** Tests on changed areas that failed and passed on the same commit. Information only. */
  /** Covering tests with no result that shows whether they work on this build. */
  incomplete: IncompleteTest[];
  flakyTests: { testCaseId: string; requirementId: string; name: string }[];
  /** Tests whose deciding result was typed in by hand rather than ingested, and who vouched for it. */
  handEntered: { testCaseId: string; testRunId: string; requirementId: string; name: string; status: string; by: string }[];
  /** What a person withdrew from these areas. Never blocks; always shown. */
  retracted: Retracted[];
  /** Changed requirements edited since their last audit. A warning unless --block-on-suspect. */
  suspect: { requirementId: string; sourceRef: string | null; previousIds: string[] }[];
  /** Changed requirements no test covers in any version. Nothing shows they work: UNKNOWN. */
  untested: { requirementId: string; sourceRef: string | null }[];
  /** Whether suspect / untested requirements are blocking this run. Untested always is, since 0.4. */
  suspectBlocking: boolean;
  coverageBlocking: boolean;
  recorded: { verdictId: string; verdict: 'ship' | 'hold'; briefPath: string | null } | null;
};

/** Unmatched refs shown inline. A forty-file pull request would otherwise bury the signals
 *  under the paths; the complete list still goes onto the verdict. */
const UNMATCHED_SAMPLE = 5;

class GateError extends Error {}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    // A shallow clone or an unknown ref must not degrade to "no changes found": that reads
    // as a clean release, which is the one wrong answer this command must never give.
    throw new GateError(`git ${args.join(' ')} failed: ${stderr || (err as Error).message}`);
  }
}

/**
 * Refs a commit range touched: file paths, plus ticket keys mentioned in its commit messages.
 *
 * Three-dot for paths — what this branch changed, not what happened on the base since it
 * forked. Two-dot for messages — the commits actually on this branch.
 */
function ticketRegex(ticketPattern: string): RegExp {
  try {
    return new RegExp(ticketPattern, 'g');
  } catch (err) {
    throw new GateError(`--ticket-pattern is not a valid regular expression: ${(err as Error).message}`);
  }
}

export function refsFromGit(since: string, cwd: string, ticketPattern: string): string[] {
  const pattern = ticketRegex(ticketPattern);

  const paths = git(['diff', '--name-only', `${since}...HEAD`], cwd)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const messages = git(['log', '--format=%s%n%b', `${since}..HEAD`], cwd);
  const keys = messages.match(pattern) ?? [];

  return [...new Set([...paths, ...keys])];
}

/**
 * Reasons the gate is allowed to write for itself: statements the assessment just proved.
 * Anything beyond a statement of fact has to come from a person — a templated narrative in
 * the brief would be the staged picture that got examples/seed-demo.ts deleted.
 *
 * The middle case is the one that earns its keep. A release where nothing matched is not a
 * clean release, and reporting it in the first case's words would manufacture confidence the
 * record never earned.
 */
export function defaultReason(reasons: readonly ReasonCode[]): string {
  const has = (r: ReasonCode) => reasons.includes(r);
  if (has('UNANSWERED_FINDING') && has('FAILED_TEST')) {
    return (
      'One or more questions raised when this work was specified have not been answered, ' +
      'and tests covering areas this release changed are failing.'
    );
  }
  if (has('UNANSWERED_FINDING')) {
    return (
      'One or more questions raised when this work was specified have not been answered, ' +
      'and they touch areas this release changed.'
    );
  }
  if (has('FAILED_TEST')) return 'Tests covering areas this release changed are failing.';
  if (has('SCOPE_UNRESOLVED')) {
    return 'Nothing in the record covers the areas this release changed, so no questions could be checked.';
  }
  if (has('NO_TEST')) return 'Requirements this release changed have no tests, so nothing checked that they still work.';
  if (has('NO_REQUIRED_RUN') || has('SKIPPED_REQUIRED_TEST') || has('INVALID_STATUS')) {
    return 'Tests covering areas this release changed have no result showing they pass on this build.';
  }
  if (has('STALE_AUDIT')) {
    return 'Requirements this release changed were edited after they were last checked, and have not been checked again.';
  }
  return 'No unanswered questions were found on the areas this release changed.';
}

export function runGate(store: TraceStore, opts: GateOptions): GateResult {
  const cwd = opts.cwd ?? process.cwd();

  const changed = [
    ...new Set([
      ...opts.changed,
      ...(opts.text ?? []).flatMap((t) => t.match(ticketRegex(opts.ticketPattern ?? DEFAULT_TICKET_PATTERN)) ?? []),
      ...(opts.since ? refsFromGit(opts.since, cwd, opts.ticketPattern ?? DEFAULT_TICKET_PATTERN) : []),
    ]),
  ]
    .map((r) => r.trim())
    .filter(Boolean);

  if (!changed.length) {
    throw new GateError('nothing to assess: pass --changed, --text with a ticket key in it, or --since to derive refs from git');
  }

  // An empty store matches nothing, raises no signal and would otherwise report a green
  // check. A CI checkout with no store restored is the likeliest way this happens, and a
  // false all-clear is worse than a failed job.
  if (!store.list(undefined, 1).length) {
    throw new GateError('the trace store is empty — check QA_SPINE_DB points at a real store');
  }

  // Here rather than in the CLI, so every caller gets it, and trimmed: a name of three spaces
  // is no name, and it used to pass whenever the gate was not recording.
  const overrideReason = opts.overrideReason?.trim() || undefined;
  const approvedBy = opts.approvedBy?.trim() || undefined;
  if (!!overrideReason !== !!approvedBy) {
    throw new GateError('--override-reason and --approved-by must be given together');
  }

  const scope = { commit: opts.commit?.trim() || undefined, environment: opts.environment?.trim() || undefined };
  const assessment = assessReleaseRisk(store, {
    changed,
    releaseRef: opts.releaseRef,
    requireHumanAnswers: opts.requireHumanAnswers,
    blockOnSuspect: opts.blockOnSuspect,
    ...scope,
  });
  const signals = assessment.signals.flatMap((s) => (s.kind === 'unresolved_finding_on_changed_area' ? [s.detail] : []));
  // One entry per failing run: a test covering two changed requirements is one failing test,
  // named against the first of them, not two.
  const seenRuns = new Set<string>();
  const failingTests = assessment.signals
    .flatMap((s) => (s.kind === 'failing_test_on_changed_area' ? [s.detail] : []))
    .filter((t) => !seenRuns.has(t.testRunId) && !!seenRuns.add(t.testRunId));
  // An override accepts a known risk. It does nothing for missing evidence — an untested or
  // unaudited requirement is not a known risk yet — so decide() keeps those UNKNOWN.
  const overriding = !!overrideReason && assessment.decision === 'HOLD';
  const decision = decide(assessment.reasons, overriding);
  const shippable = decision === 'SHIP' || decision === 'OVERRIDDEN';

  const result: GateResult = {
    decision,
    reasons: assessment.reasons,
    enforcement: opts.advisory ? 'advisory' : 'enforcing',
    shippable,
    commit: scope.commit ?? null,
    environment: scope.environment ?? null,
    releaseRef: opts.releaseRef ?? null,
    changed: assessment.release.changed,
    matched: { requirements: assessment.matched.requirements },
    unmatched: {
      count: assessment.matched.unmatched.length,
      sample: assessment.matched.unmatched.slice(0, UNMATCHED_SAMPLE),
    },
    signals,
    failingTests,
    incomplete: assessment.incomplete,
    flakyTests: assessment.flaky,
    handEntered: assessment.handEntered,
    retracted: assessment.retracted,
    suspect: assessment.suspect,
    untested: assessment.untested,
    suspectBlocking: assessment.reasons.includes('STALE_AUDIT'),
    coverageBlocking: assessment.reasons.includes('NO_TEST'),
    recorded: null,
  };

  if (!opts.record) return result;

  if (!opts.releaseRef?.trim()) throw new GateError('--record requires --release-ref');

  const verdict = shippable ? 'ship' : 'hold';
  // cites has to name artifacts that exist. The live findings are the evidence for a hold;
  // the matched requirements are what a clean ship is asserting about. Both come from the
  // store, so neither can be an id recordVerdict rejects.
  const cites = [
    ...new Set([
      ...signals.map((s) => s.findingId),
      ...failingTests.map((t) => t.testRunId),
      ...assessment.matched.requirements,
    ]),
  ];

  const recorded = recordVerdict(store, {
    releaseRef: opts.releaseRef,
    verdict,
    reason: opts.reason?.trim() || defaultReason(assessment.reasons),
    cites,
    changed,
    // Only when it overrides something. recordVerdict rejects an override alongside a hold,
    // and discards one that overrode nothing.
    override: overriding && verdict === 'ship' ? { reason: overrideReason! } : undefined,
    requireHumanAnswers: opts.requireHumanAnswers,
    blockOnSuspect: opts.blockOnSuspect,
    ...scope,
    provenance: {
      producer: 'tool',
      tool: TOOL,
      ...(opts.toolVersion ? { toolVersion: opts.toolVersion } : {}),
      ...(approvedBy ? { approvedBy, approvedAt: new Date().toISOString() } : {}),
    },
  });

  result.recorded = { verdictId: recorded.id, verdict, briefPath: null };

  if (opts.briefPath) {
    try {
      writeFileSync(opts.briefPath, renderBrief(store, recorded.id));
      result.recorded.briefPath = opts.briefPath;
    } catch (err) {
      // The ledger write is the durable half and already happened. Reporting only the brief
      // failure would read as "nothing was recorded", which is the opposite of the truth.
      throw new GateError(
        `verdict ${recorded.id} was recorded, but the brief could not be written to ` +
          `${opts.briefPath}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return result;
}

const bullet = (s: string) => `- ${s}`;

/** Markdown, so the same bytes read correctly in a terminal and in a pull-request comment.
 *  One format instead of a --format flag. */
export function renderSummary(r: GateResult): string {
  const lines: string[] = [];

  const heading: Record<Decision, string> = {
    SHIP: 'no blockers',
    OVERRIDDEN: 'no blockers',
    HOLD: 'release blocked',
    UNKNOWN: 'cannot tell — evidence is missing',
  };
  lines.push(`## qa-spine: ${heading[r.decision]}` + (r.enforcement === 'advisory' ? ' (advisory: not enforced)' : ''));
  lines.push('');
  const overridden = r.decision === 'OVERRIDDEN';

  if (r.signals.length) {
    lines.push(
      `**${r.signals.length} unanswered question${r.signals.length === 1 ? '' : 's'} on areas this change touches**` +
        (overridden ? ' — overridden.' : ''),
    );
    lines.push('');
    for (const s of r.signals) {
      lines.push(bullet(`${s.sourceRef ?? 'no reference'} — ${String(s.question ?? '(no question recorded)')}`));
      if (s.quote) lines.push(`  > ${String(s.quote)}`);
      if (s.awaitingApproval) {
        lines.push(`  Answered by AI, awaiting a person's approval: \`qa-spine approve ${s.awaitingApproval} --by <your name>\``);
        continue;
      }
      if (s.suggestedAnswer) lines.push(`  Suggested: ${String(s.suggestedAnswer)}`);
      // The exact command, so a red check says how to turn it green.
      lines.push(`  Answer: \`qa-spine answer ${s.findingId} "<your answer>" --by <your name>\``);
      if (s.suggestedAnswer) {
        lines.push(`  Or accept the suggestion: \`qa-spine answer ${s.findingId} --accept-suggestion --by <your name>\``);
      }
    }
    lines.push('');
  } else {
    lines.push('No unanswered questions on the areas this change touches.');
    lines.push('');
  }

  if (r.failingTests.length) {
    const n = r.failingTests.length;
    lines.push(
      `**${n} failing test${n === 1 ? '' : 's'} on areas this change touches**` + (overridden ? ' — overridden.' : ''),
    );
    lines.push('');
    for (const t of r.failingTests) {
      const flaky = t.flaky ? ', flaky: it also passed on the same commit' : '';
      lines.push(bullet(`${t.sourceRef ?? 'no reference'} — ${t.name} (${t.status}${flaky})`));
      if (t.message) lines.push(`  > ${t.message.split('\n')[0]}`);
      // A later run exists but did not clear this failure: typed in by hand, or a skip.
      if (t.heldBecause) {
        lines.push(
          `  Not cleared: ${t.heldBecause}.` +
            (t.handRecordedPass ? ' It counts only with a named approver and a reason (see below).' : ''),
        );
      }
    }
    lines.push('');
  }

  if (r.incomplete.length) {
    const n = r.incomplete.length;
    const why = {
      not_run: 'no result that counts' + (r.commit || r.environment ? ' for this build' : ''),
      skipped: 'latest run was skipped',
      invalid: 'latest result has a status qa-spine cannot read',
    };
    lines.push(`**${n} test${n === 1 ? '' : 's'} on areas this change touches ${n === 1 ? 'has' : 'have'} nothing showing ${n === 1 ? 'it works' : 'they work'}:**`);
    for (const t of r.incomplete) {
      lines.push(bullet(`${t.name} — ${why[t.state]}${t.state === 'invalid' ? ` (${JSON.stringify(t.status)})` : ''}`));
    }
    lines.push('');
  }

  // A retraction is how a blocker can legitimately leave the gate, so it never leaves quietly.
  if (r.retracted.length) {
    const n = r.retracted.length;
    const kind: Record<string, string> = { requirement: 'requirement', test_case: 'test', test_run: 'failed result' };
    lines.push(`**${n} item${n === 1 ? '' : 's'} on areas this change touches ${n === 1 ? 'was' : 'were'} withdrawn as recorded by mistake:**`);
    for (const x of r.retracted) {
      lines.push(bullet(`${kind[x.type] ?? x.type} ${x.name} — withdrawn by ${x.by}: ${x.reason}`));
      lines.push(`  To put it back: \`qa-spine retract ${x.retractionId} --by <your name> --reason "<why>"\``);
    }
    lines.push('');
  }

  if (r.handEntered.length) {
    const n = r.handEntered.length;
    lines.push(`**${n} test${n === 1 ? '' : 's'} decided by a result entered by hand, not from a test report:**`);
    for (const t of r.handEntered) lines.push(bullet(`${t.name} — ${t.status}, vouched for by ${t.by}`));
    lines.push('');
  }

  if (r.suspect.length) {
    const n = r.suspect.length;
    lines.push(
      `**${n} requirement${n === 1 ? '' : 's'} changed since ${n === 1 ? 'it was' : 'they were'} last audited**` +
        (r.suspectBlocking ? ' — re-audit to clear; an override does not' : '') + ':',
    );
    for (const s of r.suspect) lines.push(bullet(s.sourceRef ?? s.requirementId));
    lines.push('');
  }

  if (r.untested.length) {
    const n = r.untested.length;
    lines.push(`**${n} changed requirement${n === 1 ? ' has' : 's have'} no tests** — add a test to clear; an override does not:`);
    for (const u of r.untested) lines.push(bullet(u.sourceRef ?? u.requirementId));
    lines.push('');
  }

  const failingCases = new Set(r.failingTests.map((t) => t.testCaseId));
  const flakyPassing = r.flakyTests.filter((t) => !failingCases.has(t.testCaseId));
  if (flakyPassing.length) {
    const n = flakyPassing.length;
    lines.push(`**${n} flaky test${n === 1 ? '' : 's'}** — passing now, but failed and passed on the same commit:`);
    for (const t of flakyPassing) lines.push(bullet(t.name));
    lines.push('');
  }

  lines.push(
    `Matched ${r.matched.requirements.length} requirement${r.matched.requirements.length === 1 ? '' : 's'} ` +
      `from ${r.changed.length} reference${r.changed.length === 1 ? '' : 's'}.`,
  );

  if (r.unmatched.count) {
    lines.push('');
    lines.push(`**${r.unmatched.count} moved with nothing in the record covering them:**`);
    for (const ref of r.unmatched.sample) lines.push(bullet(ref));
    if (r.unmatched.count > r.unmatched.sample.length) {
      lines.push(bullet(`…and ${r.unmatched.count - r.unmatched.sample.length} more`));
    }
  }

  if (r.reasons.includes('SCOPE_UNRESOLVED')) {
    lines.push('');
    lines.push('No requirement in the record matches this change, so there is nothing to decide on. Import the tickets it implements, or pass them with `--changed`.');
  }

  // Only when an override would actually unblock: it cannot clear missing evidence.
  if (r.decision === 'HOLD' && decide(r.reasons, true) === 'OVERRIDDEN') {
    lines.push('');
    lines.push(
      'To ship anyway, a named person accepts the risk: add ' +
        '`--override-reason "<why>" --approved-by <your name>` to the gate command.',
    );
  }

  if (r.recorded) {
    lines.push('');
    lines.push(`Recorded verdict **${r.recorded.verdict}** as \`${r.recorded.verdictId}\`.`);
    if (r.recorded.briefPath) lines.push(`Brief written to \`${r.recorded.briefPath}\`.`);
  }

  return lines.join('\n');
}
