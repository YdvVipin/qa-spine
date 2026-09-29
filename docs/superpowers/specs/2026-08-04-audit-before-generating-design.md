# Audit before generating — closing the QAAE loop, part 1 of 2

**Status:** design approved, not implemented
**Date:** 2026-08-04
**Spans two repos:**
- `qa-spine` — `~/projects/qa-spine`, TypeScript, `main` at `15e12f2`
- `QAAutomationAIEnabler` (QAAE) — `~/projects/QAAutomationAIEnabler`, Python, `master` at `616349b`

**Part 2** — the release gate that makes these questions expensive to ignore — is a separate spec
and a separate implementation cycle. This one creates the questions; that one gives them teeth.

## What this does

QAAE turns a Jira ticket into tests. Since the spine integration, the ticket also lands in the
ledger as a `requirement`. But nothing reads it critically before tests are generated from it, so
an ambiguous requirement produces ambiguous tests and nobody notices until the tests disagree with
what someone meant.

qa-spine has an ambiguity audit — a published four-rule rubric, a tool that hands the rubric to a
caller, and a tool that validates what comes back. It has never run on a real ticket, because
nothing makes it run.

This connects them: every newly-planned ticket is audited automatically, the questions land in the
audit queue, and whoever triggered the run is told immediately.

## Decisions

### Advisory, not a gate

The plan is still generated and the questions are surfaced alongside it.

Consistent with how the rest of the product behaves — the spine proposes and never blocks without
an explicit call, and the release gate is a veto with a recorded override. It also survives
contact with reality: most Jira tickets are ambiguous, so a hard gate would block nearly every run
on day one and be switched off by week two, at which point the audit stops running at all.

Part 2 puts the gate at the release boundary instead, where holding is proportionate.

### Automatic, once per requirement

It fires inside `start_from_ticket` when the requirement is first recorded. It never fires on the
resume path.

That guard is correct on its own terms — a resumed job records no new requirement, so there is
nothing new to audit — and it also sidesteps `submitFindings`' documented ceiling that re-auditing
a requirement appends duplicate findings with no dedup.

Rejected: a separate `audit_ticket` tool the caller invokes. It only ever runs when someone
remembers, which is the situation today and the reason zero tickets have been audited.

### QAAE reasons; qa-spine hands over the rubric

The server never calls a model. `audit_requirement` returns the requirement, the rubric and the
instructions; the caller reasons; `audit_submit` validates what comes back.

QAAE already makes an LLM call at exactly this point — `RecordingPlanGenerator` runs inside
`start_from_ticket` — so this needs no new capability, only a second call.

**The audit runs on a cheap model.** `providers.py` already scopes models by purpose and already
uses a cheap one where the work is simple: `("anthropic", "plan")` is `claude-opus-4-8` while
`("anthropic", "fix")` is `claude-haiku-4-5`. The audit is constrained extraction — match a rule
from a fixed four-rule rubric, copy a quote verbatim, ask one question — not the open-ended
reasoning a Recording Plan needs.

What that saves, from `usage.py`'s own price table, per 1M tokens:

| provider | plan model | audit model | ratio |
| --- | --- | --- | --- |
| anthropic | `claude-opus-4-8` (15 / 75) | `claude-haiku-4-5` (1 / 5) | ~15× cheaper |
| openai | `gpt-5.2` (1.25 / 10) | `gpt-4o-mini` (0.15 / 0.60) | ~8-16× cheaper |
| xai | `grok-3` (3 / 15) | `grok-3` (3 / 15) | **no saving** |

So for anthropic and openai the second call adds single-digit percent rather than doubling the
cost. **For xai it genuinely doubles it**, because no cheaper xai model is configured anywhere in
this codebase — `("xai", "plan")` and `("xai", "fix")` are both `grok-3` today. An xai user who
wants the saving sets `AUDIT_MODEL` to something cheaper; the override key exists for exactly that.

All three audit models are already in the price table, so cost estimation works untouched. And
because `usage.py` already breaks down `by_purpose`, auditing appears as its own line in the cost
summary rather than hiding inside a total.

### It must reach the store through `audit_submit`, not `record`

`audit_submit` rejects a finding citing an unknown rule id, and rejects a quote that is not
verbatim in the requirement — all-or-nothing, so one bad finding discards the batch. That
validation is the anti-hallucination guarantee: a quote the model invented cannot enter the store.

