# Changelog

## Unreleased

### Changes in behaviour — release gate

- **A superseded test case no longer decides.** Coverage, the readiness view and the gate now
  follow `supersedes` between test cases to the newest case, so a healed test whose
  replacement passes stops blocking. Before, the replaced case's last failed run blocked the
  release forever. The old case and the `supersedes` link stay in the ledger and the Inspector.
- **A hand-recorded pass no longer clears a failing test.** A non-failing `test_run` with
  `producer: "human"` does not clear an earlier failure; the gate reports
  "latest pass was hand-recorded, not from a tool run" (`failingTests[].heldBecause`,
  `failingTests[].handRecordedPass`). Ship over it with a named override
  (`--override-reason` + `--approved-by`). Tool-recorded runs work as before. If your
  pipeline records its own results as `human`, switch it to `producer: "tool"` with a
  `tool` name, or its passes will hold.

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
