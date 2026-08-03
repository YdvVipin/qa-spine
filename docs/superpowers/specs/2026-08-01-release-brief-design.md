# Release brief — making a verdict legible to someone non-technical

**Status:** design approved, not implemented
**Date:** 2026-08-01
**Depends on:** phase 3 (merged at `b191a31`) — `release_submit` already records almost everything
this renders.

## What this does

The Inspector is, by its own first line of CSS, "an instrument for judging agent output, not a
dashboard." That decision stands. But it leaves a project manager or project head with no way in:

1. **They cannot open it.** It binds to `127.0.0.1` with no auth, deliberately.
2. **Its vocabulary is the product's internals** — `artifact`, `producer`, `provenance`,
   `promptVersion`, `sourceRef` — and the chain view prints relations raw:
   `test_case_d995b342 supersedes test_case_d76eeff5`.
3. **The list view is a database table** — `type / summary / producer / model / confidence /
   source / created`.
4. **It answers "what is in the store?"** while a project head asks "are we OK to ship, what is
   blocking, and who decided?"

This adds a subcommand that turns one recorded verdict into a self-contained HTML page a
non-technical reader can understand and that you can send them, plus a prose lint at authoring
time so the agent's own words cannot reintroduce the jargon the page strips. The Inspector is
untouched.

## Decisions

### They receive a document; they do not operate a tool

A brief sidesteps the loopback-only constraint rather than arguing with it. Putting the Inspector
on a network would give up a deliberate security property, and a project head reading a link is a
far more realistic habit than one running a localhost server.

The page is self-contained — inline CSS, no JavaScript, no external requests — so it survives
being emailed, pasted into Confluence, or printed to PDF.

### It renders a verdict that already exists; it computes no new judgement

`qa-spine brief <verdictId>` reads one `verdict` artifact. `release_submit` already stored the
decision, the agent's prose, the changed list, the unmatched refs, and the override with the ids
of the findings it overrode.

**The brief cannot disagree with the ledger, because it is the ledger.**

Rejected: computing fresh from `changed` refs via `assessReleaseRisk`. It would work before any
decision was recorded, but it means a second prose layer that can drift from what the agent wrote,
and it produces a document that looks like a decision when none was made.

Consequence, accepted: **no verdict, no brief.** "No decision has been recorded for this release"
is an honest thing for a project head to hear.

### It renders the decision as recorded, not the world as it is now

If a question cited by a `hold` has since been answered, the brief for that release still shows it
was open when the call was made. Re-evaluating at render time would make the brief disagree with
the verdict it renders, destroying the property that justifies this approach.

**This governs the wording throughout.** The page says "had not been answered when the release
decision was recorded", never "still open" or "currently unanswered" — those are claims about
now, which the brief has deliberately given up the right to make. The footer states the limitation
outright. Anywhere two readings diverge, the past-tense one is correct.

### The prose is constrained where it is authored, not where it is rendered

The translation layer fixes the structure around the agent's prose, never the language inside it.
So the fix belongs at `release_submit`, which is where the prose is written.

**Deny only unambiguous internals.** A denylist over ordinary English would reject legitimate
sentences at the worst possible moment — a release-blocking call from someone trying to ship:

| Would be wrongly rejected | Trips on |
| --- | --- |
| "Our finding was that the retry logic is sound." | `finding` |
| "We could not trace the root cause before cutoff." | `trace` |
| "The refund requirement was ambiguous from the start." | `requirement` |

So the list carries only tokens with no innocent reading: snake_case relation names, camelCase
field names, and artifact-id patterns. Bare `finding`, `trace`, `requirement` and `spine` are
allowed.

### AI involvement is limited to the verdict's own provenance

Who or what wrote the decision, and whether a human reviewed it. The second half needs one lookup
— `store.edgesTo(verdictId)` filtered to `reviews`, which phase 2.5 already provides.

Rejected for now: walking the chain to count how many artifacts an AI produced and how many a
human reviewed. Genuinely the product's differentiator, but it costs a chain walk and a second
data shape. Add it when a real reader asks.

