# qa-spine enhancement roadmap

**Date:** 2026-09-29
**Branch at time of writing:** `junit-results` (cut from `delivery-integration` @ `6b606ca`)
**Status:** sequence and policy decisions approved 2026-09-29 (section 5). Each milestone still
gets its own spec + plan pair before code.

This document does three things: lists what is still unfinished, compares qa-spine with
what already exists in the market, and turns both into a sequenced set of enhancements.

---

## 1. Where we are

| Area | State |
|---|---|
| Trace ledger, Inspector, ambiguity audit, audit queue, release risk + brief, packaging | Done, on `main` |
| CI gate (`qa-spine gate`) and GitHub Action | Done, on `delivery-integration`, **not merged to `main`** |
| JUnit results + failing tests block | Spec approved (`specs/2026-09-25-junit-results-design.md`), **not implemented** |
| `generate_fixtures` | Not started |
| Working tree | Uncommitted edits to 4 older spec/plan docs and `.gitignore`; untracked `LICENSE`, `PROJECT_STATUS.md`, `docs/qa-spine-explained.html` |
| `PROJECT_STATUS.md` | Stale: says phases 4 and 5 are "Not started"; both are done |
| Action tag | `examples/github-workflow.yml` uses `YdvVipin/qa-spine@v1`; no `v1` tag exists yet |

Tests: all passing on `junit-results` (`npm test`, 2026-09-29).

---

## 2. What already exists

Research done 2026-09-29 by web search. It covers what is findable, not everything that
exists; treat "nobody does X" as "we found nobody doing X".

### 2.1 The landscape

| Product | What it is | How it differs from qa-spine | Worth borrowing |
|---|---|---|---|
| **Qase + Qase MCP** | Cloud test-management platform; official MCP server with ~83 tools; requirements traceability matrix; "Test Intelligence" release-readiness view; its own AI test generation | Cloud-hosted, calls AI itself (credit-metered), records are editable, readiness is test-result driven. No concept of an unanswered requirement question blocking a release | A release-readiness **view** per release; bulk operations |
| **QMetry MCP**, **Tricentis qTest MCP**, community **Xray Cloud MCP** | MCP front-ends onto existing enterprise test-management tools | Agent is a new UI for an existing system of record. Traceability lives in the vendor tool. No ambiguity audit, no gate | Nothing structural; confirms "MCP as the agent's door into QA data" is the direction the market is going |
| **requ-mcp** (open source) | Closest open-source analogue: ~40 MCP tools + REST, SQLite/Postgres, 9-tab live dashboard, per-call audit log, version locking, "strict vs cumulative" coverage | Specs are **editable** (locking instead of append-only). Tracks coverage, not open questions. No AI provenance (model / prompt version). No ambiguity audit | **Strict coverage mode** for release sign-off; per-call audit of refused calls |
| **reqcov** (open source) | Requirements-coverage CI gate: reads requirements from repo files, finds `@req` markers in tests, merges JUnit, fails on missing coverage, orphan tests, failing tests, coverage regressions. Outputs HTML/CSV/JSON/Markdown/PDF/ReqIF | Deterministic, no AI, no questions, no ledger history. Requirements must live in the repo | **Orphan-test** and **coverage-regression** checks; CSV/matrix exports; progressive tightening (report first, block later) |
| **OpenFastTrace**, **StrictDoc**, **Doorstop** | Requirements-as-code: stable IDs, typed parent/child links, tags in source, tracing reports in CI | Built for regulated, document-heavy teams. Requirements authored in the repo, not tickets. No AI | Requirement **hierarchy** (epic → story) if users ask |
| **Jama Connect** (also Polarion, DOORS) | Enterprise requirements management | Heavy, commercial, cloud or on-prem server | **Suspect links**: when a requirement changes, everything downstream is flagged "suspect" until someone reviews it |
| **requirements-analyzer** (open source CLI) | Rule engine for vague words, missing Given/When/Then, missing negative paths; optional Claude layer; 0–100 clarity score; `--fail-on` exits 2 | Stateless: every run starts from scratch, nothing remembers whether a question was answered. Calls the model itself | **Clarity score**; Given/When/Then and missing-error-path rules |
| **Requirement Ambiguity Hunt** (agent skill) | Prompt-only skill: 7 ambiguity categories, ≤10 numbered questions, each with *why it matters* and a **proposed default answer**, classified answered / assumption / open | No storage, no enforcement. Flags downstream tests that depend on open questions but blocks nothing | **Proposed default answers**; **assumption** as a status; its 7 categories for rubric v2 |
| **Allure Report 3 / Allure TestOps**, **Testmo** | Test reporting with quality gates (`maxFailures`, `successRate`, `minTestsCount`) as a GitHub check | Gates on test numbers only; requirements are at most a label | `minTestsCount`-style sanity rule ("a report with zero tests is not a pass" — our JUnit spec already does this) |
| **Trunk Flaky Tests**, **BuildPulse** | Ingest JUnit on every run, detect tests that flip on the same commit, auto-quarantine, auto-release after 7 clean days | Pure test-health tools | **Flaky detection + quarantine**, needed before failing tests can block (see R2) |
| **Langfuse** | LLM observability: annotation queues, score configs, score analytics compared across prompt versions | General LLM-ops platform, not QA | **Score analytics per prompt version**, which is exactly what `review-export` is collecting data for but nothing reads yet |

