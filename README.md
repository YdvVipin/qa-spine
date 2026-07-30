# qa-spine

An MCP server that exposes QA-lifecycle agents to any MCP-capable client, over a
**traceability spine**: every artifact is linked — requirement → findings → tests → run
results → release verdict — and every AI-produced artifact records which model and which
prompt version made it.

Self-hostable, and nothing leaves your machine: the server never calls a model itself, it
hands requirements and rubrics to the calling agent and validates what comes back. The
server proposes; it never mutates JIRA, repos or CI without an explicit approval call.

**Status: Phases 1, 1.5, 2, 2.5 and 3 complete.** The trace spine, the Inspector, the ambiguity
audit, the queue for answering what it finds, and the release brief that refuses to ship over
an unanswered question.

## Requirements

Node >= 22.5 (uses the built-in `node:sqlite` — no native build step, no dependencies
beyond the MCP SDK and Zod).

## Run it

```bash
npm install
npm test
npm run build
```

Register with Claude Code:

```bash
claude mcp add qa-spine -- node /path/to/qa-spine/dist/server.js
```

The trace store is a SQLite file at `.qa-spine/trace.db`, overridable with `QA_SPINE_DB`.

## Tools

| Tool | What it does |
| --- | --- |
| `health` | Confirms the server is up; reports the store path and artifact count. |
| `trace_record` | Appends an artifact and its edges to existing artifacts, atomically. |
| `trace_query` | Given an artifact ID, returns the full upstream/downstream chain. Without an ID, lists recent artifacts. |
| `audit_requirement` | Returns a requirement plus the published ambiguity rubric, for the calling agent to reason over. Makes no model call. |
| `audit_submit` | Records ambiguity findings, rejecting any that cite an unknown rule or a quote absent from the requirement. |
| `audit_open` | Lists ambiguity questions still waiting on an answer, each with the requirement text needed to answer it. |
| `audit_answer` | Records an answer. The answer supersedes the finding, which retires it. |
| `assess_release_risk` | Given the areas a release touches, returns every unresolved requirement-stage finding on them, plus surrounding artifacts as unscored evidence. Makes no model call. |
| `release_submit` | Records a release verdict. Recomputes the signals itself from `changed` rather than trusting the caller's, and refuses a `ship` while one is live unless given an explicit `override` reason. |

## The Inspector

```bash
node examples/seed-demo.ts   # one complete spine to look at
npm run inspect              # → http://127.0.0.1:4700
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

Artifacts are `requirement | finding | test_case | test_run | defect | verdict | review | answer`. Edges are
`derived_from | tests | covers | verifies | contradicts | supersedes`, always directed from
the newer artifact to the older one.

The store is **append-only, enforced by SQLite triggers** rather than by application code,
so history survives someone opening the file with the `sqlite3` CLI. Nothing is ever
updated or deleted; to retract an artifact you append a replacement and link it with
`supersedes`. Both versions remain readable and the chain records that the change happened.

Provenance is mandatory and validated on write: an artifact claiming `producer: "ai"` is
rejected unless it also carries `model` and `promptVersion`. An AI artifact that cannot say
what produced it is not traceable, which is the entire point of the spine.

## Rubrics

`rubrics/ambiguity.json` is published, versioned data — the thing a team argues about in
review rather than a prompt buried in the server. Its `version` is stamped onto every
finding as `promptVersion`, which is what makes "did that rubric edit help?" answerable
from the exported review labels instead of a matter of taste.

Point `QA_SPINE_RUBRICS` at your own directory to publish rubrics for your team.

The server never calls a model. `audit_requirement` hands the requirement and the rubric
to the calling agent; `audit_submit` takes what comes back and refuses anything that
cites an unknown rule or quotes text that is not in the requirement. A hallucinated quote
cannot enter the store.

An agent can answer its own audit questions through `audit_answer`, and nothing prevents it.
Provenance is the safeguard rather than a lock: the queue shows the producer and model of
every answered question, and an AI-authored answer is drawn in the chain view in the colour
used for AI artifacts. If you need approval before an AI answer counts as resolving a
finding, the `approvedBy` field on every artifact's provenance is the place to build it.

## Release risk

`assess_release_risk` takes the list of sourceRefs a release touches — JIRA keys, file paths —
and returns every unresolved finding on the requirements among them, together with the
artifacts around them as unscored evidence. It makes no model call; the calling agent writes
the brief.

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
fewer refs than the release actually touched. Nothing cross-checks `changed` at
`release_submit` against the `changed` an earlier `assess_release_risk` call saw, so an agent
that quietly narrows the list before submitting can ship clean. What recomputation actually
buys is a paper trail, not a lock: the `changed` list a verdict was recorded against is part of
the verdict, so a narrowed list is visible after the fact even though nothing rejected it up
front.

`recordVerdict` also validates at the function boundary, not only in the MCP tool's Zod
schema: a blank `releaseRef`, a blank `reason`, a `verdict` that isn't exactly `ship` or
`hold`, an unknown id in `cites`, and an `override` supplied alongside a `hold` are all
rejected before anything is written. That matters for any caller that reaches `src/release.ts`
directly, skipping the wire schema entirely.

A `ship` is rejected while a signal is live unless the call carries `override: { reason }`,
which is recorded on the verdict rather than silently accepted. Nothing prevents an agent from
writing its own override, exactly as nothing prevents it from answering its own audit
questions — this is visibility, not prevention. The Inspector is where that visibility shows
up: a verdict's row in the artifact list leads with `SHIP` or `HOLD`, prefixed
`⚠ OVERRIDDEN` when an override is present, and its detail view puts the override reason in a
callout above the JSON content panel. An overridden ship is not buried in the record — it is
the first thing a human sees.

Real ticket text, instead of hand-written fixtures:

```bash
JIRA_SITE=yourteam.atlassian.net JIRA_EMAIL=you@example.com JIRA_TOKEN=... \
  node examples/import-jira.ts 'project = PROJ AND fixVersion = "2026.7.3"'
```

That script is a loader in `examples/`, not a feature. Nothing in `src/` knows what Jira is,
and the server still makes no network call of its own.

## Roadmap

- **Phase 1 — trace spine.** Done.
- **Phase 1.5 — Inspector.** Done.
- **Phase 2 — `audit_requirement`.** Ambiguity audit against a published JSON rubric.
  Emits questions for a human, never rewritten requirements. Done.
- **Phase 2.5 — audit queue.** An Inspector view and two MCP tools for answering those
  questions, where an answer supersedes the finding it resolves. Done.
- **Phase 3 — `assess_release_risk`.** One-page release brief with a verdict, surfacing a
  requirement-stage finding that was never resolved and touches a changed area. Done.
- **Phase 4 — `generate_fixtures`.** Schema-validated test data with locale packs.
- **Phase 5 — packaging.** `npx qa-spine`, published rubrics, example project.

## License

MIT
