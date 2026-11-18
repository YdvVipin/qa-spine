# qa-spine — project status

As of **18 Nov 2026**. A status document, not product documentation: see [README.md](README.md)
for what qa-spine does and how to run it. This file answers "what is built, what is tested, and
what is still open" in one place. Every fact below comes from git, npm or a command run that day.

## Where things stand

| | |
|---|---|
| Version in this branch | **0.4.0**, not yet published |
| Branch | `fix/release-truth`, draft pull request #4 into `main` |
| `main` | 0.3.0 (`6754f26`, tag `v0.3.0`) |
| npm | 0.1.0, 0.2.0 and 0.3.0; `latest` is 0.3.0. 0.3.0's GitHub Action could run shell commands from a pull request title, so it is being deprecated; 0.4.0 replaces it |
| Runtime | Node 22.13 or later (`engines`); working from source needs Node 22.18, for TypeScript without a flag |
| CI | `.github/workflows/ci.yml`: tests on Node 22.18 / 24 / 26, then one packed tarball smoke-tested on Linux, macOS and Windows under Node 22.13 / 22 / 24 / 26 |
| The remaining work | [docs/finish-plan-2026-11-18.md](docs/finish-plan-2026-11-18.md), with a task / commit / test / status table |
| For a release manager | the Release page: `npx qa-spine demo`, or the Inspector opened with `?release=<id>&changed=…` |

## What it is

qa-spine is an MCP server and CLI that keeps QA evidence in one append-only **traceability
spine**: `requirement → finding → test_case → test_run → verdict`, every AI-produced artifact
stamped with the model and prompt version that made it, and every decision with the name of the
person who made it.

Design stance that shows up everywhere in the code: **the server never calls a model**. It
hands data to the calling agent (a requirement and rubric, or the evidence for a release) and
validates what comes back. It never changes Jira, repositories or CI on its own: every write is
an explicit call.

## What 0.4.0 decides, and how

One evaluator (`decide()` in `src/release.ts`) gives every surface (the gate, both release MCP
tools, the Inspector, exports and the brief) the same answer:

| Decision | When | Gate exit |
|---|---|---|
| SHIP | the evidence shows it | 0 |
| HOLD | a known blocker: an unanswered question or a failing test | 1 |
| UNKNOWN | evidence is missing: no test, no result that counts, a skip, an unreadable status, nothing matching the change | 2 |
| OVERRIDDEN | a named person accepted the known blockers | 0 |

An override clears HOLD, never UNKNOWN. Test run statuses are checked when written (`completed`
is refused). A pass written by hand counts only with a person named in `approvedBy`.

## Surface

- **11 MCP tools**: `health`, `trace_record`, `trace_query`, `audit_requirement`, `audit_submit`,
  `audit_open`, `audit_answer`, `assess_release_risk`, `release_submit`, `fixtures_request`,
  `fixtures_submit`; one resource (the rubric) and one prompt (`audit-ticket`). RatifyQA and the
  agent-evals case study call these names, so they are never renamed.
- **19 CLI subcommands** (`qa-spine help`), including `gate`, `ingest-junit`, `verify`,
  `retract`, `export` and `inspect`.
- A composite **GitHub Action** (`action.yml`): verify, optionally ingest JUnit, then the gate.

## Repository layout (line counts from `wc -l`, 18 Nov)

```
src/
  server.ts         1026  MCP server and CLI entry point
  release.ts         796  the evaluator, release risk, verdicts, readiness
  trace/store.ts     697  append-only store: triggers, hash chain, verify, merge, versions
  inspector/ui/app.js 682 the Inspector (vanilla JS, no build step)
  release-view.ts    250  the Release page's data: one decision, three lists, Ship / Hold / Ship anyway
  inspector/ui/release.js 155 the Release page itself
  words.ts            54  one vocabulary: Ready to ship, Not ready, Can't tell yet, Shipped anyway
  cli.ts              44  the bin: checks Node before loading node:sqlite
  gate.ts            474  `qa-spine gate` and its summary
  audit.ts           367  ambiguity audit, answers, rubric report
  brief.ts           350  a verdict as one self-contained HTML page
  junit.ts           336  JUnit XML parser and `ingest-junit`
  inspector/server.ts 211 loopback-only HTTP server for the Inspector
  fixtures.ts        190  schema-validated test data, locale packs
  demo.ts            120  the worked example, in a throwaway store
  trace/schema.ts    113  Zod schemas for artifacts, edges, provenance
  export.ts           84  traceability matrix (csv, html), jsonl dump
  retract.ts          57  withdrawing a mistake by name
tests/               47 files (npm test: 530 tests, all passing on 18 Nov)
scripts/smoke-package.mjs   installs the packed tarball and runs the user journey against it
rubrics/, locales/          the published rubric and the fixture locale packs
examples/                   Jira, GitHub and Linear importers; the example workflow
```

Runtime dependencies are `@modelcontextprotocol/sdk` and `zod` only; the store uses Node's
built-in `node:sqlite`, so there is no native build step.

## Guarantees, and where they stop

- **Append-only, enforced by SQLite triggers**, not application code, so it holds even when
  someone opens the file with the `sqlite3` CLI. Mistakes are withdrawn with `retract`, by name,
  never deleted.
- **A hash chain** over every artifact and edge; `qa-spine verify` reports a break.
- **Provenance is mandatory**: `producer: "ai"` needs `model` and `promptVersion`.
- **`audit_submit` is all-or-nothing**, and the rubric's own version is stamped on findings.
- **Gated types cannot be written raw**: `trace_record` and `record` refuse `finding`, `answer`,
  `verdict`, `audit` and `fixture`, and a `supersedes` link onto a finding.
- **Where it stops.** A name in `approvedBy` or `--approved-by` is a claimed name, not an
  authenticated one. A person with shell access to the store can run the same CLI an agent can.
  The hash chain shows edits against itself; without an external anchor it cannot stop someone
  rebuilding the chain. README says each of these.

## Testing

- `npm test` (Node's test runner): 530 tests, all passing, on 18 Nov.
- `node scripts/smoke-package.mjs <tarball>`: install from the packed tarball into a folder
  whose path has spaces, then version, init, record, ingest, gate, verify, export, the MCP
  handshake and the Inspector.
- Standing rule, because this repo's most frequent bug is a test that passes either way: every
  guard is checked by breaking it on purpose and watching its test fail before it is trusted.

## Where to dig further

- `CHANGELOG.md`: every behaviour change, release by release.
- `docs/superpowers/specs/` and `docs/superpowers/plans/`: one dated spec and plan per feature.
- `docs/finish-plan-2026-11-18.md`: what is left for 0.4.0, in order, with its proofs.
