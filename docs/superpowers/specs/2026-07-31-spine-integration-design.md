# Spine integration — recording QAAutomationAIEnabler's Loop A

**Status:** design approved, not implemented
**Date:** 2026-07-31
**Spans two repos:**
- `qa-spine` (this one) — `~/projects/qa-spine`, TypeScript, at `f93ac98`
- `QAAutomationAIEnabler` (QAAE) — `~/projects/QAAutomationAIEnabler`, Python, at `72f1579`

This spec lives in qa-spine because that is the session's working repo. The larger share of the
work lands in QAAE; a pointer to this file goes in QAAE's `docs/superpowers/specs/` during
implementation.

**Diagrams:** https://claude.ai/code/artifact/e4202e78-f557-468c-aac7-2df09e8e04d9

## What this does

QAAE produces AI artifacts continuously and keeps almost none of them. `job_store` mutates in
place through `save_job` / `advance` / `fail_job`; a heal cycle overwrites the test file and
leaves a single mutable `heal_summary` string. Nothing anywhere records which model wrote what.

qa-spine is an append-only ledger with mandatory provenance and nothing to record.

This phase connects them in one direction only: **QAAE writes, the spine remembers.** No QAAE
behaviour changes. Nothing is gated, blocked, or rewritten.

## Decisions

### The write seam is a CLI subprocess

qa-spine grows a `record` subcommand beside the existing `inspect` and `review-export`. QAAE
shells out with a JSON payload on stdin and reads back the created artifact.

Rejected: **reimplementing the write contract in Python.** It is the fastest option and it
destroys the point — a second write path with its own opinion about what provenance is required
is precisely the integrity hole the spine exists to close. There stays exactly one implementation
of `record()`.

Rejected: **an MCP stdio client from Python.** `mcp==1.25.0` is already installed and QAAE already
uses client code in five files, so this was close. It loses on session lifecycle: FastAPI would
have to own a long-lived child process, decide what happens per worker, and recover when the
child dies mid-request. A subprocess per write has none of that and behaves identically from
FastAPI, a CLI script, a cron job, or a test.

Rejected: **an HTTP sidecar.** A second service to keep running, and qa-spine's only HTTP surface
is deliberately read-only and loopback-bound. Adding writes to it is a real change in posture for
no gain over the subprocess.

**Payload arrives on stdin, not argv.** Payloads carry test file contents and heal diffs. As
arguments they would be fragile to quote and would eventually exceed `ARG_MAX`.

### Recording is opt-in and can never break QA work

Two properties of the Python client, both non-negotiable:

- **Gated on `QA_SPINE_DIR`.** Unset means every call is a no-op returning `None`. QAAE stays
  runnable with no Node installed and no spine checkout.
- **Never raises.** Any failure — missing binary, non-zero exit, malformed response, timeout —
  is logged at WARNING and returns `None`.

A recording device that can break the pipeline it records is worse than no recording device. This
is the one place where swallowing an exception is correct.

### The module is `core/trace/`, not `core/spine/`

`core/workitem/aggregator.py` line 1 already calls itself "the spine's Phase 1 read model". That
WorkItem projection keeps the word inside QAAE. The new module is `core/trace/spine_client.py`,
so within any one package "spine" means one thing.

### Four write points, at the four `attach` seams

`loop_a.py` already funnels every result into four synchronous functions that each fetch a job and
call `advance(...)`. They map one-to-one onto the artifacts, so instrumentation is one appended
call per function with no control-flow change:

| Function | Line | Artifact |
| --- | --- | --- |
| `start_from_ticket` | 38 | `requirement` |
| `attach_bdd_result` | 182 | `test_case` (generated) |
| `attach_run_result` | 205 | `test_run` |
| `attach_heal_result` | 250 | `test_case` (healed) |

### The job carries the current artifact ids

To link a healed `test_case` with `supersedes`, the caller must know the id of the one it
replaces. `advance(job, stage, **extra)` already persists arbitrary keys onto the job, so the ids
ride there:

- `spine_requirement_id` — set once by `start_from_ticket`
- `spine_test_case_id` — the current head, replaced on every generate and every heal
- `spine_disabled` — set when a write fails, so one failure does not produce a chain with holes

Rejected: querying the store by `sourceRef` to find the newest unsuperseded `test_case`. It is a
round trip per write and it guesses; the job already has somewhere to put the answer.

### `producer` stays `'human' | 'ai'`

A Playwright run is neither, and recording thousands of automated runs as `human` is a small lie
repeated often. Accepted anyway: the distinction the product needs is *"did an AI make a claim
that needs review"*, and a run's status is a fact, not a claim. qa-spine's seed demo already
records test runs as `human`.

