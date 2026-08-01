# Release brief — making a verdict legible to someone non-technical

**Status:** design approved, not implemented
**Date:** 2026-08-01
**Depends on:** phase 3 (merged at `b191a31`) — `release_submit` already records everything this
renders. Nothing new is computed.

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

This adds a fourth subcommand that turns one recorded verdict into a self-contained HTML page a
non-technical reader can understand, and that you can send them. The Inspector is untouched.

## Decisions

### They receive a document; they do not operate a tool

A brief sidesteps the loopback-only constraint entirely rather than arguing with it. Putting the
Inspector on a network would mean giving up a deliberate security property, and a project head
reading a link is a far more realistic habit than one running a localhost server.

The page is self-contained — inline CSS, no JavaScript, no external requests — so it survives
being emailed, pasted into Confluence, or printed to PDF.

### It renders a verdict that already exists; it computes nothing

`qa-spine brief <verdictId>` reads one `verdict` artifact. `release_submit` already stored the
decision, the agent's prose, the changed list, the unmatched refs, and the override with the ids
of the findings it overrode.

**The brief cannot disagree with the ledger, because it is the ledger.** What the reader sees is
exactly what was recorded, not a second telling of it.

Rejected: computing fresh from `changed` refs via `assessReleaseRisk`. It would work before any
decision was recorded — useful mid-sprint — but it means a second prose layer that can drift from
what the agent actually wrote, and it produces a document that looks like a decision when none was
made.

Consequence, accepted: **no verdict, no brief.** This is a release-time artifact. "No decision has
been recorded for this release" is an honest thing for a project head to hear.

### It renders the decision as recorded, not the world as it is now

A verdict is a historical record. If a question cited by a `hold` has since been answered, the
brief for that release still shows it was open when the call was made.

Re-evaluating openness at render time would make the brief disagree with the verdict it renders,
destroying the one property that justifies this approach. A brief is a record of a decision, not a
live status page.

**This governs the wording throughout.** The page says "unanswered when this call was made", never
"still unanswered" — the second is a claim about now, which the brief has deliberately given up
the right to make. Anywhere the two readings diverge, the past-tense one is correct.

### AI involvement is limited to the verdict's own provenance

One line: who or what wrote this decision, and whether a human has reviewed it. That is free — it
is on the artifact already.

Rejected for now: walking the chain to count how many artifacts an AI produced and how many a
human reviewed. It is genuinely the product's differentiator — *"nine of the eleven tests here
were AI-written and nobody reviewed them"* is a real risk signal a Jira dashboard cannot produce —
but it costs a chain walk and a second data shape. Add it when a real reader asks.

## The translation layer

This is the feature. Everything else is plumbing.

| What the store says | What the brief says |
| --- | --- |
| `verdict: "hold"` | **Not ready to ship** |
| `verdict: "ship"` | **Cleared to ship** |
| a cited `finding` | "A question raised when this work was specified, unanswered when this call was made" |
| `finding.question` | the question, verbatim |
| `finding.createdAt` | "asked 12 July" |
| `changed` | "What this release touches" |
| `unmatched` | "Changed with no requirement covering it" |
| `override` | "Shipped over an open question" |
| `override.reason` | the reason, verbatim |
| `producer: "ai"` + `model` | "written by an AI (claude-opus-5)" |
| `producer: "human"` | "written by a person" |
| `promptVersion`, `sourceRef`, `inputDigest` | not shown |
| every artifact id | not shown, except the footer |

**Hard rule: no ids, no snake_case, no relation names in the page body.** The footer carries the
verdict id and timestamp, small, so a developer can trace back — that is the single exception and
it lives below a `<footer>` boundary the test can exclude.

## The page

Six blocks, in reading order:

1. **The verdict** — large, unambiguous, in words. The first thing read.
2. **Why** — the agent's `content.reason` prose, verbatim.
3. **What's unanswered** — each cited finding as a question in plain language, with when it was
   asked. Omitted entirely when there are none.
4. **What this touches** — the `changed` list, with `unmatched` entries flagged.
5. **Who decided** — the provenance line, plus an override callout when present.
6. **Footer** — verdict id and timestamp.

Single light theme, print-first. Deliberately not the Inspector's dark mono instrument look —
different reader, different object.

## Components

