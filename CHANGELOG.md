# Changelog

## 0.4.0 — 2026-11-06

### Changes in behaviour — read before upgrading: the gate now says UNKNOWN

Before, missing evidence read as green: a store with nothing matching the change, a
requirement with no test, a test that never ran, a skip after a failure, a pass on another
build and a status like `banana` could all ship. Every surface — `gate`, `assess_release_risk`,
`release_submit`, the readiness view and the exports — now reaches one `decision` through one
evaluator.

- **`decision` and `reasons`.** `SHIP`, `HOLD` (known blocker: `UNANSWERED_FINDING`,
  `FAILED_TEST`), `UNKNOWN` (missing evidence: `SCOPE_UNRESOLVED`, `NO_TEST`,
  `NO_REQUIRED_RUN`, `SKIPPED_REQUIRED_TEST`, `INVALID_STATUS`, `STALE_AUDIT`) or
  `OVERRIDDEN`. Gate exit codes: `0` SHIP/OVERRIDDEN, `1` HOLD, `2` UNKNOWN (and, as before,
  a gate that could not run). `shippable` is kept, true on SHIP and OVERRIDDEN.
- **An untested requirement is UNKNOWN by default.** `--require-coverage` is accepted and
  has no effect. **Expect builds that passed under 0.3 to exit 2** where a changed
  requirement has no test, or nothing in the record matches the change.
- **A covering test with no run that counts is UNKNOWN**, including one whose only result is
  an unnamed hand-typed pass, and one whose only failing run was retracted.
- **Only a pass clears a failure.** A skip after a failure leaves the failure deciding; a
  test whose latest run was skipped is UNKNOWN.
- **An override clears HOLD, never UNKNOWN.** `release_submit` refuses `ship` while evidence
  is missing, override or not. `--override-reason` and `--approved-by` are trimmed and
  checked in the gate itself, so a whitespace name is refused with or without `--record`.
- **`--block-on-suspect` now gives UNKNOWN (exit 2)**, not HOLD (exit 1).
- **Test run statuses are checked on write.** `status` must be one of `passed`, `failed`,
  `error`, `skipped`, `blocked`, `not_run`, `cancelled`, `unknown`, through every write path.
  **Custom producers that write `completed` (QAAE's Loop A) must write `passed`**, and name
  the person in `provenance.approvedBy` for a hand-recorded pass to count. Old rows with other
  statuses still load and merge; the gate reads them as UNKNOWN.
- **Verdicts record `decision`, `reasons`, and `commit`/`environment`** when given.
- **The project's `./rubrics` is used.** `init` copies the rubric there and says it is yours
  to edit; 0.3 then ignored the copy and read the package's. Precedence is now
  `QA_SPINE_RUBRICS`, then `./rubrics/<name>.json`, then the package. Findings are stamped
  with the version of the file actually read.
- **Readiness has an `unknown` status** (and an `incomplete` count), between blocked and
  warning; untested requirements moved there from warning.

### Added

- `gate --commit SHA` / `--environment NAME` (and the same on `assess_release_risk`,
  `release_submit`, the Action): only runs on that build count.
- `gate --advisory` (Action input `advisory`): exit 0 whatever the decision; the decision
  itself still says HOLD or UNKNOWN.
- `ingest-junit --environment NAME`. The same `--run-ref` delivering the same results again
  records nothing new; the same ref with a different outcome is refused.
- `gate --text "<PR title>"` (Action input `text`): assesses the ticket keys in free text,
  matched by `--ticket-pattern`. Text with no key in it is nothing to assess, not a pass.
- Action: `decision` output; `commit`, `environment`, `advisory` inputs; the run ref includes
  the attempt number so a re-run is a new result; the summary is posted on UNKNOWN too.
- **Action: with `junit`, the gate decides on the checked-out commit.** Results recorded for
  another build no longer count, and the ingested reports carry the same commit. A test that
  did not run in this job is UNKNOWN. Set `commit: any` to count results from every build
  (tests split across workflows); an explicit `commit` still wins. The CLI stays opt-in.
- **Action: `version` defaults to `0.4.0`**, not `latest`: a qa-spine release reaches a
  workflow only when it moves to an Action tag that names it.

### Packaging

- **Node >= 22.13** (was >= 22.5, where `node:sqlite` needs `--experimental-sqlite` and the
  package did not start). Working from source needs 22.18, for TypeScript without a flag.
- `scripts/smoke-package.mjs` installs a packed tarball into a fresh project under a path
  with spaces and runs version, init, record, ingest, gate, verify, export, the MCP handshake
  and the Inspector against it. `.github/workflows/ci.yml` runs the tests, packs once, and
  smoke-tests that one tarball on Linux, macOS and Windows under Node 22.13, 22, 24 and 26.

### Security

- **The Action no longer splices inputs into its shell script.** Every input — `since`,
  `changed`, `junit`, `reason`, `override-reason`, `approved-by`, `release-ref`,
  `ticket-pattern`, `version` — reaches the script through the environment, so a pull request
  title holding `$(…)` is data. 0.3's example passed the title as `changed`, which a hostile
  title could use to run commands in the job. **Move a title from `changed` to `text`**: as a
  `changed` ref the whole title matched nothing.
- `version` must be a release or a dist-tag; `npm:`, `file:` and URL specs are refused before
  `npx` runs.

## 0.3.0 — 2026-11-03

### Changes in behaviour — release gate

- **A superseded test case no longer decides.** Coverage, the readiness view and the gate now
  follow `supersedes` between test cases to the newest case, so a healed test whose
  replacement passes stops blocking. Before, the replaced case's last failed run blocked the
  release forever. The old case and the `supersedes` link stay in the ledger and the Inspector.
- **A hand-recorded pass no longer clears a failing test on its own.** A non-failing
  `test_run` written through `trace_record` or `record` (any producer, not only `human`)
  clears an earlier failure only when `provenance.approvedBy` names who vouches for it; the
  gate lists it as entered by hand. Without a name the gate reports "latest pass was typed in
  by hand with no one named in approvedBy" (`failingTests[].heldBecause`,
  `failingTests[].handRecordedPass`). Ship over it with a named override
  (`--override-reason` + `--approved-by`). Runs from `ingest-junit` work as before; raw
  writes cannot claim its tool name.
