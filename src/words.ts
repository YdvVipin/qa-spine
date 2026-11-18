/**
 * What each reason code means, in one place. The JSON keeps the codes; people and agents read
 * these sentences. A test fails if a code is added without its words.
 */
import type { Decision, ReasonCode } from './release.ts';

/** For an agent or an engineer: the action that closes the reason. */
export const HOW_TO_CLOSE: Record<ReasonCode, string> = {
  UNANSWERED_FINDING: 'answer the open question (audit_answer, or qa-spine answer), or have a named person accept the risk with an override',
  FAILED_TEST:
    'fix the failure and record a passing run, or have a named person accept the risk with an override and the Jira bug that tracks it',
  SCOPE_UNRESOLVED:
    'nothing recorded matches the changed refs: record the stories this release implements (trace_record, or an importer), or correct the refs',
  NO_TEST: 'a changed story has no test: record a test_case that covers it, or ingest test results whose names carry its key',
  NO_REQUIRED_RUN:
    'a covering test has no result that counts on this build: run it and ingest the report (qa-spine ingest-junit), or record the run with provenance.approvedBy naming who ran it',
  SKIPPED_REQUIRED_TEST: 'the latest run of a covering test was skipped: run it so it passes or fails',
  INVALID_STATUS:
    'a result has a status qa-spine cannot read: record the run again with one of passed, failed, error, skipped, blocked, not_run, cancelled, unknown',
  STALE_AUDIT: 'a story changed after its last audit: audit it again (audit_requirement, then audit_submit)',
};

export type Tone = 'ready' | 'not-ready' | 'cant-tell' | 'shipped-anyway';

/** The four outcomes as a release manager reads them, one sentence and one colour each. */
export const DECISION_WORDS: Record<Decision, { headline: string; tone: Tone }> = {
  SHIP: { headline: 'Ready to ship', tone: 'ready' },
  HOLD: { headline: 'Not ready', tone: 'not-ready' },
  UNKNOWN: { headline: "Can't tell yet", tone: 'cant-tell' },
  OVERRIDDEN: { headline: 'Shipped anyway', tone: 'shipped-anyway' },
};

/** For a release manager: what the reason means, with no codes and no tool names. */
export const REASON_WORDS: Record<ReasonCode, string> = {
  UNANSWERED_FINDING: 'A question about a story is still unanswered.',
  FAILED_TEST: 'A test failed.',
  SCOPE_UNRESOLVED: 'None of the stories in this release is in the record yet.',
  NO_TEST: 'A story has no test.',
  NO_REQUIRED_RUN: 'A test has no result on this build yet.',
  SKIPPED_REQUIRED_TEST: 'A test was skipped, so it shows nothing either way.',
  INVALID_STATUS: 'A test result could not be read.',
  STALE_AUDIT: 'A story changed after it was last checked.',
};

/**
 * What a recorded verdict says, in the same words: a hold is Not ready whatever the evidence
 * showed, and a ship is Shipped anyway when it overrode something. A verdict from before 0.4 has
 * no decision: its ship reads as Shipped anyway if it carries an override, else Ready to ship.
 */
export function verdictHeadline(v: { verdict?: unknown; decision?: unknown; override?: unknown }) {
  if (v.verdict !== 'ship') return DECISION_WORDS.HOLD;
  // Before 0.4 there was no decision field; a recorded override is what said "shipped anyway".
  return v.decision === 'OVERRIDDEN' || (v.decision === undefined && v.override) ? DECISION_WORDS.OVERRIDDEN : DECISION_WORDS.SHIP;
}