### `renderBrief(store, verdictId): string` in `src/brief.ts`

1. `store.get(verdictId)`; reject if missing or not a `verdict`.
2. Gather cited artifact ids: `store.edgesFrom(verdictId)` filtered to `derived_from`, plus any
   ids in `content.override.findings`, deduped.
3. `store.get()` each; keep those of type `finding`, read `question`, `quote`, `createdAt`.
4. Render. No new store method; `edgesFrom` and `get` already exist.

Escaping is mandatory on every interpolated value. `content.reason` and `override.reason` are free
text written by an agent, and `finding.quote` is copied from a requirement — all three can contain
`<`, `&`, or a stray tag. A brief that renders agent prose as markup is an injection bug in a file
people forward by email.

### `brief` subcommand in `src/server.ts`

Added to the existing switch. `node dist/server.js brief <verdictId>` prints the HTML on stdout
and exits 0; on any failure prints a plain-text message on stderr and exits 1.

Note the deliberate difference from `record`: that subcommand puts a JSON error on **stdout**
because its caller is a program parsing one JSON object. This one's output is a document being
redirected to a file, so an error must not land in the HTML — it goes to stderr, and a failed run
leaves an empty file rather than a file containing an error page.

## Error handling

- unknown id → `no artifact with id X`, exit 1
- id is not a verdict → `artifact X is a Y, not a verdict`, exit 1
- no id given → usage message, exit 1
- a cited artifact that no longer resolves → skipped silently in the unanswered list; a missing
  citation must not stop the brief rendering, and the footer's id lets someone investigate

## Testing

`node --test`, new file `tests/brief.test.ts`, `new TraceStore(':memory:')` as every other test
file does.

1. a `hold` renders "Not ready to ship" and the agent's reason verbatim
2. a `ship` renders "Cleared to ship"
3. a cited finding's question appears in plain language, with its date
4. a verdict with no cited findings omits the unanswered section entirely
5. `unmatched` refs are rendered and flagged
6. an override renders its reason and the callout
7. no override renders no callout
8. **the page body contains no artifact ids, no relation names, and no internal field names** —
   the anti-jargon guarantee as an assertion rather than an aspiration
9. `<`, `&` and a `<script>` tag in `content.reason` are escaped, not rendered as markup
10. the same for `finding.quote` and `override.reason`
11. an unknown id and a non-verdict id are both rejected, and print nothing on stdout
12. a cited artifact that has been deleted from the chain does not prevent rendering

### Test 8 in detail

It strips everything from `<footer` onward, then asserts the remainder matches none of:

- `/\b(requirement|finding|test_case|test_run|defect|verdict|review|answer)_[0-9a-f]{8}\b/`
- `/\b(derived_from|supersedes|covers|verifies|contradicts|reviews)\b/`
- `/\b(promptVersion|sourceRef|inputDigest|producer|artifact)\b/`

The fixture's `reason` prose deliberately contains no jargon, so anything the regexes find came
from the template rather than from the recorded text. That distinction matters — see the ceiling
below.

## Scope

**In:** `src/brief.ts`, the `brief` subcommand, `tests/brief.test.ts`, a README section.

**Out:**
- Any change to `src/inspector/` — the Inspector's audience and purpose are unchanged
- Network exposure or auth
- PDF generation — browsers print
- Chain walking or AI accounting
- Computing a brief where no verdict exists
- Briefs anchored on a ticket or a sprint

## Known ceilings

To be marked with `ponytail:` comments:

- **The agent's prose passes through verbatim.** The translation layer fixes the structure around
  it, not the language inside it. An agent that writes "the finding was superseded" produces a
  brief containing that sentence, and test 8 cannot catch it because the test cannot tell recorded
  text from template text. Upgrade: a rubric for brief prose, or a lint pass over `reason` at
  `release_submit` time — which is where it belongs, since that is where the prose is authored.
- **One verdict per brief.** No release spanning several verdicts, no comparison across releases.
  Upgrade: accept several ids and render sections.
- **No styling control.** One built-in theme. If a team wants their own, the honest answer is that
  the HTML is plain and small enough to restyle by hand.
- **Dates are rendered in the reader's implied locale from a UTC timestamp**, with no timezone
  shown. Fine for "asked 12 July"; wrong if anyone ever needs the hour.
