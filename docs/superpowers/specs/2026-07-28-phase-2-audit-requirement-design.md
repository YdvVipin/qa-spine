# Phase 2 — `audit_requirement`

**Status:** design approved, not implemented
**Date:** 2026-07-28
**Depends on:** phases 1 and 1.5 (trace spine, Inspector) — both complete
**Visual brief:** https://claude.ai/code/artifact/3a78ae05-6fde-470a-a883-d675b28a54b4

## What this phase does

Reads a requirement against a published rubric and records ambiguity findings, each one
carrying a question for a human. It never rewrites the requirement. The rubric — not the
model call — is the product: a versioned file a team argues about in review, whose version
is stamped on every finding so that "did that rubric edit help?" is answerable from the
exported review labels.

This is the first agent in the project. Phases 1 and 1.5 contain no model call anywhere.

## Decisions

### The model call runs on the client side of the boundary

**MCP sampling is not available.** The Claude Code MCP reference documents `roots/list`
(with version history), `elicitation` (with a dedicated hook), `list_changed` and
`claude/channel` — and contains zero occurrences of `sampling` or `createMessage`. The
SDK exposes `server.createMessage()`, so a sampling implementation would compile and then
fail at runtime against the intended client.

So the server cannot be the thing that calls a model. Two remaining shapes were considered:
the server calling its own configured LLM endpoint, or the server handing the rubric to the
calling agent and validating what comes back. The second was chosen.

The decisive point: **`trace_record` already accepts caller-supplied provenance**
(`src/server.ts`). "The agent self-reports its model" is the existing trust model of the
whole spine, not a new weakness introduced here. What the server can meaningfully enforce
is not *who* produced a finding but *whether the finding is well-formed against the rubric* —
and that it can do mechanically.

### Two tools with a validation gate

| Step | Actor | Call |
| --- | --- | --- |
| 1 | agent → server | `audit_requirement({ requirementId })` → `{ requirement, rubric }` |
| 2 | host's model | reasons over the pair, produces candidate findings |
| 3 | agent → server | `audit_submit({ requirementId, findings[] })` → validated, then written |
| 4 | server → store | `store.record(finding)` ×N, each `derived_from` the requirement |
| 5 | human | answers the question — **phase 2.5, out of scope here** |

### Rubric format is JSON, not YAML

The roadmap said YAML. Node has no built-in YAML parser, and the README's pitch is "no
dependencies beyond the MCP SDK and Zod". JSON keeps that claim literally true and is
validated with the Zod already present. The cost is accepted: no comments, and awkward
long strings.

Revisit by adding `js-yaml` if rubric authors find JSON too hostile to edit.

### The answer artifact gets its own type

`answer` is added to the `ArtifactType` enum. `schema.ts` already notes that types are
stored as TEXT and adding one needs no migration. Reusing `requirement` would have cost
zero lines but muddies what a requirement is.

### Scope is split

Phase 2 ships the rubric and both tools. The audit queue UI ships as **phase 2.5**,
mirroring how the Inspector shipped as 1.5. The tools can be exercised from Claude Code
before any view exists.

## Scope

**In:**
- `rubrics/ambiguity.json` — the first published rubric, version `ambiguity/1`
- `audit_requirement` tool — loads and returns requirement + rubric
- `audit_submit` tool — validates and records findings
- `answer` added to `ArtifactType`
- Tests for both tools, covering each rejection path