Recording findings through the plain `record` subcommand would bypass all of it.

### Non-fatal, like everything else the client does

Every failure — spine unreachable, LLM down, an unparseable model response, findings rejected for
a bad quote — logs a warning and planning proceeds.

Note what the rejection case means in practice: a badly-behaved model produces silence rather than
an error. That is the correct trade — a hallucinated quote must not enter the store, and a quality
instrument that can stop the pipeline gets removed — but it is worth knowing that "no findings"
and "findings were rejected" look the same to the caller.

## Components

### `audit-requirement` and `audit-submit` subcommands (qa-spine)

Added to the existing switch in `src/server.ts`, mirroring `record`:

```bash
node dist/server.js audit-requirement requirement_9f8e   # prints JSON
echo '{"requirementId":"…","findings":[…],"provenance":{…}}' | node dist/server.js audit-submit
```

Both print one JSON object on stdout and exit 0; on any failure they print `{"error": "…"}` on
**stdout** and exit 1. This matches `record` and deliberately differs from `brief`: the caller
here is a program parsing one JSON object, whereas `brief`'s output is a document being redirected
to a file.

Thin wrappers over the existing `auditRequirement` and `submitFindings`. No new validation.

**`audit-submit` must validate provenance with `ProvenanceInput`, not `Provenance`.** The refined
`Provenance` requires an AI artifact to carry `promptVersion`, but `submitFindings` stamps that
itself from the rubric version — so applying the refinement at the CLI boundary would reject a
correct payload before the server could fill the field. The MCP `audit_submit` tool already uses
`ProvenanceInput` for the same reason.

### The `audit` purpose (QAAE)

`core/ai/providers.py` gains three entries in `_MODEL_DEFAULTS`:

| provider | model |
| --- | --- |
| anthropic | `claude-haiku-4-5` |
| openai | `gpt-4o-mini` |
| xai | `grok-3` |

and three in `_MODEL_OVERRIDE_KEYS`, following the established shape of a purpose-specific
variable falling back to the provider default: `("anthropic", "audit"): ("AUDIT_MODEL",
"ANTHROPIC_MODEL")`, and likewise for openai and xai.

All three are already in `usage.py`'s price table, so cost estimation works without touching it.
Note the xai row buys nothing today, for the reason given above — it is there so the purpose
resolves for every provider rather than throwing, and so `AUDIT_MODEL` has somewhere to land.

### `core/agents/ambiguity_auditor.py` (QAAE)

```python
def audit(requirement_text: str, rubric: dict, instructions: str) -> list[dict]
```

Builds a prompt from the instructions and the rubric, calls the model resolved for
`purpose="audit"`, parses the JSON response, and returns findings shaped
`{category, quote, question, confidence}`.

Returns `[]` on any failure and never raises. Records the call through `usage.record` so its cost
is visible, exactly as the other agents do.

### `spine_client.audit_requirement` and `spine_client.audit_submit` (QAAE)

```python
def audit_requirement(requirement_id: str, *, timeout: float = 15.0) -> dict | None
def audit_submit(requirement_id: str, findings: list[dict], provenance: dict,
                 *, timeout: float = 15.0) -> list[str] | None
```

Same subprocess pattern, the same gating on `QA_SPINE_DIR` and `QA_SPINE_DB`, and the same
contract: never raises, returns `None` on any failure.

### Instrumentation in `start_from_ticket`

The audit slots between recording the requirement and the existing `advance(...)`, so the
requirement id and the question count reach the job in **one** `advance` call rather than two:

```python
requirement_id = _spine_record(job, "requirement", …)

questions = []
if requirement_id:
    questions = _audit_requirement(job, requirement_id)

advance(
    job,
    JobStage.AWAITING_RECORDING,
    note="Recording plan ready — open the recorder and perform the steps",
    plan=plan_dict,
    spine_requirement_id=requirement_id,
    spine_open_questions=len(questions),
)
```

`_audit_requirement` is a small helper beside `_spine_record`: fetch the rubric, run the auditor,
submit the findings, return them. It returns `[]` and logs on any failure.

Placed after plan generation so a slow or failing audit costs nothing already earned.

### What the caller sees

```json
{
  "success": true,
  "open_questions": [
    { "category": "AMB-VAGUE-QUANT",
      "quote": "processed quickly",
      "question": "What measurable threshold makes this quick?" }
  ],
  "next_step": "Answer these with audit_answer, or list everything outstanding with audit_open.",
  "plan": { "…": "…" },
  "job": { "spine_open_questions": 3, "…": "…" }
}
```