Adding `'tool'` would touch `schema.ts`, the `Provenance` refinement, `trace_record`'s wire
schema, and the Inspector's `producer-*` colour tokens, for a distinction nothing consumes yet.
Named here so the eventual reader knows it was a decision.

## Provenance

The three fields and where each comes from. This turned out cheaper than expected: QAAE already
knows the model at every call site, it just files it under cost accounting.

### `model`

`core/ai/providers.py` exposes `resolve(explicit=None, purpose="plan") -> {"provider", "model", …}`
and `model_for(provider, purpose)`. `core/ai/usage.py::record(provider, model, purpose, …)` already
captures provider and model per call for cost tracking — the pattern exists, it is simply not
attached to the artifact.

`ai_provenance` — not the call sites — reads `providers.resolve(purpose=…)["model"]`, with
`purpose="plan"` for generation and `purpose="fix"` for heals, matching `_MODEL_OVERRIDE_KEYS`.

It accepts an explicit `model` override, which the heal path passes: `heal_failure` already
returns the model it used as `model_used`, and a value captured at the call that produced the
artifact beats one resolved afterwards.

### `promptVersion`

`"sha256:" + sha256(template_text)[:12]`, where `template_text` is the prompt template the
producing agent used.

**Amended 2026-07-31, during implementation.** This originally read `[:6]`. Review found that
24 bits crosses a 50% collision probability at roughly 4,000 distinct prompt versions — two
different prompts silently sharing a `promptVersion` is exactly the under-sensitivity this
section calls dangerous below. Widened to 48 bits on the human partner's ruling. Note that
qa-spine's seed data still shows a 6-char example, which is demo data rather than a contract.

Hashing rather than hand-versioning is deliberate. QAAE has no prompt-versioning system and this
does not propose building one; a content hash changes exactly when the prompt changes, which is
the only property the measurement needs. qa-spine's seed data already uses `sha256:9f2a1c` in this
field, so the store expects the shape.

**Fallback where an agent does not expose its template:** hash the agent module's source file. It
is coarse — a comment edit changes the hash — but it errs in the safe direction. Over-sensitivity
produces a spurious version split; under-sensitivity would claim two different prompts were the
same, which would silently corrupt the comparison the field exists for.

### `inputDigest`

`"sha256:" + sha256(source_text)[:6]` — the ticket text for a requirement-derived artifact, the
failing test plus its error for a heal.

## Scope

**In, qa-spine:**
- `record` subcommand reading JSON from stdin
- Tests for it

**In, QAAE:**
- `core/trace/spine_client.py`
- Four instrumentation calls in `core/orchestration/loop_a.py`
- Provenance helpers reading `core/ai/providers.py`
- Tests for the client and the four call sites
- `docs/superpowers/specs/` pointer to this file

**Out:**
- The release gate (`report_to_jira` / Zephyr publish blocking on open findings)
- Running the ambiguity audit on Jira tickets
- Reconciling the WorkItem projection with the artifact graph — WorkItem is untouched
- Backfilling historical jobs
- Any change to `loop_b.py`, manual execution, or bug drafting
- Reading from the spine anywhere in QAAE

## Components

### `record` subcommand (qa-spine)

Added to the switch in `src/server.ts`. Reads all of stdin, parses as JSON, records, prints the
created artifact as JSON on stdout, exits 0. On any failure prints `{"error": "…"}` on stdout and
exits 1 — the caller reads one JSON object either way and never has to parse stderr.

Payload:

```json
{
  "type": "test_case",
  "sourceRef": "typescript_framework/tests/login.spec.ts",
  "content": { "name": "user logs in", "body": "…" },
  "provenance": { "producer": "ai", "model": "grok-4", "promptVersion": "sha256:9f2a1c" },
  "links": [{ "to": "requirement_9f8e", "relation": "covers" }]
}
```

Validation is entirely the existing `store.record()` — no new rules, so an AI artifact without
`model` and `promptVersion` is rejected here exactly as it is through MCP.

### `core/trace/spine_client.py` (QAAE)

```python
def record(
    type: str,
    *,
    source_ref: str | None = None,
    content: dict | None = None,
    provenance: dict | None = None,
    links: list[dict] | None = None,
    timeout: float = 15.0,
) -> str | None
```

Returns the new artifact id, or `None` when recording is disabled or the write failed.

- Resolves the binary as `Path(os.environ["QA_SPINE_DIR"]) / "dist" / "server.js"`. Missing env
  var, missing directory, or missing file → disabled, returns `None`, logs once at DEBUG.
- `subprocess.run([node, server, "record"], input=json.dumps(payload), capture_output=True,
  text=True, timeout=timeout)`.
- Non-zero exit, timeout, unparseable stdout, or a payload carrying `error` → WARNING, returns
  `None`.
- Never propagates an exception.

Plus two helpers in the same module:

```python
def ai_provenance(purpose: str, *, model: str | None = None,
                  template_text: str | None = None,
                  source_text: str | None = None) -> dict
def human_provenance() -> dict
```

`ai_provenance` uses `model` when given and otherwise reads it from
`core.ai.providers.resolve(purpose=…)`, hashes the template (or the producing module's source when
`template_text` is `None`), and hashes `source_text` for `inputDigest`.

### Instrumentation

All four are appended after the existing `advance(...)` and guarded so a `None` return degrades
without breaking the chain semantics.

**`start_from_ticket`** — after the job and plan exist:

```python
rid = spine.record(
    "requirement",
    source_ref=ticket_key,
    content={"text": ticket.get("description") or ticket.get("summary") or "",
             "summary": ticket.get("summary"), "issue_type": ticket.get("issue_type")},
    provenance=spine.human_provenance(),
)
```

`content.text` is the description, falling back to the summary. A ticket with neither is recorded
with an empty `text`; the spine accepts it, and `audit_requirement` would later reject it, which
is the correct signal rather than a silent skip.

The id is written onto the job via `advance(..., spine_requirement_id=rid)`.

**`attach_bdd_result`** — `test_case`, `sourceRef` = the feature path from `bdd_paths`, `content`
= `{scenario_name, paths}`, provenance from `ai_provenance(purpose="plan", …)`, linked
`covers` → `spine_requirement_id` when present. The returned id becomes `spine_test_case_id`.

**`attach_run_result`** — `test_run`, `sourceRef` = `run_id`, `content` = `{status, run_passed,
summary, failed}`, `provenance = human_provenance()`, linked `verifies` → `spine_test_case_id`.

Recorded on terminal statuses only. `status in ("running", "queued")` is a progress tick, not a
run result, and recording those would fill the ledger with rows that mean nothing.

**`attach_heal_result`** — on `heal.get("success")` only. A new `test_case` linked `supersedes` →
the current `spine_test_case_id` and `covers` → `spine_requirement_id`. The returned id replaces
`spine_test_case_id`.

A failed heal records nothing: it produced no new test.

The payload from `core/execution/failure_analyzer.py::heal_failure` is pinned:

```python
{"success": True, "verified": True,
 "changed_files": ["tests/login.locators.ts"],   # relative to the framework root
 "backup_files":  ["…"],
 "summary": "loginBtn: getByText(…) → getByTestId(…)",
 "diff": {...}, "element": "…", "strategy_used": "…",
 "model_used": "anthropic:claude-…"}              # PRESENT ONLY ON THE AI PATH
```

`content` takes `summary`, `changed_files`, `strategy_used` and `diff`.

**`sourceRef` stays the feature path, not `changed_files[0]`.** A heal edits the locators or
steps file, which is a different file from the generated BDD feature — but the artifact
represents *the test*, and a `supersedes` chain whose `sourceRef` changes between versions would
not read as one test's history. `heal_failure` itself calls the BDD artifact "the canonical
artifact"; the spec follows that. The file actually edited is recorded inside
`content.changed_files`, where it belongs.

### No heal path today is AI-produced

**Amended 2026-07-31, during implementation review.** This section originally described a
conditional — `ai_provenance` when `heal["model_used"]` is present, `human_provenance` otherwise
— on the theory that some heal path set `model_used`. Review (C2) found that no path does: the
two success paths `heal_failure` can actually take (Class 1, the verified locator swap; Class 2,
premature-wait removal) classify the failure by regex, verify candidates against the live page,
and apply the fix with no model involved anywhere. `model_used` is a field on `analyze_with_ai`
only, and `attach_heal_result` never routed that function's output into a heal record. The
conditional branch was dead code, and asserting `model_used` is "present only on the AI path"
described a path that does not exist.

Every heal recorded today is therefore unconditionally `human`:

```python
provenance = spine.human_provenance()
```

`content.strategy_used` says what actually did it (e.g. `"data-testid"`, `"wait-order"`). This
is the one place where the not-AI-means-`human` convention grates hardest: a verified locator
swap is neither human judgment nor a model call. It is recorded as `human` because the store's
enum has no third option, and a false `ai` stamp is worse than an imprecise `human` one.

If a genuine model-driven heal is ever wired in (e.g. routing `analyze_with_ai` into
`attach_heal_result`), give that path `spine.ai_provenance("fix", model=...)` explicitly — do not
resurrect a conditional keyed on a field nothing sets. A pinned test on `heal_failure`'s return
contract (`tests/test_spine_instrumentation.py` in QAAE) fails on purpose if `model_used` ever
appears there, so that change gets made deliberately instead of by accident.

### The `spine_disabled` guard

