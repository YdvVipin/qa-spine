# Phase 2.5 — the audit queue

**Status:** design approved, not implemented
**Date:** 2026-07-28
**Depends on:** phase 2 (merged at `a85eb87`) — `answer` is already in `ArtifactType`, shipped and unused
**Visual brief (phase 2, contains the audit-queue mockup):** https://claude.ai/code/artifact/3a78ae05-6fde-470a-a883-d675b28a54b4

## What this phase does

Phase 2 records questions for humans. Nothing can answer them. This phase closes that loop:
a place to see every unanswered question, a way to answer it, and an answer that retires the
finding it resolves.

It also unblocks phase 3. `assess_release_risk` is specified as surfacing "a requirement-stage
finding that was never resolved" — a signal that is always on until resolution exists.

## Decisions

### Both an Inspector view and MCP tools

Answering is available in two places: the `#/audit` view for a human, and `audit_answer` for an
agent working in Claude Code. This is a deliberate widening of the Inspector's rule that its only
writes are human-authored — that rule still holds for the *Inspector*, but the MCP surface now
accepts agent answers too.

### An agent's answer resolves the finding immediately

Considered and rejected: requiring human approval before an AI answer counts as resolved, using
the `approvedBy` / `approvedAt` fields that already exist unused in `Provenance`.

The risk is real and named here so it is not forgotten: **an agent that ran the audit can answer
its own questions, and nothing blocks it.** The audit can self-certify.

The chosen mitigation is visibility, not prevention, consistent with how `trace_record` already
trusts caller-supplied provenance. Because provenance is the only safeguard, it must be
prominent rather than a field you go looking for:

- the audit queue's answered list shows producer and model on every answered item
- an `answer` artifact whose producer is `ai` renders in the chain view with the AI colour
  (`--ai`, already defined in `style.css` and already used for `producer-ai`), so a
  self-resolved finding is visible at a glance in the chain rather than only in a detail panel

If this turns out to be too permissive in practice, the upgrade path is the one rejected here:
gate resolution on `approvedBy`. Nothing in this design forecloses it.

### The answer artifact reuses `content.text`

```json
{
  "type": "answer",
  "sourceRef": "<the requirement's sourceRef>",
  "content": { "text": "p95 under 1.5s on 3G Fast, measured at first contentful paint" },
  "provenance": { "producer": "human" },
  "links": [
    { "to": "<findingId>",     "relation": "supersedes"   },
    { "to": "<requirementId>", "relation": "derived_from" }
  ]
}
```

`content.text`, not `content.answer`. `summarise()` in `app.js` checks `c.text` first, so answers
render correctly in the artifact list with no Inspector change — the same trick that let phase 2
findings render for free.

The `supersedes` edge is what retires the finding. The chain view already marks a finding
unresolved when nothing supersedes it, so resolution needs no new concept and no change to that
logic.

### Answering an already-resolved finding is rejected

To revise an answer you supersede the *answer*, not stack a second one on the finding. This keeps
"resolved" a yes/no question rather than a count, and keeps the queue honest.

## Scope

**In:**
- `store.openFindings(limit?)` — findings with no incoming `supersedes` edge
- `store.edgesTo(id)` — incoming edges, the mirror of the existing `edgesFrom`
- `openQuestions()` and `recordAnswer()` in `src/audit.ts`, with `audit_open` and
  `audit_answer` as thin MCP wrappers over them — the structure phase 2 established, so
  the tests exercise plain functions rather than the protocol
- `GET /api/open` and `POST /api/answer` on the Inspector
- The `#/audit` view, plus the AI-answered treatment in the chain view
- Tests for all of the above

**Out:**
- Approval gating of AI answers (named above as the upgrade path)
- Editing or deleting answers — the store is append-only; supersede instead
- Any change to phase 2's audit tools
- Phase 3

## Components

### `store.openFindings(limit = 500): Artifact[]`

```sql
SELECT * FROM artifacts a
WHERE a.type = 'finding'
  AND NOT EXISTS (
    SELECT 1 FROM edges e WHERE e.to_id = a.id AND e.relation = 'supersedes'
  )
ORDER BY a.created_at DESC
LIMIT ?
```

Lives in `store.ts` beside `list()`, not in the audit module: "which findings are unresolved" is a
trace-level question about any finding, not an audit-specific one. Uses the existing `edges_to`
index. Doing this by listing every finding and filtering in JS would work at today's scale and be
wrong at any other.

### `store.edgesTo(id: string): Edge[]`

The mirror of the existing `edgesFrom`, same shape, `WHERE to_id = ?` against the `edges_to`
index. Needed because `recordAnswer` must not only know *whether* a finding is already resolved
but *by what*, so its rejection can name the answer to supersede. `edgesFrom` cannot answer that —
resolution edges point at the finding, not away from it.

### `openQuestions(store, requirementId?)` → `audit_open` (MCP)

Input: `{ requirementId?: string }` — omit to get everything.

Returns, for each open finding, enough to answer it without a second call:

```json
{ "open": [
  { "findingId": "finding_1a2b3c4d",
    "category": "AMB-VAGUE-QUANT",
    "quote": "load quickly",
    "question": "What p95 load time counts as 'quickly', and on what connection?",
    "confidence": "high",
    "requirement": { "id": "requirement_9f8e", "sourceRef": "PROJ-114", "text": "…" } }
] }
```

A finding whose parent requirement cannot be found still appears, with `requirement: null` — the
queue must not hide work because an edge is missing.

### `recordAnswer(store, input)` → `audit_answer` (MCP)

Input: `{ findingId: string, answer: string, provenance: ProvenanceInput }`

Validation, in order, each rejecting with a message naming the offending value:

1. `findingId` exists — else `no artifact with id X`
2. it is a `finding` — else `artifact X is a requirement, not a finding`
3. `answer` is non-blank after trimming — else `answer must not be blank`
4. the finding is not already resolved — else
   `finding X is already resolved by Y — supersede that answer instead of adding another`

Then resolve the requirement by walking `edgesFrom(findingId)` for a `derived_from` edge whose
target is a `requirement`, and record the answer with both edges. If no requirement is found,
record with the `supersedes` edge only — a finding is still answerable without a parent.

Unlike `audit_submit`, `promptVersion` is **not** overridden here. The server authors
`promptVersion` when it owns the rubric that produced the artifact; it does not own an answer.
Whatever the caller supplies stands, subject to the existing `Provenance` refinement that AI
artifacts must carry `model` and `promptVersion`.

### Inspector endpoints

Both mirror the existing `/api/review` handler in `src/inspector/server.ts` exactly — same
`send()` helper, same status codes, same shape.

- `GET /api/open` → the same payload as `audit_open` with no filter
- `POST /api/answer` with `{ findingId, answer }` → records with `provenance: { producer: 'human' }`,
  hardcoded. The Inspector never claims AI provenance; an agent that wants to answer uses the MCP
  tool, where its provenance is its own.

### The `#/audit` view

A fourth route in `app.js`, alongside `listView`, `detailView` and `chainView`. All UI files stay
where they are — the static handler rejects any path containing `/`, so there is no room for new
files even if they were wanted.

- Filter pills: open / answered / all, and a per-requirement count
- Each open item: rule id, confidence, sourceRef, the quote highlighted inside its requirement
  text, the question, an answer box, and a record button
- Each answered item: the answer, when, and **who** — producer and model, so an AI-answered
  question reads as AI-answered without opening it
- Empty state is the goal state: "Nothing to answer."

Recording an answer re-renders the queue; the answered item moves out of the open list.

### Chain view change

One change, in the node-building code: an `answer` node whose `provenance.producer` is `ai` gets
a class that colours its left border with `--ai`. Human answers keep the default. This is the
visibility half of the decision above, and it is three lines.

## Error handling

Every rejection returns the existing shapes — `fail()` with `isError: true` for MCP tools, and
`send(4xx, { error })` for the Inspector — and writes nothing. Messages name the specific value,
because the MCP consumer is a model that must correct and retry.

## Testing

`node --test`, new file `tests/audit-queue.test.ts`, using `new TraceStore(':memory:')` as every
existing test file does. Inspector endpoints tested with the `serve()` helper already in
`tests/inspector.test.ts`.

1. `openFindings()` returns a finding with no `supersedes` edge
2. `openFindings()` excludes a finding once something supersedes it
3. `openFindings()` ignores non-finding artifacts entirely, and is not confused by a
   `reviews` or `derived_from` edge pointing at a finding — only `supersedes` resolves
4. `edgesTo()` returns incoming edges and, unlike `edgesFrom`, finds the resolving answer
5. `openQuestions()` includes the parent requirement's text and sourceRef
6. `openQuestions(requirementId)` excludes other requirements' findings
7. `openQuestions()` returns `requirement: null` for a finding with no parent, rather than dropping it
8. `recordAnswer()` records an answer with both edges, and the finding leaves the open list
9. `recordAnswer()` rejects a blank and a whitespace-only answer, and writes nothing
10. `recordAnswer()` rejects a findingId that is not a finding, and writes nothing
11. `recordAnswer()` rejects answering an already-resolved finding, naming the resolving answer, and writes nothing
12. `recordAnswer()` records AI provenance intact — `model` preserved, `promptVersion` NOT overridden
13. `POST /api/answer` records with `producer: 'human'` even if the body tries to claim otherwise
14. `GET /api/open` returns the open list and shrinks by one after an answer is posted
15. an answered finding reads as resolved through `chain()` — the chain view's
    "nothing supersedes it" test becomes false for that finding

Tests 9–11 assert store contents are unchanged, not merely that an error was returned.

## Known ceilings

To be marked with `ponytail:` comments at the relevant lines:

- **`openFindings` has no pagination beyond `limit`.** Fine for a queue a human works down. If a
  store ever holds more open findings than that, the queue needs real paging, not a bigger limit.
- **The queue lists open findings across every requirement with no grouping or sort beyond
  recency.** Grouping by requirement is the obvious upgrade if the list gets long.
- **An AI answer resolves without approval** — restated here from the Decisions section because
  it is the ceiling most likely to need revisiting. Upgrade: gate on `approvedBy`.