### 2.2 What this means

**Where qa-spine is different, and nothing we found combines these:**

1. A requirement's *unanswered question* is a first-class record that **blocks a release**.
   Everyone else gates on test results or coverage numbers. The ambiguity tools that ask
   questions (requirements-analyzer, Ambiguity Hunt) forget them after the run.
2. **Append-only ledger with AI provenance** (model + rubric version on every AI record,
   override with a name). requ-mcp and Qase have audit logs, but records stay editable
   and AI output isn't stamped with the prompt version that made it.
3. **No model calls, fully local.** Qase and requirements-analyzer call the model
   themselves; qa-spine validates what the user's own agent produced.
4. **A brief a project manager can read**, generated from the ledger, rather than a dashboard.

Keep these four. Every enhancement below is checked against them.

**Where qa-spine is weaker:**

- No handling of **requirement changes** (Jama's suspect links). Re-running
  `examples/import-jira.ts` records a *second* requirement with the same `sourceRef` and no
  link to the first; old findings stay attached to the old text.
- **No coverage view**: a changed requirement with no test at all passes silently (reqcov, requ-mcp).
- **Failing tests will block with no flaky handling** once the JUnit phase ships (Trunk, BuildPulse).
- **Rubric is small**: 4 rules vs Ambiguity Hunt's 7 categories; no error-path, clock/timezone, data-rule or contradiction checks.
- **The measurement loop is open**: review labels are exported, but nothing turns them into "rubric v2 is better than v1".
- **Answering is slow**: only the Inspector (localhost) or an MCP call. There's no suggested answer and no CLI command.
- **Tamper-*evident*** is not tamper-*proof*: triggers stop edits through `sqlite3`, but not someone dropping the triggers or swapping the file.
- **Single-machine store**: CI and teammates need the same file; the Action leaves that to the user.

---

## 3. Enhancement ideas

Size: **S** ≈ 1–2 days, **M** ≈ 3–5 days, **L** ≈ 1–2 weeks (one developer, with tests and review).

### Robustness

**R1. Requirement versions and suspect links** (M, from Jama)
- `record` (and the importer) given a `sourceRef` that already has a requirement with
  *different* text records the new one with `supersedes` → old. Same text → no-op, returns the existing id.
- Findings, answers and tests linked to a superseded requirement become **suspect**: shown
  amber in the Inspector and chain view, listed by the gate as *"PROJ-42 changed since it
  was audited"*.
- Policy: suspect is a **warning** by default; `--block-on-suspect` makes it a signal.
  (Blocking by default would fail every PR the day after a ticket edit.)
- Clears when the new version is re-audited (an `audit_submit` against it, even with zero findings → needs an explicit "audited clean" record).

**R2. Flaky-aware test blocking** (M, from Trunk/BuildPulse; amend the JUnit spec before building it)
- A test whose runs disagree on the **same commit** (needs `--commit` on `ingest-junit`, default `git rev-parse HEAD`), or whose duplicates in one report disagree (retry plugins), is marked flaky.
- Detection only (decided 2026-09-29): a flaky test's failure **still blocks**, labelled flaky in the gate output and the brief, so whoever overrides or reruns knows why. No automatic quarantine.
- Without the label, the first flaky test after the JUnit phase ships teaches the team to override by habit without knowing whether the failure was real.

**R3. Hash chain + `qa-spine verify`** (S)
- Each artifact row stores `sha256(previous_hash + canonical JSON of this row)`.
- `qa-spine verify` recomputes the chain and exits 1 on any break; the Action runs it before `gate`.
- Detects dropped triggers, edited rows and deleted rows, which triggers alone can't.

**R4. Close the documented gate holes** (S)
- `trace_record` refuses `type: 'verdict'` and `type: 'answer'` (must go through `release_submit` / `audit_answer`) and refuses a `supersedes` edge onto a `finding`.
- `release_submit` records the diff between its `changed` and the `changed` of the most
  recent `assess_release_risk` for the same `releaseRef` (needs assess to write a small
  `tool` artifact, or the verdict just stores both). A narrowed list then shows in the brief.
- README's "known holes" section shrinks accordingly. Each guard gets the revert-and-fail round trip.

**R5. Coverage signal** (M, from reqcov/requ-mcp)
- Gate reports **untested**: a changed requirement with no `covers` edge.
- Reports **orphan tests** after JUnit ingest: tests with no ticket key.
- Warning by default, `--require-coverage` blocks. Rolled out report-first, like reqcov.

**R6. Optional human-answer policy** (S)
- `QA_SPINE_REQUIRE_HUMAN_ANSWERS=1` (or a flag on the gate): an AI-produced answer does not retire a finding until a human record approves it (`approvedBy` already exists on provenance).
- Off by default, which matches today's behaviour.

### Intuitiveness

**I1. Suggested answers and "assumption" status** (M, from Ambiguity Hunt)
- `audit_submit` findings may carry `suggestedAnswer` (plain-language lint applies).
- Inspector queue: **Accept suggestion** (one click, recorded as a human answer that cites the suggestion) or write your own.
- A finding answered by accepting a suggestion is labelled *assumption* in the brief, so a PM sees which answers nobody actually thought about.
- Main effect: answering questions stops being the bottleneck. That's what decides whether teams keep qa-spine turned on.

**I2. Answer where people already are** (S)
- `qa-spine answer <findingId> "text" --by <name>` CLI (today only MCP and the Inspector can answer).
- The gate's PR comment lists each open question **with the exact command to answer it** and the exact override command. A red check should say how to turn it green.

**I3. `qa-spine status [ref]`** (S) — *dropped 2026-09-29: `gate --changed <ref>` without `--record` is that command already.*
- Plain-English summary for a ticket or release: open questions, suspect items, latest test results, last verdict. The terminal version of the brief, for developers.

**I4. Release-readiness view + clarity score** (M, from Qase, requirements-analyzer)
- Inspector view per `releaseRef`: every requirement touched, open / answered / suspect / untested, one line each, sorted worst first.
- Clarity score — *dropped 2026-09-29: it would be a number built from invented weights; the readiness view's counts say the same thing honestly.*

**I5. Close the measurement loop** (M, from Langfuse score analytics)
- `qa-spine rubric-report`: from review labels, 👍 rate and 👎 notes grouped by `promptVersion` × `model` × rule.
- Then **rubric `ambiguity/2`** (shipped 2026-09-29 as `rubrics/candidates/ambiguity-2.json`, not the default, since no labelled data exists yet to compare it on): add missing error path, clock/timezone, data rules (format, rounding, limits), permissions, contradictions between criteria. Ship it only if `rubric-report` shows it isn't worse than v1 on labelled data.
- This turns the README's claim that rubric edits are "measurable" into a command anyone can run.

**I6. Exports** (S–M, from reqcov)
- `qa-spine export --format csv|matrix-html|jsonl`. Traceability matrix HTML follows the brief's rules (no JS, no external requests).
- ReqIF only if a regulated user asks.

### Reach

**X1. Share the store** (M)
- `qa-spine bundle` / `qa-spine merge <bundle>`: append-only union of two stores. IDs are
  random and unique, and nothing is ever updated, so a merge is a set union plus a
  hash-chain re-link (R3). Lets CI branches and teammates combine ledgers without a server.

**X2. Importers as examples** (S each)
- `examples/import-github-issues.ts`, `examples/import-linear.ts`, following the Jira script
  (and R1's update behaviour). The server stays network-free.

**X3. MCP resources and prompts** (S)
- Expose the rubric as an MCP **resource** and an "audit this ticket" MCP **prompt**, so clients like Claude Code show them in their menus without the user knowing tool names.

**X4. `generate_fixtures`** (L, existing roadmap item)
- Unchanged from the current roadmap. Kept last: it adds a new capability, while everything above makes the existing promise hold.

### Deliberately not proposed

- **A hosted dashboard or server.** It would break "nothing leaves your machine" and turn qa-spine into a weaker version of Qase.
- **qa-spine calling a model itself.** The same reason, plus the provenance model depends on the caller's agent being accountable.
- **Two-way Jira sync from the server.** Importers stay in `examples/`.

---

## 4. Sequenced plan

Each milestone: spec → plan → TDD implementation → review → merge. Every new guard is
verified by reverting the fix and watching its test fail (six vacuous tests so far on this
project; that check is the countermeasure).

| # | Milestone | Contains | Size | Why this order |
|---|---|---|---|---|
| **M0** | Housekeeping | Commit or discard the loose doc edits; commit `LICENSE`; refresh `PROJECT_STATUS.md`; merge `delivery-integration` → `main`; tag `v1` for the Action; npm publish (needs your OTP) | S | The README and examples already point at `@v1`, which doesn't exist yet |
| **M1 ✅** | Test results | JUnit spec as approved **+ R2 flaky handling** (spec amendment first) | L | Designed and next on the roadmap; flaky handling has to ship with it, not after |
| **M2 ✅** | Trustworthy ledger | R3 hash chain + `verify`, R4 close gate holes | M | Small, and every later feature builds on the store being trustworthy |
| **M3 ✅** | Requirements change | R1 versions + suspect links; importer update behaviour | M | Biggest correctness gap found in research; affects real use as soon as tickets are edited |
| **M4 ✅** | Faster answers | I1 suggested answers, I2 `answer` CLI + actionable PR comment, I3 `status` | M | Adoption: once the gate blocks, the next thing users feel is how slow it is to unblock |
| **M5 ✅** | Measurement | I5 `rubric-report`, then rubric `ambiguity/2` | M | Needs M4's answers and reviews to have data |
| **M6 ✅** | Coverage + reporting | R5 coverage signal, I4 readiness view, I6 exports | M–L | Needs M1 test data |
| **M7** | Teams | X1 bundle/merge, X2 importers, X3 MCP resources/prompts, R6 policy | M | Only matters once more than one person uses a store |
| **Later** | `generate_fixtures` | X4 | L | |

### Acceptance checks per milestone

- **M0:** `main` contains the gate and Action; `uses: YdvVipin/qa-spine@v1` resolves; `PROJECT_STATUS.md` matches the README roadmap.
- **M1:** everything in the JUnit spec's Testing section, plus: a test that failed and passed on the same commit is reported flaky; a flaky failing latest run still blocks.
- **M2:** editing a row after dropping the triggers makes `verify` exit 1; `trace_record` with `type: 'verdict'` is rejected; a narrowed `changed` list appears in the brief.
- **M3:** re-importing an unchanged ticket writes nothing; an edited ticket supersedes the old requirement; the gate lists the change as suspect; `--block-on-suspect` exits 1.
- **M4:** accepting a suggestion retires the finding and the brief labels it an assumption; the PR comment's commands, pasted as-is, unblock the gate.
- **M5:** `rubric-report` on the demo store prints per-version rates; v2 ships only with a report showing it is no worse than v1.
- **M6:** a changed requirement with no test is listed as untested; `--require-coverage` exits 1; exported HTML contains no script and no external URL.
- **M7:** merging two stores built from the same base gives the union and passes `verify`.

---

## 5. Decisions (made 2026-09-29)

1. **Suspect items (M3):** warn by default; `--block-on-suspect` opts in to blocking.
2. **Flaky tests (M1):** detect and report only. No automatic quarantine: nothing relaxes
   the gate without a person's name on it.
3. **AI answers (R6):** today's behaviour stays the default; human approval is opt-in.
4. **Loose working-tree edits (M0):** committed. They replaced absolute home paths in four
   older spec/plan docs with `~/projects/...` and ignored `.claude/`.

## Sources

- Qase MCP: https://www.qase.io/mcp-model-context-protocol/ · https://github.com/qase-tms/qase-mcp-server
- QMetry MCP: https://community.smartbear.com/kb/qmetry-technical-articles/qmetry-mcp-bringing-control-coverage-and-traceability-to-ai-driven-qa/279557
- Tricentis qTest MCP: https://www.tricentis.com/blog/optimize-test-management-tricentis-qtest-mcp
- Xray Cloud MCP: https://glama.ai/mcp/servers/remynln/mcp-xray-cloud
- MCP test-management comparison: https://dev.to/naina_garg/how-mcp-is-changing-test-management-and-which-tools-support-it-1707
- requ-mcp: https://github.com/nouhouari/requ-mcp
- reqcov: https://github.com/Antoine005/reqcov
- OpenFastTrace: https://github.com/itsallcode/openfasttrace · StrictDoc: https://strictdoc.readthedocs.io/
- Jama suspect links: https://www.jamasoftware.com/blog/2025/09/13/the-importance-of-suspect-tracking-in-requirements-management/ · https://help.jamasoftware.com/ah/en/manage-content/coverage-and-traceability/relationships/clear-suspect-links.html
- requirements-analyzer: https://github.com/GabrieleScano/requirements-analyzer
- Requirement Ambiguity Hunt: https://qaskills.sh/skills/opaland/requirement-ambiguity-hunt
- Allure quality gates: https://allurereport.org/docs/quality-gate/ · Testmo: https://qaskills.sh/blog/testmo-test-management-guide-2026
- Trunk flaky tests: https://trunk.io/flaky-tests · BuildPulse: https://buildpulse.io/products/flaky-tests
- Langfuse annotation and score analytics: https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues · https://langfuse.com/docs/evaluation/scores/score-analytics
- Tamper-evident audit logs (hash chaining): https://predictionguard.com/blog/eu-ai-act-compliance-audit-log-what-regulators-expect-and-how-to-document-it
