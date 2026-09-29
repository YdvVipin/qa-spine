# Test results from CI: JUnit ingest, and failing tests that block the gate

**Status:** design approved; flaky detection added 2026-09-29 (see *Flaky tests*)
**Date:** 2026-09-25
**Repo:** qa-spine only. Branch `junit-results`, cut from `delivery-integration` @ `6b606ca`
(the gate and the Action, not yet merged to `main`).

## What this does

Test results reach the ledger today only from a tool someone wired up by hand, and even
then they never change a verdict: `assessReleaseRisk` puts failing runs in unscored
`context` and asks the agent to mention them. The gate cannot see them at all.

This phase does two things, and they are one phase on purpose. Ingesting results that
nothing reads would be data in, nothing out.

1. `qa-spine ingest-junit <file>...` records a JUnit XML report as `test_case` and
   `test_run` artifacts, linked to the requirements the tests name.
2. A failing test on a changed area becomes a **blocking signal**, alongside the existing
   unanswered question. The gate, `assess_release_risk`, `release_submit`, the verdict and
   the brief all see it.

## Decisions

### A test is tied to a requirement by a ticket key the test carries

Keys are found with the gate's ticket pattern (`--ticket-pattern`, default
`DEFAULT_TICKET_PATTERN`) in three places on each `<testcase>`:

- its `name` attribute,
- its `classname` attribute,
- the `value` of any child `<property name="requirement" value="...">` (the shape pytest's
  `record_property` and most JUnit reporters emit).

Every key found adds a `covers` edge from the test case to the requirement artifact whose
`sourceRef` equals that key. A key with no such requirement is reported as uncovered and
links nothing. A test with no key at all is still recorded; it simply cannot block.

Rejected: matching existing `test_case` artifacts by name (ties the feature to whoever
created them), and using the test's file path (would block on test-file edits, not on the
requirement changing).

### A test case has one stable identity across ingests

The latest-run rule below only works if the second ingest of a test attaches its run to the
same `test_case` as the first. A test case's `sourceRef` is

```
junit:<classname>::<name>
```

and ingest reuses an existing `test_case` with that `sourceRef` rather than creating one.
Changed refs are paths and ticket keys, so this prefix can never collide with one.

