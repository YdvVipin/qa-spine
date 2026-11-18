# qa-spine 0.4.0 finish plan (18 Nov 2026)

Repo `~/Desktop/MLProjects/qa-spine`, branch `fix/release-truth` @ `b4f9c75`, draft PR #4 into
`main`. Inputs: `_fable-sprint/2026-11-17-ALL-RECOMMENDATIONS.md` §2,
`_fable-sprint/coding-plans/qa-spine.md`, `_fable-sprint/2026-11-17-ratifyqa-qaspine-integration-plan.md`
(groups A, C, D, E, §8, §9), and RatifyQA's `docs/qa/finish-plan-2026-11-18.md` on
`feat/phase1-trust-triage` (read only). Every "done" line below was checked today.

Goal: the release-evidence layer a release manager trusts more than Xray, Zephyr or TestRail.
In practice: every decision names a person and a reason, missing evidence can never read as
green, and the person deciding reads plain sentences, not CI output.

## Already done (checked 18 Nov)

| Item | State | How I checked |
|---|---|---|
| One evaluator, SHIP/HOLD/UNKNOWN/OVERRIDDEN, exit 0/1/2 | Done on this branch | `src/release.ts` `decide()`; `tests/release-truth.test.ts` (24) |
| `completed` and other unknown statuses refused on write | Done | `src/trace/store.ts` `record()`; R08 test |
| Action passes every input through `env:`; hostile PR title is data | Done | `tests/ci-input.test.ts`: no `${{` in any `run:`, `$(…)`/backtick/`;` in `text`, `changed`, `approved-by` never run (a `pwned` file check) |
| `npm ci && npm test` | 424 pass, 0 fail | Run today in this folder |
| Build, packaged smoke | Pass on Linux / Node 22.23 | Run 9 Nov; re-run in Phase 1 |
| CI 3 OS × Node 22.13 / 22 / 24 / 26 | Green at `b4f9c75` | `gh run view` on PR #4 |
| RatifyQA A1–A4, A6, B | Done on their branch | Their finish plan, final table. Their real-CLI tests use `QA_SPINE_04_DIR`, which pointed at `qa-spine-release-truth`; that folder is now `_archive/`, so **they should point it at `~/Desktop/MLProjects/qa-spine`** |
| A5 by property | Works today | `src/junit.ts` reads keys from the test name, the classname and `<property name="requirement">`. Not yet proven through the real CLI, and there is no `--map` |

Not done: `PROJECT_STATUS.md` (dated 29 Sep, says Node ≥ 22.5), the changelog date (says 6 Nov),
and nothing in qa-spine shows a release manager a page they could decide on. This repo's README
has no `npm install -g`; the `install -g` line the sprint notes mention is in RatifyQA's README,
which I do not edit.

## Decisions (my default in bold; I go ahead with it unless you say otherwise)

1. **Where a release's scope lives.** ~~A new `release` artifact type~~. **Changed on 18 Nov,
   your choice: the stories go in the link** (`?release=1.4&changed=PROJ-1,PROJ-2`), and once
   decided the verdict carries them. Reason: qa-spine 0.3 and the demo box's build validate
   every row's type on read, so a new type would make a store unreadable by them and break
   rollback. Trade-off accepted: an undecided release is listed nowhere until decided.
2. **Who decides on the Release page.** The Inspector's retract and answer forms already take a
   typed name; signed identity is E4, which is not in this brief. **Default: Ship / Hold / Ship
   anyway record the typed name as a claimed name, and the page says "Recorded as typed; not
   signed in." Writes stay as they are today otherwise.** Because the demo box publishes through a
   tunnel, I list "do not expose decision writes publicly before E4" in the final report.