## The page

Six blocks. Max width 640–720px so it reads in email and Confluence. Single light theme, generous
whitespace, print styles that enlarge the decision heading and hide nothing.

| # | Block | Appears |
| --- | --- | --- |
| 1 | The decision | always |
| 2 | Why this decision was made | always |
| 3 | Questions that were still open | only if cited findings exist |
| 4 | What this release touches | always |
| 5 | Who made this decision | always |
| 6 | Footer | always |

### 1 — The decision

`<h1>Not ready to ship</h1>` or `<h1>Cleared to ship</h1>`, the largest thing on the page.

Muted sub-line: `A formal release decision was recorded on 1 August 2026.`

### 2 — Why this decision was made

The agent's `content.reason`, verbatim. When it is empty or whitespace-only:

> No explanation was provided with this decision.

### 3 — Questions that were still open when this decision was made

Per cited finding:

```
Question asked on 12 July
"Does the login flow need to support SSO for external partners?"

This question was raised while the work was being specified and had not been
answered when the release decision was recorded.
```

The finding's `question` is the main text. Its `quote` appears in a quieter secondary style only
when present. Light left border or subtle background so the block reads as notable rather than as
an error. Section omitted entirely when there are no cited findings.

### 4 — What this release touches

Plain list of the `changed` entries. Unmatched entries carry an inline note:

```
login.spec.ts — changed, but no requirement covers it
```

### 5 — Who made this decision

One accurate line:

- `Written by an AI (claude-opus-5) · No human review was recorded`
- `Written by an AI (claude-opus-5) · Later reviewed by a person`
- `Written by a person`

Override callout, only when present, on a soft amber background:

```
⚠ This release was cleared even though open questions existed.

Reason given at the time:
"We accepted the risk because the open question only affects the admin
 reporting screen, which is not part of this release."
```

The warning mark and the words "even though" both stay. A non-technical reader needs the tension
visible.

### 6 — Footer

Small and muted, below a clear visual boundary:

```
Record ID: verdict_a1b2c3d4 · Recorded 2026-08-01 09:14 UTC
This is a historical record of a decision. It does not reflect later answers or changes.
```

## Components

### `renderBrief(store, verdictId): string` in `src/brief.ts`

1. `store.get(verdictId)`; reject if missing or not a `verdict`.
2. Cited ids: `store.edgesFrom(verdictId)` filtered to `derived_from`, plus any in
   `content.override.findings`, deduped.
3. `store.get()` each; keep type `finding`; read `question`, `quote`, `createdAt`.
4. Human review: `store.edgesTo(verdictId)` — any `reviews` edge means a person looked at it.
5. Render.

No new store method. `get`, `edgesFrom` and `edgesTo` all exist.

**Escaping is mandatory on every interpolated value.** `content.reason`, `override.reason` and
`finding.quote` are all free text — the first two written by an agent, the third copied out of a
requirement. Any of them can contain `<`, `&`, or a stray tag. A brief that renders agent prose as
markup is an injection bug in a file people forward by email.

### `brief` subcommand in `src/server.ts`

`node dist/server.js brief <verdictId>` prints the HTML on stdout and exits 0; on any failure
prints a plain-text message on **stderr** and exits 1.

Deliberately unlike `record`, which puts a JSON error on stdout because its caller parses one JSON
object. This output is a document being redirected to a file, so a failed run must leave an empty
file rather than a file containing an error page.

### Prose lint in `src/release.ts`

`recordVerdict` gains one validation, after the existing blank-`reason` check and before any
write. `reason` is rejected when it contains any of:

- `/\b(derived_from|supersedes|covers|verifies|contradicts|reviews)\b/i`
- `/\b(sourceRef|promptVersion|inputDigest)\b/i`
- `/\b(test_case|test_run)\b/i`
- `/\b(requirement|finding|test_case|test_run|defect|verdict|review|answer)_[0-9a-f]{8}\b/i`

