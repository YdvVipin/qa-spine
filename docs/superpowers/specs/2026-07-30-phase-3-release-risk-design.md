# Phase 3 — `assess_release_risk`

**Status:** design approved, not implemented
**Date:** 2026-07-30
**Depends on:** phase 2.5 (merged at `981e3bb`) — `openFindings()` and the `supersedes`
resolution rule are the blocking signal's entire mechanism. `verdict` is already in
`ArtifactType`, shipped and unused.

## What this phase does

The spine records that a question was asked at requirement stage and never answered. Nothing
uses that fact at the moment it matters — the moment somebody decides to ship.

This phase closes that loop: given the areas a release touches, surface every unresolved
requirement-stage finding on those areas, hand the surrounding evidence to the calling agent,
and refuse to record a `ship` verdict while a blocker is live unless the caller explicitly
overrides it on the record.

## Decisions

### The caller supplies what changed

`assess_release_risk` takes `changed: string[]` — sourceRefs the release touches. The agent
produces that list however it likes (`git diff --name-only`, a JIRA fixVersion query, a
hand-written list).

Considered and rejected: the server shelling out to `git`. It would need to sit in a repo,
know its cwd, and cope with shallow clones and detached HEADs — new failure modes in a server
whose selling point is that it makes no calls out and has no dependencies beyond the MCP SDK
and Zod. Also rejected: a `release` manifest artifact, which adds a type and a ceremony before
every assessment for no gain the `changed` list does not already provide.

### The agent writes the verdict; the server can veto a `ship`

The evidence is deterministic, but the brief is a judgement call, so the phase 2 split holds:
`assess_release_risk` is the librarian, `release_submit` is the bouncer.

The bouncer is stronger here than in `audit_submit`, and deliberately so. **`release_submit`
recomputes the blocking signals itself from `changed`; it never accepts a signal list from the
caller.** If the agent supplied its own signals, the veto would be bypassable by simply
omitting the blocker — which is exactly the failure this phase exists to prevent.

A `ship` verdict while a blocking signal is live is rejected unless the caller passes
`override: { reason }`. The override is recorded in the verdict's content, so "we shipped over
an open question, and here is who said that was fine" is a fact in the store rather than a
thing somebody remembers.

This is a departure from phase 2.5, where an AI answer resolves a finding with nothing
blocking it. The reasoning: an audit answer is reversible and cheap to re-litigate; a release
decision is neither.

### One signal, not four

Only `unresolved_finding_on_changed_area` is computed, and every signal blocks.

There is deliberately **no `blocking` field** on a signal. It would be `true` on every signal
this phase can emit — a field with one possible value, which is the kind of speculative
generality the rest of this codebase avoids. The veto rule is simply "any signal blocks a
`ship`". Add the field when a second, non-blocking signal kind actually exists; adding a
property to a JSON payload breaks no consumer.

Considered and cut: a scored failing-run signal, a missing-coverage warning, and an
unreviewed-AI-artifact warning. The first is still *visible* — a failing `test_run` reachable
from a changed requirement arrives in the `context` subgraph, and the agent is instructed to
report it — but the server does not score it and it does not gate the veto.

Consequence, named so it is not a surprise: the seed demo's hand-written hold verdict cites an
unresolved ambiguity **and** a failing test. Phase 3 blocks on the first and can only narrate
the second.

### Matching is exact `sourceRef` equality

A changed ref matches an artifact when `source_ref` equals it. The blocking signal considers
only matched artifacts of type `requirement`. The `context` subgraph is built from `chain()`
over *all* matched artifacts of any type.

No transitive inference of "changed". `chain()` walks both directions without bound, so
deriving changed-ness through edges would let one changed file mark every requirement in the
store as changed, and every release would block on everything.

The cost is real: `src/refund.ts` does not match a requirement whose ref is `PROJ-42`, so the
caller must pass both file paths and ticket keys. Accepted as honest and predictable.

### The brief lives in `content.reason`

