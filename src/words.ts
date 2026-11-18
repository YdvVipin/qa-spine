/**
 * What each reason code means, in one place. The JSON keeps the codes; people and agents read
 * these sentences. A test fails if a code is added without its words.
 */
import type { ReasonCode } from './release.ts';

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