Message names the offending term, because the consumer is a model that must correct and retry:

```
reason contains internal terminology ("derived_from") — rewrite in plain language
suitable for a project manager
```

`covers` and `reviews` as bare words are borderline English, but both appear here only as relation
names and the phrases a person would naturally write ("this covers the refund flow") are rare
enough in a release rationale to accept. Named so the trade-off is visible.

## Error handling

- unknown id → `no artifact with id X`, exit 1
- id is not a verdict → `artifact X is a Y, not a verdict`, exit 1
- no id given → usage message, exit 1
- a cited artifact that no longer resolves → skipped silently; a missing citation must not stop the
  brief rendering, and the footer's id lets someone investigate

## Testing

`node --test`. New file `tests/brief.test.ts`, plus additions to `tests/release.test.ts` for the
lint. `new TraceStore(':memory:')` throughout.

**Brief:**

1. a `hold` renders "Not ready to ship" and the agent's reason verbatim
2. a `ship` renders "Cleared to ship"
3. a cited finding's question and date appear, in the past tense
4. no cited findings → the questions section is absent entirely
5. `unmatched` refs render with the "no requirement covers it" note
6. an override renders the callout, the words "even though", and its reason
7. no override → no callout
8. **the page body contains no artifact ids, no relation names, no internal field names**
9. an empty `reason` renders the explicit fallback sentence
10. a verdict with a `reviews` edge renders "Later reviewed by a person"; without one, "No human
    review was recorded"
11. `<`, `&` and a `<script>` tag in `content.reason` are escaped, not rendered as markup
12. the same for `finding.quote` and `override.reason`
13. unknown id and non-verdict id are both rejected and print nothing on stdout
14. a cited artifact missing from the store does not prevent rendering

**Lint:**

15. a `reason` containing `derived_from` is rejected, naming the term, and writes nothing
16. a `reason` containing `sourceRef` is rejected
17. a `reason` containing an artifact id is rejected
18. **a `reason` containing bare `finding`, `trace`, `requirement` or `spine` is accepted** — the
    false-positive guard, and the reason the narrow list was chosen

### Test 8 in detail

Strip everything from `<footer` onward, then assert the remainder matches none of:

- `/\b(requirement|finding|test_case|test_run|defect|verdict|review|answer)_[0-9a-f]{8}\b/`
- `/\b(derived_from|supersedes|covers|verifies|contradicts|reviews)\b/`
- `/\b(promptVersion|sourceRef|inputDigest|producer|artifact)\b/`

The fixture's `reason` deliberately contains no jargon, so anything found came from the template
rather than the recorded text.

## Scope

**In:** `src/brief.ts`, the `brief` subcommand in `src/server.ts`, the lint in `src/release.ts`,
`tests/brief.test.ts`, additions to `tests/release.test.ts`, a README section.

**Out:**
- Any change to `src/inspector/` — its audience and purpose are unchanged
- Network exposure or auth
- PDF generation — browsers print
- Chain walking or AI accounting
- Computing a brief where no verdict exists
- Briefs anchored on a ticket or a sprint

## Known ceilings

To be marked with `ponytail:` comments:

- **The lint is a denylist, not a readability check.** It stops mechanical jargon leaks; it cannot
  stop prose that is merely bad. Upgrade: a published rubric for brief prose, scored the way the
  ambiguity rubric already scores requirements.
- **`covers` and `reviews` are denied as bare words** though both have innocent English readings.
  Accepted because a release rationale rarely needs them. Upgrade: require the snake_case or
  camelCase form only.
- **The lint is retroactive-blind.** Verdicts recorded before it existed keep whatever prose they
  have, and their briefs will show it. There is no migration and the store is append-only, so this
  is permanent for existing records.
- **One verdict per brief.** No release spanning several verdicts, no comparison across releases.
- **Dates render from a UTC timestamp with no timezone shown** in the body. Fine for "asked 12
  July"; the footer carries the full UTC stamp for anyone who needs the hour.
