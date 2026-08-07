# Phase 5 — packaging: make it installable

**Status:** design approved, not implemented
**Date:** 2026-08-07
**Repo:** qa-spine only. `main` at `efe86c1`.
**Next cycle, not this one:** the CI release gate (`qa-spine gate` + a GitHub Action). It cannot
be tested the way users will run it — `npx qa-spine gate` inside an Action — until this ships.

## What this does

Six phases of work are reachable only by cloning the repo. `npm pack --dry-run` shows what a user
actually receives:

```
LICENSE  README.md  package.json  rubrics/ambiguity.json
dist/{server,audit,release,brief}.js  dist/trace/*  dist/inspector/*
14 files, 34.3 kB
```

**`examples/` does not ship.** So the README's own quickstart —
`node examples/seed-demo.ts && npm run inspect` — is broken for everyone who installs from npm: it
names a file they do not have and an npm script from a repo they did not clone. A fresh install
gives an empty store, nothing to look at, and instructions pointing at nothing.

This makes the package usable by someone who has never seen the project.

## What already works, and therefore is not in scope

Two things the original plan called for turned out to be already handled by the code:

- **The store directory creates itself.** `src/server.ts:297` runs
  `mkdirSync(dirname(path), { recursive: true })`.
- **The packaged rubric resolves with zero setup.** `rubricsDir()` falls back to
  `resolve(import.meta.dirname, '..', 'rubrics')`, which from `dist/audit.js` is the shipped
  `rubrics/` directory.

So `npx qa-spine` on a clean machine already starts, creates its store, and loads the rubric.
`init` must not duplicate any of that.

## Decisions

### The demo never touches the user's store

`demo` seeds a throwaway database under the temp directory. The ledger is append-only: anything
seeded into a real store is permanent and cannot be deleted, only superseded. A product whose
first act is to put fake refund tickets in your permanent record — which you then cannot
remove — teaches exactly the wrong first lesson.

This is not hypothetical. During development a single stray `requirement` with the text `"smoke"`
entered this repo's own `.qa-spine/trace.db` from a mistyped command, and it is still there.

### The demo deletes its own database before seeding

Re-running `demo` must not append a second copy of the arc. Since nothing can be removed from a
ledger, the only way to make it repeatable is to start from a fresh file. It deletes exactly one
path — `<tmpdir>/qa-spine-demo.db` — which it owns and names. It never deletes anything else, and
it never touches a path the user configured.

### The demo's verdict goes through `recordVerdict`, not `store.record`

The seeded verdict is recorded through the real function, so `liveFindings` is computed from
actual signals and the prose lint applies to the demo's own text.

Two reasons. The demo is then subject to the product's own rules rather than staging a picture of
them. And it becomes a live check that the gate works — if `recordVerdict` ever regresses, `demo`
fails loudly rather than quietly seeding a verdict no real call could have produced.

### `init` is three things the code cannot do for itself

Nothing decorative. Each is something a user would otherwise have to work out by reading
`node_modules`:

1. **Copy the rubric into the project.** The README calls it "the thing a team argues about in
   review rather than a prompt buried in the server" — that is only true if the team owns the file
   and can commit it. **Never clobbers an existing one.**
2. **Print the `claude mcp add` line with the resolved absolute path.** The path differs per
   install and is inside `node_modules`; nobody should have to find it.
3. **Add `.qa-spine/` to `.gitignore`.** A SQLite file in git means binary merge conflicts on
   every parallel branch.

Idempotent: running twice reports what it skipped and changes nothing.

### `examples/seed-demo.ts` is deleted

It writes pre-phase-2 data: categories like `vague_qualifier` that are not rubric rule ids,
findings with no `question` field, and a verdict predating `changed` and `liveFindings`. The
release-brief review found that rendering its verdict produces a page with empty sections.

`demo` supersedes it entirely, and two seeders would drift.

## Components

### `init` subcommand

```bash
npx qa-spine init
```

Added to the CLI switch in `src/server.ts` beside `record`, `brief` and the audit subcommands.
Human-readable output on stdout; errors on stderr with exit 1 — it is a command a person runs and
reads, not a program parses.

Steps, each reporting what it did or why it skipped:

1. **Rubric.** Copy `<packageRoot>/rubrics/ambiguity.json` to `./rubrics/ambiguity.json`, creating
   `./rubrics/` if needed. If the destination exists, skip and say so. `packageRoot` is
   `resolve(import.meta.dirname, '..')` — the same resolution `rubricsDir()` already uses, so
   there is no second path convention to keep in step.
2. **`.gitignore`.** Append `.qa-spine/` if not already present, creating the file if absent.
   Matching is exact-line after trimming, so `.qa-spine` and `.qa-spine/` are treated as distinct
   and a near-miss does not silently pass.
3. **MCP line.** Print
   `claude mcp add qa-spine -- node <packageRoot>/dist/server.js`
   with the real absolute path.

Then print what to do next, naming `QA_SPINE_RUBRICS` so a user who moved the rubric knows how to
point at it.

### `demo` subcommand

```bash
npx qa-spine demo
```

1. `rm -f <tmpdir>/qa-spine-demo.db`, then open a `TraceStore` there.
2. Seed the arc below.
3. Render a brief for the verdict and write `<tmpdir>/qa-spine-demo-brief.html`.
4. Print the store path, the brief path and the Inspector URL.
5. Start the Inspector on that store and block, exactly as `inspect` does.