A reused test case gains a `covers` edge for any newly found key. An edge that already
exists is not re-linked (the edges table's primary key would reject it).

### Status

| JUnit child element | `test_run.content.status` | Blocks? |
|---|---|---|
| none | `passed` | no |
| `<failure>` | `failed` | yes |
| `<error>` | `error` | yes |
| `<skipped>` | `skipped` | no |

`content` also carries `message` (the element's `message` attribute, else its text, capped
at 1000 characters), `time` when present, and `runRef`. The same test appearing more than
once in one ingest collapses into one run with the **worst** status (error > failed >
skipped > passed). A gate is conservative, and retry plugins that pass on a rerun report a
passing testcase anyway.

### Provenance

Both artifact types are `producer: 'tool'`, `tool: 'qa-spine ingest-junit'`, with
`toolVersion`. A pipeline's output is neither a person's nor a model's.

`runRef` (`--run-ref`, e.g. a CI run URL) becomes the `test_run` `sourceRef`. Omitted, it is
`junit:<basename of the first file>`.

### The latest run decides

For each changed requirement, the gate walks `covers` edges to its test cases and, for each,
takes the most recent `test_run` that `verifies` it (`created_at` desc, then `rowid` desc).
A `failed` or `error` latest run is a signal. A later passing run clears it: nothing is
superseded, the newer fact simply wins.

This applies to every covering test case, including ones QAAE created, not only ingested
ones.

### Ingest is all-or-nothing

The whole report is parsed and validated before the first write. Malformed XML, an
unreadable file, or a report with zero `<testcase>` elements exits 2 and writes nothing.
A report of results that reads as "no tests" is not a clean run.

The writes themselves go in one transaction. `TraceStore.record` currently issues its own
`BEGIN`, which cannot nest, so it moves to `SAVEPOINT` / `RELEASE` / `ROLLBACK TO`, and the
store gains `transaction(fn)` wrapping `BEGIN … COMMIT`. `record` behaves exactly as before
when called outside one.

### Flaky tests: detected, never excused

Added 2026-09-29, from the enhancement roadmap (R2). A test is **flaky** when either:

- one report holds the same test more than once with a `passed` and a `failed`/`error`
  outcome (retry plugins) — the run is recorded with `content.flaky: true`; or
- two of its runs carry the same `content.commit` and disagree the same way.

`--commit` sets `content.commit`; omitted, ingest uses `git rev-parse HEAD` in the working
directory, and records no commit when that fails (ingest outside a repository is legitimate).

Detection only. A flaky test whose latest run failed **still blocks**: its signal carries
`flaky: true`, the gate lists it as flaky, and the brief says so. Nothing relaxes the gate
without an override and a name. `assessReleaseRisk` and the gate also list flaky tests on
changed areas whose latest run passed, as information.

Rejected: automatic quarantine (Trunk, BuildPulse). It would be the first thing in qa-spine
to relax the gate without a person's name on it.

### Parser: small and built in

Node has no XML parser, and the project's runtime dependencies are two. The parser reads
only what JUnit reports use: elements, quoted attributes, self-closing tags, comments,
the `<?xml?>` prolog, CDATA, and the five named entities plus numeric references. It finds
`<testcase>` elements at any depth, so `<testsuites>` roots, bare `<testsuite>` roots and
nested suites all work. Anything it cannot read is an error, never a skipped testcase.

It carries a `ponytail:` comment: no DTDs, no namespaces, no processing instructions beyond
the prolog. Upgrade path is a real parser dependency if a reporter in the wild needs more.

### The signal

`RiskSignal` becomes a union:

```ts
| { kind: 'unresolved_finding_on_changed_area'; ... }            // unchanged
| { kind: 'failing_test_on_changed_area';
    artifacts: [testRunId, testCaseId, requirementId];
    detail: { testRunId; testCaseId; requirementId; sourceRef; name; status; message } }
```

Both kinds block, so there is still no `blocking` field.

`recordVerdict`:
- refuses `ship` while either kind is live, naming both in the error;
- records `liveTestRuns` next to `liveFindings` on every verdict;
- records `override.testRuns` next to `override.findings` when an override overrode one.

The `approvedBy` rule for overrides is unchanged and now also applies when only a failing
test was live. `assessReleaseRisk`'s instructions drop "report failing test runs you find in
context", since they are signals now.

### Gate output

`GateResult` gains `failingTests: detail[]` rather than changing `signals`, so existing
consumers of the JSON keep working. `shippable` is false when either list is non-empty,
unless overridden. Exit codes are unchanged: 0 shippable, 1 blocked, 2 could not tell.

The Markdown summary adds a "failing tests on areas this change touches" section, and
`defaultReason` covers failing tests in plain language (it goes through the jargon lint).

### The brief

When `liveTestRuns` is non-empty, the brief lists each failing test by name with its message,
in the section that explains why the release is held. Verdicts recorded before this phase
have no `liveTestRuns` and render as they do today.

### The Action

A `junit` input takes report paths (space-separated, shell globs allowed). When set, the
step runs `ingest-junit` against the same store before `gate`, with `--run-ref` set to the
workflow run's URL. A glob matching no file is exit 2, not a skipped ingest.

The README tells users the Action step needs `if: always()` after a test step, or a failing
test job never reaches the gate at all.

## Known limits, left alone on purpose

- **Runs are only as shared as the store.** A pull request's ingest is visible to that job's
  gate. Whether it reaches `main` depends on how the project persists its store, which the
  Action already leaves to the project.
- **Branches share one "latest".** If a project persists stores from branch runs, a failing
  run on a feature branch counts as the latest for `main` too. Scoping runs by branch waits
  until someone persists branch stores and hits it.
- **No MCP tool for ingest.** The CLI is what CI calls. Add a tool when an agent needs one.

## Testing

- Parser: suites at each nesting shape, self-closing testcases, entities, CDATA, all four
  statuses, and malformed input rejected.
- Ingest: keys found in each of the three places; stable identity across two ingests;
  uncovered keys reported; worst status wins on duplicates; zero-testcase and malformed
  reports write nothing (checked by counting artifacts before and after).
- Store: `record` inside `transaction` rolls back with it; outside it behaves as before.
- Gate: a failing latest run blocks, a later passing run clears it, skipped does not block,
  override with approver ships, JSON keeps `signals` shape.
- Verdict and brief: `liveTestRuns` recorded and rendered.
- Every guard gets the round trip: revert the fix, watch the test fail, restore it.