3. **Ship anyway and the bug key.** **Default: the Release page requires a name, a reason of 20+
   characters and at least one Jira key (`ABC-123` shape). The verdict stores them as
   `override.defects: ["ABC-123"]` (C1's shape), not inside the reason. The CLI and MCP accept the
   same field optionally**, so existing `--override-reason` callers keep working.
4. **Node older than 22.13.** `dist/server.js` imports `node:sqlite` before any code runs, so a
   check inside it is too late. **Default: a 15-line `dist/cli.js` becomes the `bin`; it checks the
   version, prints one sentence ("qa-spine needs Node 22.13 or later; this is Node 20.x.") and
   exits 2, then imports `server.js`. `dist/server.js` stays runnable, so existing
   `claude mcp add … node …/dist/server.js` lines keep working.**
5. **Changelog date.** **Default: set it to the day I finish (today's date in the final commit);
   you change it on publish day if that differs.** The publish commands in the final report include
   that check.

## Order, and how each is proven

One commit per row, tests in the same commit. "Proof" names the test, and each guard is checked
by breaking it on purpose and watching that test fail (this repo's recurring bug is a test that
passes either way).

### Phase 1: prove 0.4.0 is releasable

| # | Item | Change | Proof |
|---|---|---|---|
| 1.1 | Baseline | none | `npm ci && npm test` count; `npm run build`; `npm pack --dry-run` lists `dist/` (incl. `dist/inspector/ui/`), `rubrics/`, `locales/`, `README.md`, nothing else; `node scripts/smoke-package.mjs` on the packed tarball |
| 1.2 | A5 by name, classname and property | none, if they already work | New real-CLI tests (spawn `node src/server.ts ingest-junit` on a temp store): a key in the name links; a key only in `<property name="requirement">` links; then `gate --changed` on that story counts the run |
| 1.3 | A5 `--map` | `ingest-junit --map <file.json>`: `{"<classname>::<name>" or "<name>": "KEY" or ["KEY", …]}`. Keys are added to what the name already says. A map naming a test the reports lack is reported, not silent; a map that is not valid JSON fails before anything is written | Real-CLI tests: a test with no key in its name links only through the map; a bad map writes nothing (row count unchanged); README section |
| 1.4 | Action input safety | none expected | Existing `ci-input.test.ts` re-run and cited; add one case: a PR title in `text` containing a newline plus `$(touch pwned)` plus a backtick, end to end, asserting no `pwned` and the gate received the exact bytes |
| 1.5 | Docs | `PROJECT_STATUS.md` rewritten from git (branch, version, npm state, test count, `wc -l`); changelog date (decision 5); README: Node 22.13+, `npx qa-spine …` as the main path; the first screen is the two `npx` commands | A test that `CHANGELOG.md`'s top version equals `package.json`; `grep` finds no `22.5` or `install -g` in README, `PROJECT_STATUS.md` or `docs/` outside the changelog's history |

### Phase 2: first run and MCP

| # | Item | Change | Proof |
|---|---|---|---|
| 2.1 | Node version check | Decision 4 | Unit test of the check function with a faked version; a test that the `bin` is `dist/cli.js` and that `cli.js` exits 2 with the sentence for `20.11.0` (run with an injected version) |
| 2.2 | `init` review | Plain messages; every error names the next step | Tests: second `init` changes nothing and says so; unwritable directory → one sentence naming the path and exit 1 |
| 2.3 | `demo` review | Cleans its temp folder and stops the Inspector on Ctrl-C; prints one line saying where to look | Test: SIGINT → exit 0, temp folder gone; time from start to the Inspector answering, measured in the test (budget: 10 s on CI; the "2 minutes" includes reading) |
| 2.4 | Unknown subcommand / `--help` | Unknown → exit 2 with the list; `<cmd> --help` prints that command's line | `cli-help.test.ts` cases |
| 2.5 | 11 MCP tools against 0.4.0 | For each: the description says what it returns and the next step; every input has `.describe()` with an example; errors name the field and accepted values; `trace_record` with `completed` lists the eight statuses; `release_submit` refused on UNKNOWN lists the open reason codes and what closes each; `assess_release_risk` returns `decision` and `reasons`. No tool or input renamed | One MCP test per tool through the in-memory client (`tests/release-truth.test.ts` pattern), including a test that the 11 names are unchanged |

### Phase 3: the Release page (group D)

| # | Item | Change | Proof |
|---|---|---|---|
| 3.1 | D4 one wording table | `src/words.ts`: each decision → sentence and colour (Ready to ship / Not ready / Can't tell yet / Shipped anyway), each of the 8 reason codes → one sentence. Gate summary, brief and Release page read it | Test: every code in `REASONS` and every decision has a sentence (fails if one is added without words); existing gate/brief wording tests updated |
| 3.2 | Release scope | Decision 1 as changed: the link, then the verdict | `release-view.test.ts`: a decided release opens by id alone; an undecided one with no stories is a 404 saying how to open it |
| 3.3 | D1 `/api/release?release=<id>` | Returns the decision from the one evaluator (never a second computation), the sentence, and three lists: passed, failed (with bug key and who found it), no evidence (what is missing); plus the latest verdict, if any | API test: one release of each kind returns the expected decision and lists; the decision equals `runGate` on the same store |
| 3.4 | D1 page | Opening the Inspector with `?release=<id>` lands on the Release page; the six engineer views sit behind an "Evidence" link. Rendering is a pure function in `src/inspector/ui/release.js` so a test can read its text | Test: rendered text contains no artifact id, relation name, status code or reason code, for all four states |
| 3.5 | Ship / Hold / Ship anyway | `POST /api/release/decide`. Ship only when Ready; Hold always; Ship anyway only for Not ready, never Can't tell yet; needs name, reason ≥ 20 characters and ≥ 1 Jira key (decision 3). The page shows exactly what will be recorded before confirming | API tests for each refusal (Ship on Not ready, Ship anyway on Can't tell yet, short reason, no key, blank name) and each success; the verdict carries `override.defects` |
| 3.6 | D5 banner | "Decided on <date>; N results have changed since": N counts results and withdrawals recorded on this release's tests after the verdict. The recorded decision is never changed | Test: decide, ingest a new result, the banner says 1; the verdict is unchanged |
| 3.7 | D2 demo | `npx qa-spine demo` seeds three synthetic releases (one ready, one not ready, one can't tell; `PROJ-*` keys, invented names) and opens the Release page list | `cli-init-demo.test.ts`: the three releases return the three decisions; the smoke script opens the page from the packed tarball |

### Phase 4: trust and the bug link (only if phases 1–3 are green)

| # | Item | Change | Proof |
|---|---|---|---|
| 4.1 | C1 defect link on a run | `test_run` content may carry `defect: {key, url?, state?}`, validated (key shape, http(s) URL). The old free-text `bug_key` stays readable and is shown as the key | Tests: valid defect stored and shown in the brief and the Release page failed list; malformed key refused with the field named; an old `bug_key` row still renders |
| 4.2 | E1 no silent loss | Every failed write exits non-zero (CLI) or returns `isError` (MCP) with the reason; nothing partial is written | Tests: a locked store → error and row count unchanged; an invalid link target → error, nothing written |
| 4.3 | E3 producer `tool` | Raw `record` accepts `producer: "tool"` with a tool name for automated runs; it is shown as automated; it still cannot claim the ingest tool's name or count without a name (0.4 rule unchanged) | Tests for each |
| 4.4 | E5 batch record | `qa-spine record --batch` reads JSON lines: all checked first, one transaction, ids out in order, any bad line names its line number and writes nothing | Tests: 50 lines → one process, 50 ids; line 7 bad → error naming line 7, row count unchanged |

Deferred unless time allows, with reasons: E2 (requirement identity) and E4 (signed identity) are
RatifyQA-side or need RatifyQA to issue tokens; F (importers, speed budget) is a separate plan;
a publish-from-CI workflow with `--provenance` is prepared only if you want it in this PR.

## Rules I am following

No tag, publish, `v1` move or deprecation (apart from Task 1's 0.3.0 deprecation, which waits for
your `npm login`). No changes in `_archive/`, `~/deploy` or any service. Files added by name, no
stash, reset, rebase or force-push. Push only to `fix/release-truth`; PR #4 is updated, not
merged. Synthetic data only.

## Final table

Filled in as each row lands.

| Task | Commit | Test | Status |
|---|---|---|---|
| 1.1 Baseline: tests, build, pack, smoke | none needed | 424 tests; pack = `dist/` (with `inspector/ui`), `rubrics/`, `locales/`, `README.md`; smoke on the tarball | Done |
| 1.2 A5 by name and by `<property name="requirement">`, real CLI to the gate | `1839041` | `junit-link.test.ts` 1–3 (mutation-checked: removing either path fails them) | Done |
| 1.3 A5 `--map` | `1839041` | `junit-link.test.ts` 4–7 | Done |
| 1.4 Action input safety | `7d43fe5` | `ci-input.test.ts` (hostile title as data; the example workflow never puts PR text in a `run:`) | Done |
| 1.5 Docs: status from git, changelog date, Node 22.13, npx first, honest opening | `b89aafa` | `docs.test.ts` | Done |
| CI, 3 OS × 4 Node (+ Node 20 / 22.12 refusal) | — | `196f5fb`: all jobs green | Done (re-checked at the end) |
| 2.1 Node older than 22.13: one sentence, exit 2 | `040f792` | `cli-node-version.test.ts`; CI `old-node` job on real Node 20 and 22.12 | Done |
| 2.2 `init`: npx MCP line, plain errors, next steps, no SQLite warning | `a4e4c4b` | `cli-init-demo.test.ts` (4 new) | Done |
| 2.3 `demo`: busy port, Ctrl-C cleanup, answers in 10 s | `26f21c6` | `demo-run.test.ts` | Done |
| 2.4 `<cmd> --help` for all 19; a typo exits 2 | `cc09bcf` | `cli-help.test.ts` | Done |
| 2.5 11 MCP tools against 0.4.0 | `196f5fb` | `mcp-tools.test.ts` (names pinned, descriptions, refusals) | Done |
| 3.1 D4/B3 one vocabulary | `ecd0ba4` | `words.test.ts` | Done |
| 3.3 D1 data, D5 "changed since" | `bc727ea` | `release-view.test.ts`, `release-api.test.ts` | Done |
| 3.5 Ship / Hold / Ship anyway rules | `558e064` | `release-api.test.ts`, `mcp-tools.test.ts` (override bug keys) | Done |
| 3.4 D1 page | `a8dfc21`, `0aa3470` | `release-page.test.ts`; real-browser run (below) | Done |
| 3.7 D2 demo with three releases | `0aa3470` | `demo-releases.test.ts`, `demo-run.test.ts`, smoke | Done |

Real-browser run (18 Nov, headless Chromium from QAAE's installed Playwright, a scratch script
not in this repo): 13 checks at 1280 and 375 px, all passed. It found two display faults, both
fixed in `0aa3470`. It is not part of CI, because Playwright is not a dependency of this repo.