`QA_SPINE_DB` is deliberately ignored: the demo's whole point is that it does not write where the
user's data lives. Say so in the output, so someone who set it is not surprised.

### The seeded arc

| # | Artifact | Provenance | Links |
| --- | --- | --- | --- |
| 1 | `requirement` `PROJ-42` — "Refunds must be processed quickly and the customer notified appropriately." | human | — |
| 2 | `finding` `AMB-VAGUE-QUANT`, quote "processed quickly" | ai | `derived_from` 1 |
| 3 | `finding` `AMB-UNTESTABLE`, quote "notified appropriately" | ai | `derived_from` 1 |
| 4 | `answer` "Within three business days, measured from approval." | human | `supersedes` 2, `derived_from` 1 |
| 5 | `test_case` "refund completes and emails the customer" | ai | `covers` 1 |
| 6 | `test_run` failed | human | `verifies` 5 |
| 7 | `verdict` hold, via `recordVerdict` | ai | `derived_from` #3 and #1, from `cites` |

Both findings carry a real `question`, and both quotes are verbatim substrings of #1 — so the data
would survive `audit_submit`'s validation, not merely `store.record`'s.

The verdict cites **the open finding (#3) and the requirement (#1)**. That is what connects the
verdict to the rest of the graph: `recordVerdict` turns each cited id into a `derived_from` edge,
so a `chain()` walk from the requirement reaches every one of the seven artifacts. Citing only the
finding would still connect it, but citing the requirement too is what a real caller would do —
the brief names both.

The verdict is recorded with `changed: ['PROJ-42']`, which makes `assessReleaseRisk` find #3 as a
live signal and `recordVerdict` store it in `liveFindings`. Its `reason` must pass the prose lint:

> "One question raised when this work was specified was never answered, and it touches an area this
> release changed."

What the user then sees: the chain view with #3 rendered red, the audit queue with one answered and
one open question, and a brief reading **"Not ready to ship"** naming the open question.

### README quickstart

Replaces the current repo-first instructions:

````markdown
## Quickstart

```bash
npx qa-spine demo     # see it working — writes only to a temp file
npx qa-spine init     # set up your project
```

`init` prints the line to register it with Claude Code.
````

The existing `npm install / npm test / npm run build` block stays, relabelled as instructions for
working **on** qa-spine rather than **with** it.

## Error handling

- `init` — an unwritable `./rubrics/` or `.gitignore` prints what failed and exits 1, having
  changed nothing else. Each step is independent: a failed `.gitignore` write does not undo the
  rubric copy, and the output says which succeeded.
- `demo` — a failure while seeding prints the error and exits 1 without starting the Inspector, so
  nobody is shown a half-built store. The temp database is left in place for inspection.
- Neither command reads or writes `.qa-spine/trace.db` or any `QA_SPINE_DB` path.

## Testing

`node --test`, new file `tests/cli-init-demo.test.ts`, subprocess-driven like
`tests/record-cli.test.ts`, with `cwd` set to a temp directory so nothing touches the repo.

**init:**

1. copies the rubric to `./rubrics/ambiguity.json`, and the copy parses as a valid rubric
2. does **not** clobber an existing `./rubrics/ambiguity.json`, and says it skipped
3. creates `.gitignore` with `.qa-spine/` when absent
4. appends `.qa-spine/` to an existing `.gitignore` without disturbing its other lines
5. does **not** append a second time when the entry is already present
6. prints an absolute path to `dist/server.js` that exists on disk
7. exits 0 on success

**demo:**

8. seeds seven artifacts and writes the brief file
9. the brief contains "Not ready to ship" and the open question's text
10. the chain from the requirement reaches the verdict — the graph is connected, not seven
    disconnected rows
11. finding #3 has no incoming `supersedes` edge and finding #2 does — the queue shows one of each
12. the recorded verdict carries `liveFindings` naming finding #3, proving it went through
    `recordVerdict` rather than a raw write
13. running twice yields seven artifacts, not fourteen
14. neither command writes to a `QA_SPINE_DB` path when one is set

Test 12 is the one that matters most: it is what makes the demo a check on the gate rather than a
staged picture of it.

## Scope

**In:** the two subcommands, `tests/cli-init-demo.test.ts`, the README quickstart, deleting
`examples/seed-demo.ts`.

**Out:**
- Publishing to npm and claiming the name — the user's account, not a code change
- A config file: every setting works through env vars today, and a second mechanism would have to
  be kept consistent forever
- Auto-registering with Claude Code — `init` prints the command rather than editing someone's
  config
- Any GitHub Action or `gate` subcommand — the next cycle
- Any change to the MCP tools, the store, or the Inspector

## Known ceilings

To be marked with `ponytail:` comments:

- **`demo` hardcodes one arc.** No flags to vary it, no way to seed a clean `ship`. Fine for a
  first-run demo; a second scenario is a flag when someone asks.
- **`init` only knows Claude Code.** Other MCP clients register differently and get nothing. The
  upgrade is a `--client` flag once a second client is actually being used.
- **The rubric copy is a snapshot.** A user who copies it and then upgrades the package keeps the
  old rules with no notice that the packaged version moved. Upgrade path: compare versions on
  `init` and say so.
- **`demo` deletes a fixed temp path.** Two demos running at once on one machine would collide.
  Nobody does this; `mkdtemp` is the fix if anybody ever does.
