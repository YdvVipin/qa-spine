# qa-spine

An MCP server that exposes QA-lifecycle agents to any MCP-capable client, over a
**traceability spine**: every artifact is linked — requirement → findings → tests → run
results → release verdict — and every AI-produced artifact records which model and which
prompt version made it.

Self-hostable, and nothing leaves your machine: the server never calls a model itself, it
hands requirements and rubrics to the calling agent and validates what comes back. The
server proposes; it never mutates JIRA, repos or CI without an explicit approval call.

**Status: Phases 1 through 5 complete, plus test results from CI.** The trace spine, the Inspector, the ambiguity
audit, the queue for answering what it finds, and the release brief that refuses to ship over
an unanswered question.

## Requirements

Node >= 22.5 (uses the built-in `node:sqlite` — no native build step, no dependencies
beyond the MCP SDK and Zod).

## Quickstart

```bash
npx qa-spine demo     # see it working — writes only to a temp file
npx qa-spine init     # set up your project
```

`demo` seeds a worked example into a throwaway database, writes a release brief beside it, and
opens the Inspector on it. It never touches your own store: the ledger is append-only, so anything
seeded into it would be permanent.

`init` copies the ambiguity rubric into your project so your team owns and versions it, adds
`.qa-spine/` to `.gitignore`, and prints the line to register the MCP server with Claude Code.

The trace store is a SQLite file at `.qa-spine/trace.db`, overridable with `QA_SPINE_DB`. Rubrics
are read from the package unless you point `QA_SPINE_RUBRICS` at your own directory.

## Working on qa-spine itself

```bash
npm install
npm test
npm run build
```

## Tools

| Tool | What it does |
| --- | --- |
| `health` | Confirms the server is up; reports the store path and artifact count. |
| `trace_record` | Appends an artifact and its edges to existing artifacts, atomically. Refuses findings, answers and verdicts, which have their own gated tools. |
| `trace_query` | Given an artifact ID, returns the full upstream/downstream chain. Without an ID, lists recent artifacts. |
| `audit_requirement` | Returns a requirement plus the published ambiguity rubric, for the calling agent to reason over. Makes no model call. |
| `audit_submit` | Records ambiguity findings, rejecting any that cite an unknown rule or a quote absent from the requirement. An empty list records a clean audit. |
| `audit_open` | Lists ambiguity questions still waiting on an answer, each with the requirement text needed to answer it. |
| `audit_answer` | Records an answer. The answer supersedes the finding, which retires it. |
| `assess_release_risk` | Given the areas a release touches, returns every unresolved requirement-stage finding and every failing covering test on them, plus surrounding artifacts as unscored evidence. Makes no model call. |
| `fixtures_request` | Returns a locale pack (phone and postcode formats, currency) and instructions for generating test data. Makes no model call. |
| `fixtures_submit` | Records generated test data for a test case or requirement, after validating every record against a JSON Schema and the locale. One bad record rejects the batch. |
| `release_submit` | Records a release verdict. Recomputes the signals itself from `changed` rather than trusting the caller's, and refuses a `ship` while one is live unless given an explicit `override` reason. |

## The Inspector

```bash
npx qa-spine demo            # one complete spine to look at, in a throwaway store
```

The Inspector is an **instrument for judging whether agent output is any good**, not a
product dashboard. It is read-only, loopback-only, has no auth and no build step: one HTML
file, one CSS file, one vanilla-JS module. Four views:

- **Artifact list** — everything in the store, newest first, filterable by type, showing
  producer, model and confidence at a glance.
- **Artifact detail** — for a finding, the quoted text highlighted *inside the original
  requirement*, so a mis-quote or a hallucinated quote is obvious immediately. Full
  provenance alongside.
- **Chain view** — requirement → findings → tests → runs → verdict, laid out left to right,
  edges coloured by relation. Findings that nothing has resolved render red.
- **Audit queue** — every question phase 2 raised that nobody has answered, with the quote
  shown in context and a box to answer it. Answering appends an `answer` that supersedes the
  finding, so the chain view stops showing it red. The empty state is the goal.

