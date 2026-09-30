# qa-spine — project status

Snapshot as of **2026-09-29**, branch `fixtures` (stacked: `requirement-versions` → `faster-answers` → `rubric-measurement` → `coverage-reports` → `team-features` → `fixtures`, all unmerged; `main` @ `14149d0`). This is a status document, not
product documentation — see [README.md](README.md) for the user-facing description of
what qa-spine does and how to run it. This file exists to answer "what's actually built,
what's tested, and what's still open" in one place.

## What it is

qa-spine is an MCP server that gives any MCP-capable agent a set of QA-lifecycle tools —
auditing a requirement for ambiguity, assessing release risk, recording a verdict — all
backed by one append-only **traceability spine**: `requirement → finding → test_case →
test_run → verdict`, with every AI-produced artifact stamped with the model and prompt
version that made it.

Design stance that shows up everywhere in the code: **the server never calls a model**.
It hands data to the calling agent (a requirement + rubric, or unresolved findings +
evidence) and validates what comes back. It also never mutates JIRA, repos, or CI on its
own — every write is an explicit call the agent makes, and a `ship` verdict is blocked
unless the caller supplies an override reason while a signal is live.

## Status: every roadmap item built (Sep 2026)

| Phase | What | Status |
|---|---|---|
| 1 | Trace spine (append-only SQLite store, `trace_record` / `trace_query`) | Done |
| 1.5 | The Inspector (read-only local UI for judging agent output) | Done |
| 2 | `audit_requirement` / `audit_submit` — ambiguity audit against a published rubric | Done |
| 2.5 | Audit queue — `audit_open` / `audit_answer`, Inspector queue view | Done |
| 3 | `assess_release_risk` / `release_submit` — one-page release brief with a verdict | Done |
| — | **Audit-before-generating** — wires the Phase 2 audit into QAAE's ticket→test pipeline | Done (`efe86c1`) |
| 5 | Packaging — `npx qa-spine`, `init`, `demo`, published rubrics | Done |
| 4 | Delivery integration — `qa-spine gate` and a composite GitHub Action | Done |
| — | JUnit results — `ingest-junit`; a failing test on a changed area blocks; flaky tests labelled | Done, merged to `main` |
| — | Ledger integrity — hash chain + `verify`; raw writes can't record gated types; narrowed release lists recorded | Done, merged to `main` |
| — | Requirement versions — edits supersede instead of duplicating; suspect until re-audited; clean audits recorded | Done, on `requirement-versions` |
| — | Faster answers — suggested answers, `qa-spine answer`, unblocking commands in the gate | Done, on `faster-answers` |
| — | Rubric measurement — `rubric-report`; `ambiguity/2` as a candidate rubric | Done, on `rubric-measurement` |
| — | Coverage and reports — untested requirements, `export`, Inspector readiness view | Done, on `coverage-reports` |
| — | Team features — `merge`, GitHub/Linear importers, MCP resource + prompt, human-approval policy | Done, on `team-features` |
| — | Test data — `fixtures_request` / `fixtures_submit` with locale packs | Done, on `fixtures` |

What comes next, and why, is in
[docs/superpowers/plans/2026-09-29-enhancement-roadmap.md](docs/superpowers/plans/2026-09-29-enhancement-roadmap.md).

## Repository layout