If any record in a job returns `None`, set `spine_disabled=True` on the job and skip subsequent
records for that job. A chain missing its middle is worse than no chain: a `test_run` verifying
nothing, or a heal superseding an artifact that was never written, would read as a real gap in
the history rather than as a recording failure.

## Error handling

Every failure mode degrades to "not recorded", logged at WARNING with the job id and artifact
type. No failure changes a job's stage, fails a job, or propagates to the caller. The
`spine_disabled` flag makes a partial chain impossible.

## The demo

An explicit deliverable, because the whole point is to look at the result.

`scripts/spine_demo.py` in QAAE drives one synthetic Loop A job end to end through the four
attach functions — no Jira, no browser, no LLM — using a fixed fake ticket, a fake generated
spec, a failing run, an AI heal carrying a `model_used`, and a passing run. It prints the
artifact ids it created.

Both env vars are required and they are not the same thing: `QA_SPINE_DIR` locates the Node
binary, `QA_SPINE_DB` locates the store. The demo writes to a throwaway DB so it never touches
`.qa-spine/trace.db`.

```bash
# in QAAutomationAIEnabler
QA_SPINE_DIR=../qa-spine QA_SPINE_DB=/tmp/demo-spine.db python scripts/spine_demo.py

# in qa-spine
QA_SPINE_DB=/tmp/demo-spine.db npm run inspect
```

The chain view shows `requirement → test_case v1 → test_run FAILED`, and `test_case v2`
superseding v1 with a passing run, with the AI artifacts in the AI colour. That is the
acceptance criterion a human can see.

## Testing

**qa-spine** — extend `tests/` for the `record` subcommand, `:memory:` where possible and a temp
file DB where the subprocess needs a real path:

1. a valid payload records the artifact and prints its id
2. an AI payload without `model` is rejected, exit 1, `{"error"}` on stdout
3. malformed JSON on stdin is rejected with a readable error, not a stack trace
4. a `links` entry pointing at a nonexistent artifact is rejected and writes nothing
5. exit code is 0 on success and 1 on every failure

**QAAE** — `tests/` alongside the existing suite:

6. `record()` returns `None` and runs nothing when `QA_SPINE_DIR` is unset
7. `record()` returns `None` and logs when the subprocess exits non-zero (mocked)
8. `record()` returns `None` on timeout (mocked)
9. `record()` parses and returns the artifact id on success (mocked)
10. `ai_provenance` produces `model`, `promptVersion` and `inputDigest`, and the same template
    hashes to the same value while a changed template does not
11. each of the four attach functions calls `record` with the expected type and links (mocked)
12. `attach_run_result` records nothing for `status="running"` or `"queued"`
13. `attach_heal_result` records nothing when the heal failed
14. `attach_heal_result` uses AI provenance with the payload's `model_used` when present, and
    `human` provenance when absent — the deterministic locator-swap path must not be recorded
    as AI
15. `attach_heal_result` keeps `sourceRef` on the feature path even though `changed_files` names
    the locators file, so the supersedes chain stays on one ref
16. once `spine_disabled` is set on a job, later attach calls record nothing
17. an end-to-end test against a real temp DB, skipped unless `QA_SPINE_DIR` is set, asserting the
    chain has the expected shape

Tests 6–16 mock the subprocess. Only test 17 shells out, and it skips rather than fails when the
spine is absent, so QAAE's suite stays green on a machine with no Node.

## Known ceilings

To be marked with `ponytail:` comments:

- **A subprocess per artifact.** Roughly four Node startups per job, ~100ms each. Irrelevant beside
  a heal cycle measured in minutes. If writes ever become hot, batch them or move to a persistent
  MCP session.
- **`model` is resolved at record time, not captured from the call that produced the artifact.**
  If configuration changes mid-job, the recorded model is wrong. The honest fix is for each agent
  to return the model it used; `usage.py::record_langchain` already extracts it from the response
  object and shows the way.
- **The module-source fallback for `promptVersion`** changes on any edit to the file, including
  comments, producing spurious version splits. Upgrade: have each agent expose its template.
- **`spine_disabled` is per job and never resets.** One transient failure stops recording for the
  rest of that job. Deliberate — a complete chain or none.
- **No reconciliation between the WorkItem projection and the artifact graph.** Two models of the
  same work now coexist. Fine while the ledger is write-only; revisit before anything in QAAE
  reads from the spine.
- **`content` stores paths and summaries, not file bodies.** A `test_case` records where the test
  lives and what changed, not the test source itself, so the ledger does not become a second copy
  of the repo. The cost is that reconstructing a superseded version needs git or the `.bak` file.
  `apply_locator_fix` keeps exactly one `.bak`, overwritten on the next heal — so today two heals
  deep, the intermediate version is genuinely unrecoverable. Upgrade: store the body, or a content
  hash plus a git ref.
