# Ledger integrity: a hash chain, `verify`, and closing the gate's side doors

**Status:** implemented on `ledger-integrity`
**Date:** 2026-09-29
**Repo:** qa-spine only. Branch `ledger-integrity`, cut from `junit-results` @ `c95e6f1`.

## What this does

The README documents three ways to get a release through without the gate seeing a
problem, and the store's append-only triggers stop an edit through `sqlite3` but not someone
who drops the triggers first. This phase closes the side doors and makes after-the-fact
tampering detectable.

1. **Gated types stay gated.** `trace_record` (MCP) and `record` (CLI) refuse `finding`,
   `answer` and `verdict`, and refuse a `supersedes` link onto a finding. Those have their own
   recorders (`audit_submit`, `audit_answer`, `release_submit`), which are the only places the
   checks live.
2. **A narrowed release list is recorded.** When `release_submit` names fewer areas than the
   `assess_release_risk` call for the same release in the same session, the verdict records
   what was dropped and the brief says so.
3. **Hash chain + `qa-spine verify`.** Every artifact and edge written through qa-spine is
   chained: `hash = sha256(previous hash + canonical row)`. `verify` recomputes it and exits 1
   on any edited, deleted or unchained row.

## Decisions

### 1. The guard lives at the two raw entry points, not in the store

`TraceStore.record` is what the gated recorders themselves call, so the refusal cannot live
there. `assertRawRecordAllowed(store, input)` in `src/trace/store.ts` is called by the MCP
`trace_record` tool and the CLI `record` subcommand, and nowhere else.

- Refused types: `finding` (use `audit_submit`, which checks the quote is verbatim),
  `answer` (use `audit_answer`), `verdict` (use `release_submit`).
- Refused link: `supersedes` whose target is a finding. That is how an answer retires a
  finding; a raw one would retire it with no answer at all.
- Everything QAAE writes today (`requirement`, `test_case`, `test_run`, a `supersedes` onto a
  test case when a test is healed) is unaffected.
- `review` stays open: reviews are human judgements the Inspector writes directly.

The error names the tool to use instead.

Known limit, kept: `store.record` from code that imports the library directly is not
guarded. That is the same trust boundary as opening the SQLite file; the hash chain is what
covers it after the fact.

### 2. Narrowing is remembered per session and recorded, not refused

`assess_release_risk` stays read-only: making it write would put an artifact in the ledger
for every question an agent asks. Instead, `createServer` keeps an in-memory map of
`releaseRef → changed` from the last assessment in that MCP session. `release_submit` passes
it to `recordVerdict` as `assessedChanged`, which records

```
content.droppedFromAssessment: string[]   // assessed, but not in this verdict's `changed`
```

only when non-empty, so existing verdict shapes do not change. Refusing instead was rejected:
a caller can legitimately split one release into two decisions, and refusal would push it to
call `assess` again with the narrower list, which hides the narrowing rather than recording it.

The brief renders a callout when the field is present: *"This decision covered fewer areas
than were assessed earlier: …"*, listing the refs.

Limit: an assessment in a different session, or with no `releaseRef`, is not remembered.

### 3. The hash chain

A new table, append-only by triggers like the others:

```sql
CREATE TABLE IF NOT EXISTS chain (
  seq  INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,       -- 'genesis' | 'artifact' | 'edge'
  ref  TEXT NOT NULL,       -- artifact id, or "from>to:relation"
  hash TEXT NOT NULL
);
```

- `record` and `link` append a chain row in the same savepoint as the row itself, **after**
  inserting it. The insert takes SQLite's write lock first, so two concurrent writers cannot
  both read the same previous hash.
- The canonical payload is the row exactly as stored (the JSON text columns, not re-serialized
  objects), as a JSON array: `["artifact", id, type, source_ref, content, provenance,
  created_at]` or `["edge", from, to, relation, created_at]`.
- The first chain row is a `genesis` row whose `ref` is `"<max artifact rowid>:<max edge
  rowid>"` from just before chaining began, hashed from 64 zeros. Rows at or below those
  watermarks are legacy.
- `TraceStore` now creates its own directory when it opens a file. That replaced the CLI's
  "exempt list" of commands that must not create one, which `verify` would have extended.

`qa-spine verify` reports, and exits 1 on any of:

- a chain row whose hash does not match its recomputation (row edited, or chain edited);
- a chain row whose artifact or edge no longer exists (row deleted);
- an artifact or edge with no chain row, written after the first chained row (a raw insert
  that bypassed qa-spine).

Rows older than the first chained row are **legacy**: written by a qa-spine from before this
phase. They are counted and reported, not failed. A store with no chain at all reports that
plainly and exits 0, so upgrading never turns a green build red on its own.

Output is JSON: `{ ok, chained, legacy, head, problems: [{ kind, ref, problem }] }`. Exit 0
intact, 1 tampering found, 2 could not run.

**Ceiling, stated in a `ponytail:` comment and the README:** a chain with no external anchor
can be recomputed wholesale by someone who understands it. `verify` prints the head hash so a
team can anchor it somewhere they already trust (a CI log, a release note). The store file is
usually committed to git, which is itself an anchor.

### 4. The Action runs `verify` before `gate`

A broken chain exits 2 with an error annotation: the gate would otherwise be reading a ledger
nobody can vouch for, which is "could not tell", not "blocked".

## Testing

Each guard gets the revert-and-fail round trip.

- Raw path: each refused type and the refused link, through both MCP (in-memory client) and CLI;
  QAAE's shapes (requirement, test_case, test_run, supersedes onto a test case) still accepted.
- Narrowing: assess then submit a narrower list in one session → `droppedFromAssessment`;
  same list → field absent; brief renders the callout.
- Chain: clean store verifies; editing a row with triggers dropped → hash problem; deleting a
  row → missing problem; raw insert → unchained problem; a pre-chain store → legacy, exit 0;
  rows written inside `transaction()` chain correctly; concurrent CLI writers leave a valid chain.