```
src/
  server.ts          970 lines  MCP server + CLI entrypoint (all tool/subcommand wiring)
  release.ts         509 lines  release risk, verdicts, requirement status
  gate.ts            373 lines  `qa-spine gate` — the CI release check
  audit.ts           360 lines  ambiguity audit, answers, rubric report
  brief.ts           305 lines  verdict -> self-contained HTML brief
  junit.ts           263 lines  JUnit XML parser + `ingest-junit`
  fixtures.ts        187 lines  schema-validated test data, locale packs
  export.ts           82 lines  traceability matrix (csv, html), jsonl dump
  demo.ts            120 lines  seeds the worked example into a throwaway store
  trace/
    store.ts         621 lines  append-only store: triggers, hash chain, verify, merge, versioning
    schema.ts         98 lines  Zod schemas for artifacts/edges/provenance
  inspector/
    server.ts        141 lines  loopback-only HTTP server for the Inspector UI
    ui/                         index.html, style.css, app.js (vanilla, no build step)

tests/             5,431 lines across 27 files — 333 tests, all passing
rubrics/ambiguity.json          the published ambiguity rubric (4 rules, ambiguity/1)
rubrics/candidates/             ambiguity-2.json: v1 plus 5 rules, not yet the default
locales/                        en-US, en-GB, de-DE, en-IN packs for fixtures
action.yml                      composite GitHub Action: verify, ingest-junit, gate
examples/            import-jira.ts, import-github.ts, import-linear.ts, github-workflow.yml
docs/superpowers/    per-feature specs + implementation plans, and the enhancement roadmap
```

Zero runtime dependencies beyond `@modelcontextprotocol/sdk` and `zod` — the store uses
Node's built-in `node:sqlite`, so there's no native build step. Requires Node ≥ 22.5.

## MCP tools / CLI surface

| Tool | CLI equivalent | Makes a model call? |
|---|---|---|
| `health` | — | No |
| `trace_record` | `record` | No |
| `trace_query` | — | No |
| `audit_requirement` | `audit-requirement` | No — hands requirement + rubric to caller |
| `audit_submit` | `audit-submit` | No — validates what the caller reasoned out |
| `audit_open` | — | No |
| `audit_answer` | — | No |
| `assess_release_risk` | — | No |
| `release_submit` | — | No |
| — | `brief <verdictId>` | No — renders an existing verdict as HTML |
| — | `inspect` | starts the Inspector UI |
| — | `review-export` | exports human review labels as JSONL |
| — | `gate` | No — the CI release check; exit 0 clear, 1 blocked, 2 could not tell |
| — | `init` / `demo` | No — project setup / worked example in a throwaway store |

Every tool that could plausibly be tempted to call a model doesn't — the audit and
release-risk tools return raw material (rubric, evidence) and only ever validate the
caller's output. This is the load-bearing design decision the whole "self-hostable,
nothing leaves your machine" claim rests on.

## Guarantees worth knowing about (and their edges)

These are the invariants the code actually enforces, plus where the enforcement
deliberately stops — pulled from the README and the SDD review ledgers, not aspirational:

- **Append-only, enforced by SQLite triggers**, not application code — survives someone
  opening the file with the raw `sqlite3` CLI.
- **Provenance is mandatory**: an artifact claiming `producer: "ai"` is rejected unless it
  also carries `model` and `promptVersion`.
- **`audit_submit` is all-or-nothing**: a finding citing an unknown rule id, a
  non-verbatim quote, or a jargon-phrased `question` gets the *whole batch* rejected, not
  just that finding. A caller-supplied `promptVersion` is silently overwritten by the
  rubric's own version rather than honored.