- **Retract.** `qa-spine retract <id> --by <name> --reason <why>` (CLI and Inspector only)
  withdraws something recorded by mistake from every "what is current" path; retracting the
  retraction undoes it. Nothing is deleted.

## 0.2.0 — 2026-09-30

### Changes in behaviour — read before upgrading from 0.1.0

- **Failing tests block a ship.** `assess_release_risk` and `release_submit` now treat a
  covering test whose latest run failed or errored on a changed area as a blocking signal,
  like an unanswered question. In 0.1.0 failing runs were unscored evidence. Test runs
  already in your ledger count from the first call under 0.2.0.
- **`trace_record` and CLI `record` refuse `finding`, `answer`, `verdict`, `audit` and
  `fixture`**, and a `supersedes` link onto a finding. Use `audit_submit`, `audit_answer`,
  `release_submit` and `fixtures_submit`. Requirements, test cases, test runs and a
  `supersedes` onto a test case are unaffected.
- **Recording a requirement whose `sourceRef` exists now versions it**: the same content
  writes nothing and returns the existing record; different content supersedes it.
- **`audit_submit` accepts an empty findings list**, recording a clean audit.
- **`release_submit` rejects an override of a live signal without `provenance.approvedBy`.**
- Stores written by 0.1.0 open unchanged and verify as legacy under the new hash chain.

### Added

- **The CI gate** — `qa-spine gate` (exit 0 clear, 1 blocked, 2 could not tell) and a
  composite **GitHub Action** (`uses: YdvVipin/qa-spine@v1`) that runs `verify`, optionally
  `ingest-junit`, then the gate, and can comment on the pull request.
- `qa-spine init`, `qa-spine demo`, `help` and `--version`.
- `qa-spine ingest-junit` — JUnit XML results into the ledger; flaky tests (pass and fail on
  one commit) are labelled, never excused. Action input `junit`.
- Hash chain on every artifact and edge, and `qa-spine verify`.
- Requirement versions, and **suspect** requirements (edited since their last audit); gate
  flag `--block-on-suspect`, Action input `block-on-suspect`.
- **Untested** requirements; `--require-coverage`, Action input `require-coverage`.
- Suggested answers on findings; answers that accept one are recorded as assumptions.
  `qa-spine answer`, and a blocked gate prints the commands that unblock it.
- `qa-spine rubric-report`, and `rubrics/candidates/ambiguity-2.json` (not the default).
- `qa-spine export --format csv|html|jsonl`, and the Inspector's readiness view.
- `qa-spine merge <other.db>`.
- Optional human approval of AI answers: `--require-human-answers` /
  `QA_SPINE_REQUIRE_HUMAN_ANSWERS=1`, and `qa-spine approve`.
- GitHub Issues and Linear importers in `examples/`.
- The rubric as an MCP resource, and an `audit-ticket` MCP prompt.
- `fixtures_request` / `fixtures_submit`: schema-validated test data with locale packs
  (`en-US`, `en-GB`, `de-DE`, `en-IN`).
- `release_submit` records areas a verdict dropped from its own assessment.

### Fixed

- Ingest no longer fails at once while another process writes to the store.
- A failing test covering two changed requirements is counted once.

## 0.1.0 — 2026-08-06

First release: the trace ledger, the Inspector, the ambiguity audit and its queue, release
risk with verdicts and the brief, and the `record`, `brief`, `audit-requirement`,
`audit-submit`, `inspect` and `review-export` commands.
