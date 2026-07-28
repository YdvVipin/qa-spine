# qa-spine

An MCP server that exposes QA-lifecycle agents to any MCP-capable client, over a
**traceability spine**: every artifact is linked — requirement → findings → tests → run
results → release verdict — and every AI-produced artifact records which model and which
prompt version made it.

Self-hostable. Nothing leaves your machine except calls to your own configured LLM endpoint.
The server proposes; it never mutates JIRA, repos or CI without an explicit approval call.

**Status: Phases 1 and 1.5 complete.** The trace spine and the Inspector work. The agents
that write into them do not exist yet.

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

## The Inspector

```bash
node examples/seed-demo.ts   # one complete spine to look at
npm run inspect              # → http://127.0.0.1:4700
```

The Inspector is an **instrument for judging whether agent output is any good**, not a
product dashboard. It is read-only, loopback-only, has no auth and no build step: one HTML
file, one CSS file, one vanilla-JS module. Three views:

- **Artifact list** — everything in the store, newest first, filterable by type, showing
  producer, model and confidence at a glance.
- **Artifact detail** — for a finding, the quoted text highlighted *inside the original
  requirement*, so a mis-quote or a hallucinated quote is obvious immediately. Full
  provenance alongside.
- **Chain view** — requirement → findings → tests → runs → verdict, laid out left to right,
  edges coloured by relation. Findings that nothing has resolved render red.

Every AI artifact gets a 👍/👎 and a free-text note. That review is the Inspector's only
write, and it is human-authored. Export the accumulated labels:

```bash
node dist/server.js review-export > labels.jsonl
```

Each line carries the verdict, the note, and the artifact that was judged together with the
model and prompt version that produced it. That is what makes a rubric edit measurable
rather than a matter of taste — without it there is no way to know whether a prompt change
made the agents better or worse.

## The trace store

Artifacts are `requirement | finding | test_case | test_run | defect | verdict`. Edges are
`derived_from | tests | covers | verifies | contradicts | supersedes`, always directed from
the newer artifact to the older one.

The store is **append-only, enforced by SQLite triggers** rather than by application code,
so history survives someone opening the file with the `sqlite3` CLI. Nothing is ever
updated or deleted; to retract an artifact you append a replacement and link it with
`supersedes`. Both versions remain readable and the chain records that the change happened.

Provenance is mandatory and validated on write: an artifact claiming `producer: "ai"` is
rejected unless it also carries `model` and `promptVersion`. An AI artifact that cannot say
what produced it is not traceable, which is the entire point of the spine.

## Roadmap

- **Phase 1 — trace spine.** Done.
- **Phase 1.5 — Inspector.** Done.
- **Phase 2 — `audit_requirement`.** Ambiguity audit against a published YAML rubric.
  Emits questions for a human, never rewritten requirements.
- **Phase 3 — `assess_release_risk`.** One-page release brief with a verdict, which can
  surface a requirement-stage finding that was never resolved and touches a changed area.
- **Phase 4 — `generate_fixtures`.** Schema-validated test data with locale packs.
- **Phase 5 — packaging.** `npx qa-spine`, published rubrics, example project.

## License

MIT