- **`release_submit` recomputes signals from `changed` itself**, refuses `ship` while a
  signal is live without an `override: { reason }`, and rejects internal jargon in
  `reason` text (same lint as the audit's `question` check). What it does *not* do: cross-
  check the `changed` list against an earlier `assess_release_risk` call, or stop
  `trace_record` from appending a verdict directly and bypassing the gate entirely —
  README documents this hole explicitly rather than papering over it.
- **Nothing stops an agent from answering its own audit questions or overriding its own
  ship gate.** Provenance is the safeguard (it's visible in the Inspector, colored and
  labeled), not a lock.

## The cross-repo integration (audit-before-generating)

This was the most recent substantial work, spanning two repositories:

- **qa-spine** (this repo, TypeScript) — added the `audit-requirement` and `audit-submit`
  CLI subcommands so a non-JavaScript caller can drive the audit.
- **QAAutomationAIEnabler** ("QAAE", Python, sibling repo) — wired `start_from_ticket`
  (the ticket → generated-test pipeline) to run the ambiguity audit against a new
  requirement *before* generating fixtures/tests from it, via a new `ambiguity_auditor`
  module and `spine_client` integration.

Delivered across 4 tasks, reviewed, and taken through **two fix waves** (11 findings from
a final opus review — 0 Critical, 5 Important, 6 Minor — then 4 more residuals from
re-review) before a human ruling authorized merge on 2026-08-05. Notable fixes, because
they're the kind of bug that's easy to reintroduce:

- A rejected (all-or-nothing) audit batch used to still report fake `open_questions` and
  a nonzero count on the job, while the store held nothing. Fixed to degrade to `[]`,
  matching every other spine failure mode.
- `("openai", "audit")` used to fall back to `OPENAI_PLAN_MODEL` if unset — an install
  that pinned its planner model got audits at plan price, silently.
- The model actually used to call the LLM and the model recorded in provenance were
  resolved **twice**, independently, and could diverge if a credential-store read failed
  in between. Fixed so the resolved model is threaded through, not re-resolved.
- No timeout on either provider client (SDK default ~600s / worst case ~1800s across
  retries) sat between plan generation and recording the plan — a hang could stall an
  already-paid-for plan generation. Fixed with a 60s timeout, flagged with a `ponytail:`
  comment noting the upgrade path if a provider genuinely needs longer.
- A recurring pattern the review ledger calls out explicitly, **five times this session**:
  tests that pass for the wrong reason because they exercise the setup around a behavior
  rather than the behavior itself (e.g., a "never raises" test whose mock never reaches
  the guarded line). The standing countermeasure adopted: revert the fix, rerun, require
  the test to fail before trusting it.

Final state: **134/134 tests passing** on qa-spine, **105 passed / 1 skipped** on QAAE,
`tsc` clean, and the real `.qa-spine/trace.db` verified untouched (still 8 artifacts,
mtime unchanged) throughout — all verification ran against a scratch DB via `QA_SPINE_DB`.

## Known deferred items (not bugs, logged and left alone on purpose)

- `audit-submit` constructs the store before reading stdin, while `record` defers
  construction until after — a harmless inconsistency with the codebase's own pattern.
- No test directly asserts a caller-supplied `promptVersion` is overwritten (only that an
  omitted one is stamped); verified manually during review instead.
- In QAAE, if `start_from_ticket` resumes a job whose `plan` is still `None` (an earlier
  call died mid-flight), the early-return guard doesn't catch it and a second job gets
  created for the same ticket. Pre-existing, out of scope for the audit-before-generating
  work, not touched.
- The release-risk gate (`release_submit`) can still be defeated by appending a
  `supersedes` edge to an open finding via a raw `trace_record` call, or by calling
  `trace_record` directly with `type: 'verdict'` — both documented in the README as
  known, deliberately-unenforced holes rather than fixed, because the enforcement lives
  in `release_submit` by design, not in the store.

## Testing

- qa-spine: `npm test` → 333/333 passing, `tsc` clean via `npm run build`.
- QAAE side of the integration: 105 passed, 1 skipped across the auditor, spine-client,
  spine-instrumentation, orchestration-loop and plan-generator suites.
- Every fix in the final review round was verified with an explicit **round-trip**: revert
  the fix, confirm the specific test fails, restore the fix, confirm the full suite is
  green again — not just "test added."

## Where things live if you need to dig further

- `README.md` — the product-facing description, tool table, and the honest list of what
  each guarantee does and doesn't cover.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — one dated spec + plan per
  feature, oldest to newest: phase-2 audit, phase-2.5 audit queue, phase-3 release risk,
  spine integration, release brief, audit-before-generating.
- `.superpowers/sdd/<feature>/progress.md` — the execution ledger per feature: what was
  built, every review finding, every fix round, verified with round-trips. The most
  detailed record of *why* the code looks the way it does.
- `rubrics/ambiguity.json` — the 4 published ambiguity rules (`AMB-VAGUE-QUANT`,
  `AMB-MISSING-ACTOR`, `AMB-OPEN-LIST`, `AMB-UNTESTABLE`), versioned `ambiguity/1`.