Every AI artifact gets a 👍/👎 and a free-text note. The Inspector has two human-authored
writes: this review, and audit answers. Agents answer through `audit_answer` instead,
recording their provenance. Export the accumulated labels:

```bash
node dist/server.js review-export > labels.jsonl
```

Each line carries the verdict, the note, and the artifact that was judged together with the
model and prompt version that produced it. That is what makes a rubric edit measurable
rather than a matter of taste — without it there is no way to know whether a prompt change
made the agents better or worse.

## The trace store

Artifacts are `requirement | finding | test_case | test_run | defect | verdict | review | answer | audit | fixture`. Edges are
`derived_from | tests | covers | verifies | contradicts | supersedes`, always directed from
the newer artifact to the older one.

The store is **append-only, enforced by SQLite triggers** rather than by application code,
so history survives someone opening the file with the `sqlite3` CLI. Nothing is ever
updated or deleted; to retract an artifact you append a replacement and link it with
`supersedes`. Both versions remain readable and the chain records that the change happened.

Triggers stop an edit, but not someone who drops the triggers first. So every artifact and
edge written through qa-spine is also **hash-chained**: `sha256(previous hash + the row as
stored)`. `qa-spine verify` recomputes the chain and exits 1 on a row changed after it was
recorded, a row deleted, or a row added straight into SQLite; 0 when intact; 2 when there is
no store. The GitHub Action runs it before the gate. Rows written by a qa-spine from before the
chain are counted as `legacy`, never as tampering, so upgrading cannot turn a build red.

The limit is stated rather than hidden: nothing anchors the chain outside the file, so someone
who understands it can rewrite a row and recompute every hash after it, or wipe the chain and
reset the file's `user_version` marker so the store passes for a pre-chain one. `verify` prints the
`head` hash so you can anchor it somewhere you already trust — a CI log, a release note. A
store committed to git is anchored by git.

Provenance is mandatory and validated on write: an artifact claiming `producer: "ai"` is
rejected unless it also carries `model` and `promptVersion`. An AI artifact that cannot say
what produced it is not traceable, which is the entire point of the spine.

## Rubrics

`rubrics/ambiguity.json` is published, versioned data — the thing a team argues about in
review rather than a prompt buried in the server. Its `version` is stamped onto every
finding as `promptVersion`, which is what makes "did that rubric edit help?" answerable
from the exported review labels instead of a matter of taste.

Point `QA_SPINE_RUBRICS` at your own directory to publish rubrics for your team.

### Is a rubric edit an improvement?

```bash
qa-spine rubric-report          # Markdown table; --json for the data
```

Per rubric version, model and rule: how many findings were raised, how many a person reviewed
in the Inspector, and what share of those they marked good. Clean audits are counted apart,
as the true negatives. Precision only: recall needs ambiguities the rubric missed, which
nothing records yet.

`rubrics/candidates/ambiguity-2.json` is the next rubric: every v1 rule unchanged, plus missing
failure behaviour, an unstated clock or time zone, unstated data rules, unstated permissions,
and contradictions between criteria. It is a candidate, not the default, because nobody has
labelled its output yet. To try it, copy it over the `ambiguity.json` in your rubrics
directory, audit, review in the Inspector, and compare the two versions in `rubric-report`.