**Out:**
- The audit queue UI (phase 2.5 — designed in the visual brief, spec'd separately)
- Any Inspector change. Phase 2 findings render correctly today; see below.
- Rubrics other than ambiguity
- Deduplicating repeated audits of the same requirement (see Known ceilings)

## Components

### `rubrics/ambiguity.json`

```json
{
  "version": "ambiguity/1",
  "rules": [
    {
      "id": "AMB-VAGUE-QUANT",
      "name": "Unquantified adjective",
      "test": "A degree adjective with no measurable threshold.",
      "triggers": ["fast", "quick", "scalable", "robust", "intuitive", "seamless"],
      "ask": "What measurable threshold makes this {term}?"
    },
    {
      "id": "AMB-MISSING-ACTOR",
      "name": "Missing actor",
      "test": "Passive construction that omits who performs the action.",
      "ask": "Who performs this — which user role or which service?"
    },
    {
      "id": "AMB-OPEN-LIST",
      "name": "Open-ended enumeration",
      "triggers": ["etc", "and so on", "including but not limited to"],
      "ask": "List the remaining cases, or state the rule that generates them."
    },
    {
      "id": "AMB-UNTESTABLE",
      "name": "No observable outcome",
      "test": "No stated way to tell, from outside, whether this holds.",
      "ask": "What would you observe to confirm this shipped correctly?"
    }
  ]
}
```

`triggers` is optional and advisory — a hint to the model, not a regex the server runs.
`test` and `ask` are the substance. A rule needs `id`, `name` and `ask`; `test` and
`triggers` are optional.

Rubric location resolves relative to the package root so it works both from source and
from an installed `dist`. Overridable with `QA_SPINE_RUBRICS` for teams publishing their
own, consistent with how `QA_SPINE_DB` already works.

### `audit_requirement`

Input: `{ requirementId: string }`

Loads the artifact, rejects if it is missing or not of type `requirement`, and returns:

```json
{
  "requirement": { "id": "...", "sourceRef": "PROJ-114", "text": "..." },
  "rubric": { "version": "ambiguity/1", "rules": [ ... ] },
  "instructions": "For each rule that fires, return { rule, quote, question, confidence }. Quote must be copied verbatim from the requirement text."
}
```

No model call, no network, no write. This tool is a librarian.

### `audit_submit` — the gate

Input:

```
{
  requirementId: string,
  findings: Array<{
    category: string,      // rubric rule id; must exist in the loaded rubric
    quote: string,         // must appear verbatim in the requirement text
    question: string,      // the human-facing question
    confidence: 'high' | 'medium' | 'low' | 'unknown',
    severity?: 'high' | 'medium' | 'low'
  }>,
  provenance: ProvenanceInput   // AI provenance rules already enforced by the schema
}
```

**The field names follow the convention already in the codebase**, verified against
`examples/seed-demo.ts` and both test files, which agree on
`{ category, severity, quote, why, confidence }` with `confidence` as a *string*
(`'high'`, `'unknown'`) — not a number. A numeric confidence would render a lone decimal
in an Inspector column where every other row reads "high".

`category` carries the rubric rule id. The demo data's informal categories
(`vague_qualifier`) are exactly what the rubric formalises (`AMB-VAGUE-QUANT`); phase 2 is
the thing that gives that field a controlled vocabulary, so it reuses the key rather than
introducing a parallel `rule`.

`suggestedRewrite` appears in the demo data and is **deliberately absent here**. Phase 2
emits questions, never rewritten requirements. That is the phase's defining constraint,
and the schema is where it should be visible.

Validation, in order. **All findings are validated before any is written** — the submission
is all-or-nothing, so a partially-valid batch never leaves half a finding set in an
append-only store that cannot be cleaned up.

1. Requirement exists and is of type `requirement`; else reject.
2. Requirement has a non-empty `content.text`; else reject — there is nothing to quote against.
3. `findings` is non-empty; else reject.
4. For each finding: `category` exists as a rule id in the rubric. Reject naming the unknown id and listing valid ones.
5. For each finding: `requirement.content.text.includes(quote)` — reject naming the offending quote.
6. Only then, record all findings.

Each written finding is:

```json
{
  "type": "finding",
  "sourceRef": "<requirement's sourceRef>",
  "content": {
    "category": "AMB-VAGUE-QUANT",
    "quote": "load quickly",
    "question": "What p95 load time counts as 'quickly', and on what connection?",
    "confidence": "high"
  },
  "provenance": { "producer": "ai", "model": "...", "promptVersion": "ambiguity/1" },
  "links": [{ "to": "<requirementId>", "relation": "derived_from" }]
}
```

`promptVersion` is set by the server from the loaded rubric's `version`, not taken from the
caller. This is the one provenance field the server can honestly author, and it is the field
that makes rubric changes measurable.

### Why the quote check matters

The Inspector already computes this exact comparison at render time, in `sourcePanel`, to
draw "⚠ quote not found in source" (`src/inspector/ui/app.js`). Moving it to write time
changes its meaning: a hallucinated quote stops being something a reviewer notices later
and becomes something that cannot enter the store. One `indexOf`, no model, no cost.

### Schema change

One line: `answer` joins the `ArtifactType` enum. It is unused until phase 2.5 but belongs
with the type work rather than the UI work. No migration — types are TEXT.

## Why no Inspector change is needed

Traced against the existing code, with the finding shape above:

| Existing code | Behaviour with a phase 2 finding | Change |
| --- | --- | --- |
| `summarise()` | falls through `text ?? quote` → shows the quoted span | none |
| `sourcePanel()` | highlights `content.quote` inside the requirement | none |
| list view | renders the `content.confidence` column | none |
| chain view | draws it in the finding lane, red until superseded | none |
| `reviewBox()` | 👍/👎, exported by `review-export` | none |
| — | answering the question, retiring the finding | **phase 2.5** |

The finding shape was chosen to fit these, not the other way round.

## Error handling

Every rejection returns the existing `fail()` shape — `isError: true` with a message —
and writes nothing. Messages name the specific offending value, because the consumer is a
model that must correct and retry:

- `no artifact with id X`
- `artifact X is a finding, not a requirement`
- `requirement X has no content.text to audit`
- `unknown rule "AMB-TYPO" — rubric ambiguity/1 defines: AMB-VAGUE-QUANT, ...`
- `quote not found in requirement text: "..."`
- `rubric not found at <path>` / `rubric failed validation: <zod message>`

Rubric parse and validation failures surface at tool-call time rather than at server
startup, so a malformed rubric cannot stop the trace tools from working.

## Testing

`node --test`, matching the existing `tests/*.test.ts` layout. New file
`tests/audit.test.ts`, using `new TraceStore(':memory:')` as both existing test files do:

1. `audit_requirement` returns the rubric and requirement text for a valid id
2. `audit_requirement` rejects a non-requirement artifact
3. `audit_submit` writes N findings with `derived_from` edges, and they appear in the chain
4. `audit_submit` sets `promptVersion` from the rubric, ignoring any caller-supplied value
5. `audit_submit` rejects an unknown rule id, and **writes nothing**
6. `audit_submit` rejects a quote absent from the requirement text, and **writes nothing**
7. `audit_submit` rejects when one finding of several is invalid — all-or-nothing
8. `audit_submit` rejects AI provenance missing `model` (existing schema rule still holds)
9. the shipped `rubrics/ambiguity.json` parses and passes its own Zod schema

Tests 5–7 assert store contents are unchanged, not merely that an error was returned.

## Known ceilings

Deliberate simplifications, to be marked with `ponytail:` comments at the relevant lines:

- **Re-auditing a requirement appends duplicate findings.** The store is append-only and has
  no dedup. Acceptable while audits are human-triggered one at a time. Upgrade path: have
  `audit_submit` skip findings whose `(rule, quote)` already exists on that requirement.
- **The whole rubric is sent on every `audit_requirement` call.** Fine at four rules;
  revisit if rubrics grow past what is comfortable in a tool result.
- **`triggers` are advisory only.** The server does not verify that a finding citing
  `AMB-VAGUE-QUANT` actually contains one of its trigger words, because a rule can fire
  legitimately on a synonym.

## Phase 2.5 preview — the audit queue

Designed and mocked in the visual brief; spec'd separately once phase 2 lands. In short: a
fourth Inspector view at `#/audit` listing every unresolved finding with its rule,
highlighted quote and an answer box. Recording an answer appends an `answer` artifact with
two edges — `supersedes` → the finding and `derived_from` → the requirement.

The `supersedes` edge is what retires the finding: the chain view already marks a finding
unresolved when nothing supersedes it (`src/inspector/ui/app.js`), so resolution needs no
new concept and no change to that view. The write reuses the pattern the `/api/review`
endpoint already established.