```json
{
  "type": "verdict",
  "sourceRef": "release/2026.7.3",
  "content": {
    "verdict": "hold",
    "reason": "<the one-page brief>",
    "changed": ["PROJ-42", "src/refund.ts"],
    "override": null
  },
  "provenance": { "producer": "ai", "model": "…", "promptVersion": "…" },
  "links": [{ "to": "<each cited id>", "relation": "derived_from" }]
}
```

`reason`, not `brief`: `summarise()` in `app.js` checks `c.reason` before `c.verdict`, so the
verdict renders in the Inspector list with no UI change — the same trick that let phase 2
findings and phase 2.5 answers render for free. It also matches what `seed-demo.ts` already
writes.

`changed` is stored in content so the verdict is self-describing later: what the release
claimed to touch, not only what it concluded.

## Scope

**In:**
- `store.bySourceRef(refs)` — artifacts whose `source_ref` is in the given list
- `assessReleaseRisk()` and `recordVerdict()` in a new `src/release.ts`, with
  `assess_release_risk` and `release_submit` as thin MCP wrappers, matching the structure
  phases 2 and 2.5 established
- `examples/import-jira.ts` — a throwaway importer, outside `src/`
- Tests for all of the above

**Out:**
- Any change to `src/inspector/` — verdicts already render via `content.reason`
- The three cut signals
- Approval gating of the override (named below as the upgrade path)
- Phases 4 and 5

## Components

### `store.bySourceRef(refs: string[]): Artifact[]`

```sql
SELECT * FROM artifacts WHERE source_ref IN (?, ?, …)
```

Placeholders generated the way `chain()` already generates them. **Returns `[]` immediately
for an empty `refs` array** — `IN ()` is a SQLite syntax error, so the guard is load-bearing,
not defensive decoration.

Lives in `store.ts` beside `list()`: "which artifacts came from these sources" is a
trace-level question, not a release-specific one.

### `assessReleaseRisk(store, { changed, releaseRef? })` → `assess_release_risk` (MCP)

Input: `{ changed: string[] (min 1), releaseRef?: string }`

1. `matched = store.bySourceRef(changed)`
2. changed requirements = `matched.filter(a => a.type === 'requirement')`
3. for each, `store.openFindings(500, req.id)` → one signal object per finding
4. `context` = merged, deduped `store.chain(a.id)` over every matched artifact
5. `unmatched` = refs in `changed` that matched no artifact

```json
{
  "release": { "ref": "release/2026.7.3", "changed": ["PROJ-42", "src/refund.ts"] },
  "matched": { "requirements": ["requirement_9f8e"], "unmatched": ["src/refund.ts"] },
  "signals": [
    {
      "kind": "unresolved_finding_on_changed_area",
      "artifacts": ["finding_2b3c", "requirement_9f8e"],
      "detail": {
        "category": "AMB-UNTESTABLE",
        "quote": "notified appropriately",
        "question": "What happens when notification delivery fails?",
        "confidence": "unknown",
        "sourceRef": "PROJ-42"
      }
    }
  ],
  "context": { "nodes": ["…every artifact reachable from a matched one…"], "edges": ["…"] },
  "instructions": "…"
}
```

`unmatched` is reported rather than ignored: a changed ref matching nothing in the spine is a
traceability gap — code moved that no requirement covers — and the instructions tell the agent
to say so in the brief.

Instructions state: write a one-page brief; cite artifact ids for every claim; report failing
runs found in `context`; report unmatched refs; never invent an artifact id.

### `recordVerdict(store, input)` → `release_submit` (MCP)

Input:

```ts
{
  releaseRef: string,
  verdict: 'ship' | 'hold',
  reason: string,
  cites: string[],
  changed: string[],
  override?: { reason: string },
  provenance: ProvenanceInput
}
```

Validation, in order, each rejecting with a message naming the offending value and writing
nothing:

1. `reason` non-blank after trimming — else `reason must not be blank`
2. every id in `cites` exists — else `cites unknown artifact X`
3. `override` given with `verdict: 'hold'` — else `override is only meaningful with a ship verdict`
4. recompute blocking signals from `changed`; if any is live and `verdict === 'ship'` and no
   `override.reason` — else
   `cannot ship: N unresolved finding(s) on changed areas: finding_2b3c (PROJ-42) — answer them or pass override`

Then record the verdict artifact shown above, with a `derived_from` edge to each cited
artifact.

`promptVersion` is **not** overridden. The server owns no rubric here, so caller provenance
stands, subject to the existing refinement that AI artifacts carry `model` and
`promptVersion`. Same reasoning as `recordAnswer`.

### `examples/import-jira.ts`

Reads `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_TOKEN` from the environment and a JQL string from
`argv[2]`. For each issue, records a `requirement` with `sourceRef: issue.key`,
`content: { text: description }`, `provenance: { producer: 'human' }`. Issues with an empty
description are skipped and counted — `audit_requirement` rejects blank text anyway.

Uses **`/rest/api/2/`**, not v3: v3 returns `description` as Atlassian Document Format JSON,
which would feed structural noise to the ambiguity rubric. v2 returns a plain string.

Open at implementation time: Atlassian has been migrating `/search` to `/search/jql`, so the
exact endpoint may need adjusting on first run against a live tenant. Contained to one line of
a throwaway script.

Credentials are read from the environment only. Nothing in `src/` gains knowledge of Jira, and
no credential is written to disk by this repo.

## Error handling

Every rejection uses the existing shapes — `fail()` with `isError: true` for MCP tools — and
writes nothing. Messages name the specific offending value, because the consumer is a model
that must correct and retry.

## Testing

`node --test`, new file `tests/release.test.ts`, using `new TraceStore(':memory:')` as every
existing test file does.

1. `bySourceRef()` returns matching artifacts and ignores refs matching nothing
2. `bySourceRef([])` returns `[]` without executing SQL
3. an unresolved finding on a changed requirement produces a blocking signal
4. a superseded finding on a changed requirement produces no signal
5. an unresolved finding on a requirement not in `changed` produces no signal
6. `unmatched` lists refs that matched no artifact
7. `context` contains a failing `test_run` reachable from a changed requirement
8. `recordVerdict()` records a hold with a `derived_from` edge to every cited artifact
9. `recordVerdict()` rejects a blank and whitespace-only `reason`
10. `recordVerdict()` rejects an unknown id in `cites`
11. `recordVerdict()` rejects `ship` while a blocking signal is live, naming the finding
12. `recordVerdict()` accepts `ship` with `override.reason` and records the override in content
13. `recordVerdict()` rejects `override` supplied with a `hold` verdict
14. `recordVerdict()` accepts `ship` when no blocking signal is live
15. `recordVerdict()` preserves AI provenance and does not override `promptVersion`
16. the seed-demo scenario: `changed: ['PROJ-42']` surfaces the unresolved notification finding

Tests 9–13 assert store contents are unchanged, not merely that an error was returned.

## Known ceilings

To be marked with `ponytail:` comments at the relevant lines:

- **Exact `sourceRef` matching only**, no prefix or glob. A changed file path does not reach
  its requirement unless the caller also passes the ticket key. Upgrade: prefix matching, or a
  published path→requirement map.
- **`changed` must be passed again to `release_submit`.** The server holds no assessment state
  between the two calls. This is what makes the veto unbypassable, so it is a deliberate cost
  rather than an oversight. Upgrade: persist the assessment as an artifact and cite it by id.
- **One `openFindings` query per changed requirement.** Fine for a release; batch into a single
  query if a release ever touches hundreds of requirements.
- **The override is unstructured free text** and is not gated on `approvedBy`. Anyone who can
  call the tool can ship over a blocker by supplying a reason. Visibility, not prevention —
  the same trade-off, and the same upgrade path, as an AI answer resolving a finding in
  phase 2.5.
- **`context` merges whole `chain()` results.** On a densely linked store this could return a
  large subgraph. Upgrade: bound the walk by depth.