The server never calls a model. `audit_requirement` hands the requirement and the rubric
to the calling agent; `audit_submit` takes what comes back and refuses anything that
cites an unknown rule, quotes text that is not in the requirement, or phrases `question`
in internal terminology rather than plain language (the same jargon lint `release_submit`
runs on `reason`, see [Release risk](#release-risk)). A hallucinated quote cannot enter
the store.

An agent can answer its own audit questions through `audit_answer`, and nothing prevents it.
Provenance is the safeguard rather than a lock: the queue shows the producer and model of
every answered question, and an AI-authored answer is drawn in the chain view in the colour
used for AI artifacts. If you need approval before an AI answer counts as resolving a
finding, the `approvedBy` field on every artifact's provenance is the place to build it.

The audit is also reachable from the command line, so a non-JavaScript caller can run it:

```bash
node dist/server.js audit-requirement requirement_9f8e            # → requirement + rubric + instructions
echo '{"requirementId":"…","findings":[…],"provenance":{…}}' \
  | node dist/server.js audit-submit                              # → {"recorded":[ids]}
```

Findings must arrive through `audit-submit` rather than `trace_record`. It rejects a finding
citing an unknown rule id, a quote that is not verbatim in the requirement, or a `question`
written in internal terminology instead of plain language — all-or-nothing — that check is
what stops a hallucinated quote entering the store, and writing findings any other
way bypasses it.

## Release risk

`assess_release_risk` takes the list of sourceRefs a release touches — JIRA keys, file paths —
and returns two kinds of blocking signal on the requirements among them: every unresolved
finding, and every covering test whose **latest** run failed or errored (see
[Test results](#test-results)). The artifacts around them come back as unscored evidence. It
makes no model call; the calling agent writes the brief.

Matching is exact `sourceRef` equality and changed-ness is never inferred transitively, so the
caller must pass both file paths and ticket keys. The alternative — walking edges to decide
what "changed" — lets one changed file mark every requirement in the store as changed. A ref
that matched nothing in the store comes back as `unmatched` rather than being dropped
silently; that is code that moved with no requirement covering it, and it is deliberately
non-blocking — nothing stops a ship over it, it is only ever reported.

`release_submit` records the verdict as `{ verdict, reason, changed, unmatched, override }`,
and it recomputes the signals from `changed` itself rather than trusting a list the caller
could hand it. That stops an agent from waving a `ship` through by keeping `changed` but
dropping a signal from its own copy of the result — but it does not stop the call from naming
fewer refs than the release actually touched. When the same MCP session assessed that release
earlier, `release_submit` compares the two lists and records anything it dropped as
`droppedFromAssessment`; the brief then says the decision covered fewer areas than were
assessed. That is recorded, not refused: splitting one release into two decisions is
legitimate. An assessment from another session, or with no `releaseRef`, is not compared.

`recordVerdict` also validates at the function boundary, not only in the MCP tool's Zod
schema: a blank `releaseRef`, a blank `reason`, a `verdict` that isn't exactly `ship` or
`hold`, a non-array `cites`, an unknown id in `cites`, and an `override` supplied alongside a
`hold` are all rejected before anything is written. That matters for any caller that reaches
`src/release.ts` directly, skipping the wire schema entirely.

A `ship` is rejected while a signal is live unless the call carries `override: { reason }`.
That override is recorded on the verdict only when it actually overrode something — a caller
that defensively sends `override` on every submission gets nothing recorded when no signal was
live — and when it is recorded, it carries not just the reason but the id of every finding
that was live at the time: the store holds the whole fact, not just half of it. Nothing
prevents an agent from writing its own override, exactly as nothing prevents it from answering
its own audit questions — this is visibility, not prevention. The Inspector is where that
visibility shows up: a verdict's row in the artifact list leads with `SHIP` or `HOLD`, prefixed
`⚠ OVERRIDDEN` when an override is present, and its detail view puts the override reason in a
callout that comes before the JSON content panel in the page — on a wide viewport the
responsive grid lays that callout out to the left rather than above, but it is still the first
panel a human's eye meets. An overridden ship is not buried in the record — it is the first
thing a human sees.

The raw write paths cannot go around this. `trace_record` and the CLI `record` refuse a
`finding`, an `answer` or a `verdict` — each names the gated tool to use instead — and refuse a
`supersedes` link onto a finding, which is how a question would otherwise be retired with no
answer. Code that imports `TraceStore` directly is not guarded; that is the same trust boundary
as opening the SQLite file, and the hash chain below is what catches it.

### AI answers that need a person's approval

By default an agent can answer its own audit questions, and the answer retires the question;
provenance makes that visible, not impossible. `--require-human-answers` on the gate (or
`QA_SPINE_REQUIRE_HUMAN_ANSWERS=1`, which `release_submit` also reads) changes that: an AI
answer retires a question only once a person approves it, with a 👍 in the Inspector or

```bash
qa-spine approve answer_52e8c0d4 --by a.rivera
```

Until then the question is open, and the gate prints that command next to it.

### Sharing a ledger

```bash
qa-spine merge ../teammate/.qa-spine/trace.db
```

brings in every artifact and edge the other store has and this one lacks, with their ids and
times, chained here. The other store must pass `verify`; an id both stores hold with different
content refuses the whole merge. Merging twice changes nothing, and the source is never written.

### Test data

The agent generates fixtures; qa-spine checks them, as it does findings.

```bash
qa-spine fixtures-request de-DE                 # the locale pack and the instructions
echo '{"schema":{…},"locale":"de-DE","fixtures":[…],"forId":"test_case_a41f09b2","provenance":{…}}' \
  | qa-spine fixtures-submit
```

Every record is validated against the caller's JSON Schema and the locale pack: a German
postcode is five digits, a UK one looks like `SW1A 1AA`. The schema support is a stated subset —
`type`, `properties`, `required`, `additionalProperties: false`, `items`, `enum`, `const`,
min/max, lengths, `pattern`, and the formats `email`, `date`, `date-time`, `uuid`, `phone`,
`postal-code`. **Any other keyword refuses the schema** rather than being skipped: a validator
that ignored `oneOf` would pass data that breaks it. Packs ship for `en-US`, `en-GB`, `de-DE` and
`en-IN` in `locales/`; point `QA_SPINE_LOCALES` at your own. The recorded `fixture` carries the
schema's digest and the pack's version as its `promptVersion`.

### Over MCP

Besides the tools, the server publishes the rubric as a resource
(`qa-spine://rubrics/ambiguity`) and an `audit-ticket` prompt that takes a ticket key, so a
client can offer both in its menus.

Real ticket text, instead of hand-written fixtures:

```bash
JIRA_SITE=yourteam.atlassian.net JIRA_EMAIL=you@example.com JIRA_TOKEN=... \
  node examples/import-jira.ts 'project = PROJ AND fixVersion = "2026.7.3"'
```

GitHub Issues and Linear work the same way:

```bash
GITHUB_TOKEN=... node examples/import-github.ts acme/shop requirement   # keys like #123
LINEAR_API_KEY=... node examples/import-linear.ts ENG                   # keys like ENG-123
```

GitHub keys are `#123`, so run the gate with `--ticket-pattern '#\d+'` to match "Fixes #123" in
commit messages. `GITHUB_API_URL` points the GitHub one at GitHub Enterprise. Every importer
versions rather than duplicates, so re-running one is safe.

These scripts are loaders in `examples/`, not features. Nothing in `src/` knows what Jira,
GitHub or Linear is, and the server still makes no network call of its own.

## The release brief

The Inspector is an instrument for judging agent output; it assumes you know what an
artifact and a relation are, and it is loopback-only, so a project manager cannot open
it at all. The brief is the other half: one command turns a recorded verdict into a
self-contained HTML page you can send them.

```bash
node dist/server.js brief verdict_a1b2c3d4 > release-brief.html
```

Inline CSS, no JavaScript, no external requests — it survives email, Confluence and
printing. It answers the questions a project head actually has: are we ready to ship,
what was unanswered, what does this touch, and who decided.

It renders a verdict that already exists and computes nothing, so **the brief cannot
disagree with the ledger, because it is the ledger.** It also renders the decision *as
recorded*: if a question cited by a hold has since been answered, the brief for that
release still shows it was open when the call was made, and the footer says so. A brief
is a record of a decision, not a live status page.

No artifact ids, relation names or internal field names appear in the body — the footer
carries the record id for anyone tracing back, and a test asserts the rest of the page
stays clean.

The page can only be as plain as the prose inside it, so `release_submit` rejects a
`reason` or an `override.reason` containing internal terminology — relation names, field
names, artifact ids — and asks for a rewrite. The list is deliberately narrow: ordinary
English that merely resembles jargon ("our finding was that…", "could not trace the root
cause") is accepted, because rejecting a legitimate sentence on a release-blocking call
is worse than letting one awkward word through.

## The CI gate

The check is only worth having if it runs without anyone remembering to run it.

```bash
npx qa-spine gate --since origin/main          # advisory: report and exit
npx qa-spine gate --since origin/main --record --release-ref v1.4.0
```

`--since` derives what the change touched from git: file paths from the diff, ticket keys
from the commit messages. `--changed` adds refs directly, for keys that live in a pull
request title rather than a commit. Neither needs a network or a token.

**The exit code is the product.** `0` nothing blocks, `1` an unanswered question is live,
`2` the gate could not tell. An empty store, an unknown git ref, and no refs at all are
all `2` — never a green check, because a gate that reports "all clear" when it actually
checked nothing is worse than no gate.

Advisory by default: it writes nothing, and that is what belongs on every push. `--record`
writes a verdict and belongs on a release event. The ledger is append-only, so a verdict
per push could never be removed, and a month of ordinary work would bury every real
release decision under thousands of machine-written ones.

`--record` records what it found, hold included — a release that did not go out because a
question was never answered is exactly the decision worth keeping, and the one a project
manager most needs the brief for.

**Shipping anyway needs a name.** `--override-reason` requires `--approved-by`, and the
verdict records both alongside the questions that were open at the time. The gate writes
its own reason only where the reason is a statement of fact, and says so plainly when
nothing in the record covered the change at all — a release where nothing matched is not
a clean release, and reporting it as one would manufacture confidence the ledger never
earned.

### Coverage and reports

A changed requirement that no test covers, in any of its versions, is **untested**. The gate
lists it and the brief names it; `--require-coverage` (Action input `require-coverage`) makes
it block, and only a test clears that.

```bash
qa-spine export --format csv  > matrix.csv     # one row per requirement, for a spreadsheet or an auditor
qa-spine export --format html > matrix.html    # the same, to send: no script, no external request
qa-spine export --format jsonl > ledger.jsonl  # every artifact and edge
```

`--changed PROJ-1,PROJ-2` limits the matrix to what a change touches. The Inspector's
**readiness** view is the same list, worst first: blocked (an open question or a failing
test), needs attention (edited since its audit, or untested), clear.

### Answering questions

A blocked gate says exactly how to unblock it. Each open question in its output comes with the
command that answers it:

```bash
qa-spine answer finding_7be04f12 "Retry three times over an hour, then alert." --by a.rivera
qa-spine answer finding_7be04f12 --accept-suggestion --by a.rivera
```

An audit may give each question a `suggestedAnswer`, a sensible default (plain-language lint
applies, as for the question). It can be accepted in one step from the command line or the
Inspector's audit queue. An answer that is the suggestion word for word is recorded as an
**assumption**, and the brief lists those separately: a decision someone accepted is not the
same as one someone thought through. `--by` is required on the command line.

There is no separate `status` command: `qa-spine gate --changed PROJ-42` without `--record`
writes nothing and prints the same summary.

### Edited requirements

Tickets change. Recording a requirement whose `sourceRef` already exists (through
`trace_record`, the CLI `record`, or the Jira importer) versions it instead of duplicating it:
the same content writes nothing, different content supersedes the current version. Re-running
an import is safe.

An edited requirement is **suspect** until it is audited again: its questions were answered
and its tests written against wording that changed. The gate lists suspect requirements on
the areas a change touches, the verdict records them, and the brief names them. It is a
warning by default. `--block-on-suspect` (Action input `block-on-suspect`) makes it block,
and only a re-audit clears it — an override is a person accepting a known risk, and a
requirement nobody has looked at since it changed is not known yet.

An audit that finds nothing is itself recorded: `audit_submit` with an empty `findings` list
writes one `audit` artifact, which is what clears a suspect requirement that is now clean.

### Test results

```bash
npx qa-spine ingest-junit reports/*.xml --run-ref "$CI_RUN_URL"
```

`ingest-junit` records JUnit XML — the format nearly every test runner can emit — as test cases
and runs. A test is tied to a requirement by a ticket key it carries: in its name, its class
name, or a `<property name="requirement" value="PROJ-42"/>` (what pytest's `record_property`
emits). A test with no key is still recorded; it simply cannot block anything. A key with no
matching requirement is reported as `uncovered`.

On the gate, a covering test whose **latest** run failed or errored blocks, exactly like an
unanswered question, and needs the same named override to ship over. A later passing run
clears it; nothing is superseded, the newer fact wins. Skipped does not block.

**Flaky tests are named, never excused.** A test that failed and passed on the same commit
(`--commit`, default `git rev-parse HEAD`), or twice in one report with different outcomes, is
labelled flaky in the gate output and the brief. It still blocks. Quarantining it
automatically would be the first thing in qa-spine to relax the gate without a person's name
on it.

Ingest is all-or-nothing: an unreadable file, malformed XML, or a report with no test cases
exits 2 and writes nothing. A report that reads as "no tests" is not a clean run.

### GitHub Actions

Copy [examples/github-workflow.yml](examples/github-workflow.yml) into
`.github/workflows/`:

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }        # --since needs history
- uses: YdvVipin/qa-spine@v1
  with:
    db: .qa-spine/trace.db
    since: ${{ github.event.pull_request.base.sha }}
    comment: 'true'
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

The token is used by `gh` to post the comment and never reaches qa-spine, which
authenticates to nothing. Everything the action does beyond that is a shell call to the
same CLI, so any other CI system is a few lines of its own YAML rather than a port.

**The store is yours to provide.** Commit it, restore it from a cache, or fetch it before
the step runs — but it has to be there. The action fails the job when it is missing or
empty rather than reporting a clean release.

## Roadmap

- **Phase 1 — trace spine.** Done.
- **Phase 1.5 — Inspector.** Done.
- **Phase 2 — `audit_requirement`.** Ambiguity audit against a published JSON rubric.
  Emits questions for a human, never rewritten requirements. Done.
- **Phase 2.5 — audit queue.** An Inspector view and two MCP tools for answering those
  questions, where an answer supersedes the finding it resolves. Done.
- **Phase 3 — `assess_release_risk`.** One-page release brief with a verdict, surfacing a
  requirement-stage finding that was never resolved and touches a changed area. Done.
- **Phase 5 — packaging.** `npx qa-spine`, `init`, `demo`, published rubrics. Done.
- **Phase 4 — delivery integration.** `qa-spine gate` and a GitHub Action, so the check
  runs on every change instead of when somebody remembers. Done.
- **Test results from CI.** `ingest-junit`, and a failing test on a changed area blocks the
  gate, with flaky tests labelled. Done.
- **Ledger integrity.** Hash chain and `qa-spine verify`; raw writes can no longer record
  gated types or retire a question; a narrowed release list is recorded. Done.
- **Requirement versions.** Edited requirements supersede instead of duplicating, are
  flagged suspect until re-audited, and a clean audit is recorded. Done.
- **Faster answers.** Suggested answers, `qa-spine answer`, and a gate summary that prints the
  commands that unblock it. Done.
- **Rubric measurement.** `qa-spine rubric-report`, and an `ambiguity/2` candidate rubric. Done.
- **Coverage and reports.** Untested requirements, `--require-coverage`, `export`, and the
  Inspector's readiness view. Done.
- **Team features.** `merge`, GitHub and Linear importers, the rubric and an audit prompt
  over MCP, and optional human approval of AI answers. Done.
- **Test data.** `fixtures_request` / `fixtures_submit`: schema-validated fixtures with locale
  packs. Done. That completes [the enhancement roadmap](docs/superpowers/plans/2026-09-29-enhancement-roadmap.md).

## License

MIT