`next_step` is there because a notification nobody can act on is noise. The count rides on the job
so the WorkItem view and anything downstream can show that this ticket was ambiguous long after
the terminal closed.

## Error handling

Every failure degrades to "not audited", logged at WARNING with the job id. Nothing changes a
job's stage, fails a job, or propagates to the caller. `open_questions` is `[]` and
`spine_open_questions` is `0` — a caller cannot distinguish "clean ticket" from "audit failed"
from the response alone, which is a real limitation named in the ceilings below.

## Testing

**qa-spine** — extend `tests/` for the two subcommands, temp DB where the subprocess needs a real
path:

1. `audit-requirement` prints the requirement, the rubric and the instructions
2. `audit-requirement` on an unknown id exits 1 with `{"error"}` on stdout
3. `audit-requirement` on a non-requirement artifact is rejected
4. `audit-submit` records findings and prints their ids
5. `audit-submit` rejects a finding citing an unknown rule id, and writes nothing
6. `audit-submit` rejects a quote that is not verbatim in the requirement, and writes nothing
7. `audit-submit` accepts a payload whose provenance has no `promptVersion`, and the recorded
   finding carries the rubric version — the `ProvenanceInput` decision, as an assertion
8. malformed JSON on stdin is rejected with a readable error, not a stack trace

**QAAE** — `tests/test_ambiguity_auditor.py` and additions to `tests/test_spine_instrumentation.py`:

9. the auditor returns parsed findings from a mocked model response
10. the auditor returns `[]` and does not raise on an unparseable response
11. the auditor returns `[]` and does not raise when the model call itself fails
12. `providers.model_for(provider, "audit")` returns the configured audit model for each of the
    three providers, and `AUDIT_MODEL` overrides it — the escape hatch an xai user needs
13. `spine_client.audit_requirement` returns the payload on success and `None` on failure
14. `spine_client.audit_submit` returns the recorded ids on success and `None` on failure
15. `start_from_ticket` audits a newly-recorded requirement and puts the questions in the response
16. `start_from_ticket` does **not** audit on the resume path
17. `start_from_ticket` does **not** audit when the spine is disabled
18. an audit failure does not prevent the plan being returned or the job advancing
19. `spine_open_questions` lands on the job

Tests 16-18 assert planning succeeded, not merely that no exception escaped.

## Scope

**In, qa-spine:** two subcommands, their tests, a README paragraph.

**In, QAAE:** the `audit` purpose, `ambiguity_auditor.py`, two client methods, the
`start_from_ticket` instrumentation, tests.

**Out:**
- Gating anything — that is part 2
- Writing to Jira
- Re-auditing, dedup, or auditing a requirement edited after planning
- Any change to the audit queue, the Inspector, or the rubric itself
- Auditing requirements that reached the spine by any route other than `start_from_ticket`

## Known ceilings

To be marked with `ponytail:` comments:

- **The auditor's prompt is invisible in the ledger.** `submitFindings` stamps `promptVersion` from
  the *rubric* version and refuses a caller-supplied one. So if QAAE's audit prompt changes while
  the rubric does not, every finding looks identical in `review-export` and the change is
  unmeasurable — the exact failure the provenance field exists to prevent, displaced one level.
  Upgrade: carry the auditor's prompt hash in `inputDigest`, or let the rubric version compose with
  a caller-supplied prompt version.
- **A requirement is audited once, ever.** Editing the Jira ticket after planning never re-audits,
  and the findings continue to describe the text as it was. Upgrade: re-audit when the ticket's
  text digest changes, which needs the dedup that `submitFindings` currently lacks.
- **"Clean" and "audit failed" are indistinguishable to the caller.** Both yield
  `open_questions: []`. Upgrade: an explicit `audited: true|false` field in the response.
- **One extra LLM call per newly-planned ticket.** Cheap on anthropic and openai, **full price on
  xai**, where no cheaper model is configured. Visible as its own line in the usage summary either
  way. Upgrade: configure a cheaper xai model, or set `AUDIT_MODEL`.
- **Findings reach the store only through `start_from_ticket`.** A requirement written by
  `trace_record` or by any other path is never audited, the same hole the release gate already
  documents for verdicts.
