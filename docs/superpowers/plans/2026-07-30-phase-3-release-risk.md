# Phase 3 — `assess_release_risk` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given the areas a release touches, surface every unresolved requirement-stage finding on those areas and refuse to record a `ship` verdict while one is live, unless the caller explicitly overrides it on the record.

**Architecture:** A new `src/release.ts` module holds two plain functions — `assessReleaseRisk` (librarian: gathers signals and context, makes no model call) and `recordVerdict` (bouncer: validates and writes). Two thin MCP tools wrap them, exactly as phases 2 and 2.5 wrap `src/audit.ts`. One new store method, `bySourceRef`, is the join between "what changed" and what the spine knows.

**Tech Stack:** TypeScript on Node >= 22.5, `node:sqlite`, `node:test`, Zod, `@modelcontextprotocol/sdk`. No new dependencies.

## Global Constraints

- **Node >= 22.5.** Uses built-in `node:sqlite` and global `fetch`. No native build step.
- **No new dependencies.** Only `@modelcontextprotocol/sdk` and `zod` are permitted in `src/`.
- **The server never calls a model.** `assessReleaseRisk` returns data for the caller to reason over.
- **The store is append-only.** Never `UPDATE` or `DELETE`; SQLite triggers enforce this.
- **AI provenance is mandatory.** An artifact with `producer: 'ai'` must carry `model` and `promptVersion`. `recordVerdict` must NOT override `promptVersion` — the server owns no rubric here.
- **Tests are hermetic.** Always `new TraceStore(':memory:')`. No test may touch the network or a real Jira.
- **Every rejection writes nothing.** Validate fully before the first `store.record()`.
- **Deliberate shortcuts get a `ponytail:` comment** naming the ceiling and the upgrade path.
- Spec: `docs/superpowers/specs/2026-07-30-phase-3-release-risk-design.md`

## File Structure

| File | Responsibility |
| --- | --- |
| `src/trace/store.ts` (modify) | Add `bySourceRef(refs)`. Trace-level question, belongs beside `list()`. |
| `src/release.ts` (create) | `assessReleaseRisk` + `recordVerdict`. Mirrors `src/audit.ts`. |
| `src/server.ts` (modify) | Register `assess_release_risk` and `release_submit` as thin wrappers. |
| `tests/release.test.ts` (create) | All 16 spec tests. |
| `examples/import-jira.ts` (create) | Throwaway Jira importer. Outside `src/`, untested by design. |
| `README.md` (modify) | Tool table, roadmap, phase 3 section. |

**No change to** `src/trace/schema.ts` (`verdict` already exists in `ArtifactType`) or `src/inspector/` (verdicts render via `content.reason`).

---

### Task 1: `store.bySourceRef`

**Files:**
- Modify: `src/trace/store.ts` (add method after `list()`, around line 143)
- Test: `tests/release.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `bySourceRef(refs: string[]): Artifact[]` on `TraceStore`. Task 2 uses it.

- [ ] **Step 1: Write the failing tests**

Create `tests/release.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceStore } from '../src/trace/store.ts';

const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-opus-5', promptVersion: 'ambiguity/1' };

test('bySourceRef returns artifacts matching the given refs', () => {
  const store = new TraceStore(':memory:');
  const req = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-42',
    content: { text: 'Refunds must be processed quickly.' },
    provenance: human,
  });
  store.record({
    type: 'requirement',
    sourceRef: 'PROJ-99',
    content: { text: 'Unrelated requirement.' },
    provenance: human,
  });

  const found = store.bySourceRef(['PROJ-42', 'src/never-seen.ts']);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, req.id);
});

test('bySourceRef returns [] for an empty ref list instead of throwing', () => {
  const store = new TraceStore(':memory:');
  // `IN ()` is a SQLite syntax error, so the guard is load-bearing.
  assert.deepEqual(store.bySourceRef([]), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/release.test.ts`
Expected: FAIL with `store.bySourceRef is not a function`

- [ ] **Step 3: Write minimal implementation**

In `src/trace/store.ts`, add immediately after the `list()` method:

```ts
  /**
   * Artifacts whose sourceRef is one of `refs` — the join between "what this release
   * changed" and what the spine knows, since every artifact already carries the ref it
   * came from. Matching is exact equality.
   *
   * ponytail: exact match only, no prefix or glob. A caller must pass both file paths and
   * ticket keys. If path-shaped refs ever need to reach their requirement on their own,
   * add prefix matching or a published path->requirement map.
   */
  bySourceRef(refs: string[]): Artifact[] {
    // `IN ()` is a syntax error in SQLite, not an empty result set.
    if (!refs.length) return [];
    const holes = refs.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM artifacts WHERE source_ref IN (${holes}) ORDER BY created_at`)
      .all(...refs);
    return (rows as Row[]).map(toArtifact);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/release.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/trace/store.ts tests/release.test.ts
git commit -m "feat(trace): add bySourceRef to match artifacts to changed areas"
```

---

### Task 2: `assessReleaseRisk`

**Files:**
- Create: `src/release.ts`
- Test: `tests/release.test.ts` (append)

**Interfaces:**
- Consumes: `store.bySourceRef(refs)` (Task 1); existing `store.openFindings(limit, requirementId?)` and `store.chain(id)`.
- Produces:
  - `type RiskSignal = { kind: 'unresolved_finding_on_changed_area'; artifacts: string[]; detail: { findingId: string; requirementId: string; sourceRef: string | null; category: unknown; quote: unknown; question: unknown; confidence: unknown } }`
  - `assessReleaseRisk(store: TraceStore, input: { changed: string[]; releaseRef?: string }): { release: { ref: string | null; changed: string[] }; matched: { requirements: string[]; unmatched: string[] }; signals: RiskSignal[]; context: { nodes: Artifact[]; edges: Edge[] }; instructions: string }`

  Task 3 calls `assessReleaseRisk` and reads `.signals`. Task 4 wraps it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/release.test.ts`:

```ts
import { assessReleaseRisk } from '../src/release.ts';

/** The seed-demo shape: one requirement, one resolved finding, one open finding, a failing run. */
function seedRelease(store: TraceStore) {
  const req = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-42',
    content: { text: 'Refunds must be processed quickly and the customer notified appropriately.' },
    provenance: human,
  });
  const resolved = store.record({
    type: 'finding',
    sourceRef: 'PROJ-42',
    content: { category: 'AMB-VAGUE-QUANT', quote: 'quickly', question: 'How quick?', confidence: 'high' },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });
  const open = store.record({
    type: 'finding',
    sourceRef: 'PROJ-42',
    content: {
      category: 'AMB-UNTESTABLE',
      quote: 'notified appropriately',
      question: 'What happens when notification delivery fails?',
      confidence: 'unknown',
    },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });
  const testCase = store.record({
    type: 'test_case',
    sourceRef: 'tests/refund.spec.ts:14',
    content: { name: 'refund completes and emails the customer' },
    provenance: human,
    links: [
      { to: req.id, relation: 'covers' },
      { to: resolved.id, relation: 'supersedes' },
    ],
  });
  const run = store.record({
    type: 'test_run',
    sourceRef: 'ci/run/8812',
    content: { status: 'failed', message: 'timed out waiting for notification' },
    provenance: human,
    links: [{ to: testCase.id, relation: 'verifies' }],
  });
  return { req, resolved, open, testCase, run };
}

test('assessReleaseRisk signals an unresolved finding on a changed requirement', () => {
  const store = new TraceStore(':memory:');
  const { req, open } = seedRelease(store);

  const { signals } = assessReleaseRisk(store, { changed: ['PROJ-42'] });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, 'unresolved_finding_on_changed_area');
  assert.equal(signals[0].detail.findingId, open.id);
  assert.equal(signals[0].detail.requirementId, req.id);
  assert.equal(signals[0].detail.category, 'AMB-UNTESTABLE');
  assert.deepEqual(signals[0].artifacts, [open.id, req.id]);
});

test('assessReleaseRisk ignores a finding something has superseded', () => {
  const store = new TraceStore(':memory:');
  const { resolved } = seedRelease(store);

  const { signals } = assessReleaseRisk(store, { changed: ['PROJ-42'] });
  assert.ok(!signals.some((s) => s.detail.findingId === resolved.id));
});

test('assessReleaseRisk ignores an unresolved finding on a requirement that did not change', () => {
  const store = new TraceStore(':memory:');
  seedRelease(store);

  const { signals } = assessReleaseRisk(store, { changed: ['PROJ-99'] });
  assert.deepEqual(signals, []);
});

test('assessReleaseRisk reports refs that matched no artifact', () => {
  const store = new TraceStore(':memory:');
  seedRelease(store);

  const { matched } = assessReleaseRisk(store, { changed: ['PROJ-42', 'src/refund.ts'] });
  assert.deepEqual(matched.unmatched, ['src/refund.ts']);
  assert.equal(matched.requirements.length, 1);
});

test('assessReleaseRisk context includes the failing run reachable from a changed area', () => {
  const store = new TraceStore(':memory:');
  const { run } = seedRelease(store);

  const { context } = assessReleaseRisk(store, { changed: ['PROJ-42'] });
  const found = context.nodes.find((n) => n.id === run.id);
  assert.ok(found, 'failing test_run should arrive as unscored context');
  assert.equal(found.content.status, 'failed');
});

test('assessReleaseRisk rejects an empty changed list', () => {
  const store = new TraceStore(':memory:');
  assert.throws(() => assessReleaseRisk(store, { changed: [] }), /changed must not be empty/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/release.test.ts`
Expected: FAIL — cannot find module `../src/release.ts`

- [ ] **Step 3: Write minimal implementation**

Create `src/release.ts`:

```ts
import type { TraceStore } from './trace/store.ts';
import type { Artifact, Edge } from './trace/schema.ts';

const INSTRUCTIONS =
  'Write a one-page release brief, then record it with release_submit. Cite an artifact id ' +
  'for every claim you make and never invent one. Each signal is blocking: a `ship` verdict ' +
  'is rejected while any signal is present unless you pass an explicit override with a ' +
  'reason. `context` is unscored evidence — report failing test runs you find there, and ' +
  'report any `unmatched` ref, which is code that moved with no requirement covering it.';

/**
 * One unresolved requirement-stage question on something this release touched. Every signal
 * blocks; there is deliberately no `blocking` field, because it would be true on all of them.
 * Add one when a second, non-blocking signal kind exists.
 */
export type RiskSignal = {
  kind: 'unresolved_finding_on_changed_area';
  artifacts: string[];
  detail: {
    findingId: string;
    requirementId: string;
    sourceRef: string | null;
    category: unknown;
    quote: unknown;
    question: unknown;
    confidence: unknown;
  };
};

/**
 * Makes no model call. Like `auditRequirement`, this is a librarian: it computes the one
 * deterministic signal and hands over the surrounding evidence for the caller to reason over.
 *
 * Changed-ness is never inferred transitively. `chain()` walks both directions without bound,
 * so deriving it through edges would let one changed file mark every requirement in the store
 * as changed, and every release would block on everything.
 */
export function assessReleaseRisk(
  store: TraceStore,
  input: { changed: string[]; releaseRef?: string },
) {
  const changed = [...new Set(input.changed)];
  if (!changed.length) throw new Error('changed must not be empty');

  const matched = store.bySourceRef(changed);
  const matchedRefs = new Set(matched.map((a) => a.sourceRef));
  const unmatched = changed.filter((ref) => !matchedRefs.has(ref));
  const requirements = matched.filter((a) => a.type === 'requirement');

  // ponytail: one openFindings query per changed requirement. Fine for a release; batch into
  // a single query if a release ever touches hundreds of requirements.
  const signals: RiskSignal[] = requirements.flatMap((req) =>
    store.openFindings(500, req.id).map((f) => ({
      kind: 'unresolved_finding_on_changed_area' as const,
      artifacts: [f.id, req.id],
      detail: {
        findingId: f.id,
        requirementId: req.id,
        sourceRef: req.sourceRef,
        category: f.content.category ?? null,
        quote: f.content.quote ?? null,
        question: f.content.question ?? null,
        confidence: f.content.confidence ?? null,
      },
    })),
  );

  // ponytail: merges whole chain() results, which on a densely linked store could be a large
  // subgraph. Bound the walk by depth if that becomes a problem.
  const nodes = new Map<string, Artifact>();
  const edges = new Map<string, Edge>();
  for (const artifact of matched) {
    const chain = store.chain(artifact.id);
    if (!chain) continue;
    for (const node of chain.nodes) nodes.set(node.id, node);
    for (const e of chain.edges) {
      edges.set(`${e.fromArtifactId}>${e.toArtifactId}:${e.relation}`, e);
    }
  }

  return {
    release: { ref: input.releaseRef ?? null, changed },
    matched: { requirements: requirements.map((r) => r.id), unmatched },
    signals,
    context: { nodes: [...nodes.values()], edges: [...edges.values()] },
    instructions: INSTRUCTIONS,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/release.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/release.ts tests/release.test.ts
git commit -m "feat(release): add assessReleaseRisk to surface unresolved findings on changed areas"
```

---

### Task 3: `recordVerdict` and the ship veto

**Files:**
- Modify: `src/release.ts` (append)
- Test: `tests/release.test.ts` (append)

**Interfaces:**
- Consumes: `assessReleaseRisk` (Task 2); existing `store.get(id)` and `store.record(input)`.
- Produces: `recordVerdict(store: TraceStore, input: { releaseRef: string; verdict: 'ship' | 'hold'; reason: string; cites: string[]; changed: string[]; override?: { reason: string }; provenance: Provenance }): Artifact`. Task 4 wraps it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/release.test.ts`. Note the import line at the top of the file must become
`import { assessReleaseRisk, recordVerdict } from '../src/release.ts';`

```ts
test('recordVerdict records a hold with a derived_from edge to every cited artifact', () => {
  const store = new TraceStore(':memory:');
  const { req, open } = seedRelease(store);

  const verdict = recordVerdict(store, {
    releaseRef: 'release/2026.7.3',
    verdict: 'hold',
    reason: 'PROJ-42 notification failure was flagged at requirement stage and never resolved.',
    cites: [open.id, req.id],
    changed: ['PROJ-42'],
    provenance: ai,
  });

  assert.equal(verdict.type, 'verdict');
  assert.equal(verdict.sourceRef, 'release/2026.7.3');
  assert.equal(verdict.content.verdict, 'hold');
  assert.deepEqual(verdict.content.changed, ['PROJ-42']);
  assert.equal(verdict.content.override, null);

  const targets = store.edgesFrom(verdict.id).map((e) => e.toArtifactId).sort();
  assert.deepEqual(targets, [open.id, req.id].sort());
});

test('recordVerdict rejects a blank reason and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'hold', reason: '   ',
      cites: [open.id], changed: ['PROJ-42'], provenance: ai,
    }),
    /reason must not be blank/,
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict rejects an unknown cited artifact and writes nothing', () => {
  const store = new TraceStore(':memory:');
  seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'hold', reason: 'because',
      cites: ['finding_deadbeef'], changed: ['PROJ-42'], provenance: ai,
    }),
    /cites unknown artifact finding_deadbeef/,
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict refuses to ship while a signal is live, and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);
  const before = store.list(undefined, 1e9).length;

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'ship', reason: 'looks fine to me',
      cites: [open.id], changed: ['PROJ-42'], provenance: ai,
    }),
    new RegExp(`cannot ship: 1 unresolved finding\\(s\\).*${open.id}`),
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('recordVerdict allows a ship with an override and records the reason', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);

  const verdict = recordVerdict(store, {
    releaseRef: 'release/1',
    verdict: 'ship',
    reason: 'Hotfix. The open question is cosmetic and tracked separately.',
    cites: [open.id],
    changed: ['PROJ-42'],
    override: { reason: 'hotfix, accepted by release manager' },
    provenance: ai,
  });

  assert.equal(verdict.content.verdict, 'ship');
  assert.deepEqual(verdict.content.override, { reason: 'hotfix, accepted by release manager' });
});

test('recordVerdict rejects an override supplied with a hold verdict', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);

  assert.throws(
    () => recordVerdict(store, {
      releaseRef: 'release/1', verdict: 'hold', reason: 'holding',
      cites: [open.id], changed: ['PROJ-42'],
      override: { reason: 'pointless here' }, provenance: ai,
    }),
    /override is only meaningful with a ship verdict/,
  );
});

test('recordVerdict allows a ship when no signal is live', () => {
  const store = new TraceStore(':memory:');
  const { req, open } = seedRelease(store);
  store.record({
    type: 'answer',
    content: { text: 'Retry twice, then raise a defect and alert on-call.' },
    provenance: human,
    links: [
      { to: open.id, relation: 'supersedes' },
      { to: req.id, relation: 'derived_from' },
    ],
  });

  const verdict = recordVerdict(store, {
    releaseRef: 'release/1', verdict: 'ship', reason: 'All requirement questions answered.',
    cites: [req.id], changed: ['PROJ-42'], provenance: ai,
  });
  assert.equal(verdict.content.verdict, 'ship');
});

test('recordVerdict preserves AI provenance and does not override promptVersion', () => {
  const store = new TraceStore(':memory:');
  const { req, open } = seedRelease(store);

  const verdict = recordVerdict(store, {
    releaseRef: 'release/1', verdict: 'hold', reason: 'holding',
    cites: [open.id, req.id], changed: ['PROJ-42'],
    provenance: { producer: 'ai', model: 'claude-opus-5', promptVersion: 'release-brief/7' },
  });

  assert.equal(verdict.provenance.model, 'claude-opus-5');
  assert.equal(verdict.provenance.promptVersion, 'release-brief/7');
});

test('recordVerdict deduplicates cites so a repeated id is not an edge conflict', () => {
  const store = new TraceStore(':memory:');
  const { open } = seedRelease(store);

  const verdict = recordVerdict(store, {
    releaseRef: 'release/1', verdict: 'hold', reason: 'holding',
    cites: [open.id, open.id], changed: ['PROJ-42'], provenance: ai,
  });
  assert.equal(store.edgesFrom(verdict.id).length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/release.test.ts`
Expected: FAIL — `recordVerdict` is not exported

- [ ] **Step 3: Write minimal implementation**

Append to `src/release.ts`, and add `Provenance` to the existing type import so the first
line reads `import type { Artifact, Edge, Provenance } from './trace/schema.ts';`

```ts
/**
 * Records a release verdict, refusing a `ship` while any signal is live.
 *
 * The signals are recomputed here from `changed` and are never taken from the caller. An
 * agent that supplied its own signal list could wave a release through by omitting the
 * blocker, which is precisely what this phase exists to prevent — so the cost is that
 * `changed` must be passed again after `assess_release_risk`.
 *
 * ponytail: the override is unstructured free text and is not gated on `approvedBy`. Anyone
 * who can call this can ship over a blocker by supplying a reason. Visibility, not
 * prevention — the same trade-off as an AI answer resolving a finding in phase 2.5. Upgrade
 * path: require `provenance.approvedBy` before an override counts.
 */
export function recordVerdict(
  store: TraceStore,
  input: {
    releaseRef: string;
    verdict: 'ship' | 'hold';
    reason: string;
    cites: string[];
    changed: string[];
    override?: { reason: string };
    provenance: Provenance;
  },
): Artifact {
  const reason = input.reason.trim();
  if (!reason) throw new Error('reason must not be blank');

  const cites = [...new Set(input.cites)];
  for (const id of cites) {
    if (!store.get(id)) throw new Error(`cites unknown artifact ${id}`);
  }

  const overrideReason = input.override?.reason.trim();
  const override = overrideReason ? { reason: overrideReason } : null;
  if (override && input.verdict === 'hold') {
    throw new Error('override is only meaningful with a ship verdict');
  }

  const { signals } = assessReleaseRisk(store, { changed: input.changed });
  if (input.verdict === 'ship' && signals.length && !override) {
    const named = signals
      .map((s) => `${s.detail.findingId} (${s.detail.sourceRef ?? 'no sourceRef'})`)
      .join(', ');
    throw new Error(
      `cannot ship: ${signals.length} unresolved finding(s) on changed areas: ${named} — ` +
        'answer them with audit_answer, or pass override with a reason',
    );
  }

  return store.record({
    type: 'verdict',
    sourceRef: input.releaseRef,
    content: { verdict: input.verdict, reason, changed: [...new Set(input.changed)], override },
    provenance: input.provenance,
    links: cites.map((to) => ({ to, relation: 'derived_from' as const })),
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/release.test.ts`
Expected: PASS, 17 tests

- [ ] **Step 5: Commit**

```bash
git add src/release.ts tests/release.test.ts
git commit -m "feat(release): add recordVerdict, refusing a ship while a signal is live"
```

---

### Task 4: MCP tools

**Files:**
- Modify: `src/server.ts` (import at line 15, register after the `audit_answer` block ending line 176)

**Interfaces:**
- Consumes: `assessReleaseRisk` and `recordVerdict` (Tasks 2 and 3); existing `json()` and `fail()` helpers.
- Produces: MCP tools `assess_release_risk` and `release_submit`.

- [ ] **Step 1: Add the import**

In `src/server.ts`, after the existing `./audit.ts` import block, add:

```ts
import { assessReleaseRisk, recordVerdict } from './release.ts';
```

- [ ] **Step 2: Register both tools**

Insert after the `audit_answer` registration and before `return server;`:

```ts
  server.registerTool(
    'assess_release_risk',
    {
      description:
        'Given the areas a release touches, return every unresolved requirement-stage finding ' +
        'on those areas, plus the surrounding artifacts as unscored evidence. Makes no model ' +
        'call: reason over what it returns, then record your brief with `release_submit`. ' +
        'Every signal blocks a ship verdict.',
      inputSchema: {
        changed: z
          .array(z.string())
          .min(1)
          .describe('sourceRefs this release touches — JIRA keys and file paths. Matched exactly.'),
        releaseRef: z
          .string()
          .optional()
          .describe('e.g. release/2026.7.3. Becomes the verdict sourceRef on submit.'),
      },
    },
    (args) => {
      try {
        return json(assessReleaseRisk(store, args));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'release_submit',
    {
      description:
        'Record a release verdict. Signals are recomputed from `changed` and are never taken ' +
        'from the caller, so a `ship` cannot be waved through by omitting a blocker: it is ' +
        'rejected while any signal is live unless `override` gives a reason, which is recorded. ' +
        'Every id in `cites` must exist. Your provenance is recorded as given.',
      inputSchema: {
        releaseRef: z.string().describe('e.g. release/2026.7.3.'),
        verdict: z.enum(['ship', 'hold']),
        reason: z.string().describe('The one-page brief. Blank is rejected.'),
        cites: z
          .array(z.string())
          .describe('Artifact ids the brief refers to. Each becomes a derived_from edge.'),
        changed: z
          .array(z.string())
          .min(1)
          .describe('The same list passed to assess_release_risk. Signals are recomputed from it.'),
        override: z
          .object({ reason: z.string() })
          .optional()
          .describe('Required to ship while a signal is live. Recorded on the verdict.'),
        provenance: ProvenanceInput.describe('Who decided. AI must give `model` and `promptVersion`.'),
      },
    },
    (args) => {
      try {
        return json(recordVerdict(store, args));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
```

- [ ] **Step 3: Verify the whole suite and the build**

Run: `npm test && npm run build`
Expected: all tests PASS, `tsc` exits clean

- [ ] **Step 4: Verify the tools are actually registered**

Run:
```bash
node -e "
import('./src/server.ts').then(async (m) => {
  const { TraceStore } = await import('./src/trace/store.ts');
  const s = m.createServer(new TraceStore(':memory:'));
  console.log(Object.keys(s._registeredTools ?? {}));
});"
```
Expected: output includes `assess_release_risk` and `release_submit`. If `_registeredTools` is
undefined on this SDK version, fall back to confirming `npm run build` is clean and move on —
the functions are already covered by Task 2 and 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(release): expose assess_release_risk and release_submit as MCP tools"
```

---

### Task 5: Jira importer

**Files:**
- Create: `examples/import-jira.ts`

**Interfaces:**
- Consumes: `TraceStore` only. Nothing in `src/` consumes this.
- Produces: nothing importable — a CLI script.

**No test.** It requires network and credentials, and tests must stay hermetic. `seed-demo.ts`
is untested for the same reason. The check it leaves behind is that it prints a count.

- [ ] **Step 1: Write the script**

Create `examples/import-jira.ts`:

```ts
// Imports JIRA issues as requirements, so the ambiguity audit has real text to work on
// instead of hand-written fixtures.
//
//   JIRA_SITE=yourteam.atlassian.net JIRA_EMAIL=you@example.com JIRA_TOKEN=... \
//     node examples/import-jira.ts 'project = PROJ AND fixVersion = "2026.7.3"'
//
// Credentials are read from the environment and never written to disk. Nothing in src/
// knows what Jira is — this is a loader, not a feature.
import { mkdirSync } from 'node:fs';
import { TraceStore } from '../src/trace/store.ts';

const { JIRA_SITE, JIRA_EMAIL, JIRA_TOKEN } = process.env;
if (!JIRA_SITE || !JIRA_EMAIL || !JIRA_TOKEN) {
  console.error('set JIRA_SITE, JIRA_EMAIL and JIRA_TOKEN in the environment');
  process.exit(1);
}
const jql = process.argv[2];
if (!jql) {
  console.error('usage: node examples/import-jira.ts "<jql>"');
  process.exit(1);
}

const path = process.env.QA_SPINE_DB ?? '.qa-spine/trace.db';
mkdirSync(path.replace(/\/[^/]+$/, ''), { recursive: true });
const store = new TraceStore(path);

// v2, not v3: v3 returns `description` as Atlassian Document Format JSON, which would feed
// structural noise to the ambiguity rubric. v2 returns a plain string.
//
// ponytail: one page, maxResults=50, no pagination. Enough to audit a release. If you need
// more, follow `startAt` until `total` is reached. Atlassian has also been migrating
// /search to /search/jql — if this 404s or 410s, that is the line to change.
const url =
  `https://${JIRA_SITE}/rest/api/2/search` +
  `?jql=${encodeURIComponent(jql)}&maxResults=50&fields=summary,description`;

const res = await fetch(url, {
  headers: {
    authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64')}`,
    accept: 'application/json',
  },
});
if (!res.ok) {
  console.error(`jira ${res.status}: ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}

let imported = 0;
let skipped = 0;
for (const issue of (await res.json()).issues ?? []) {
  const text = String(issue.fields?.description ?? '').trim();
  // audit_requirement rejects blank text anyway; skipping keeps the store honest.
  if (!text) {
    skipped++;
    continue;
  }
  store.record({
    type: 'requirement',
    sourceRef: issue.key,
    content: { text, summary: issue.fields?.summary ?? '' },
    provenance: { producer: 'human' },
  });
  imported++;
}

console.error(
  `imported ${imported} requirement(s) into ${path}; skipped ${skipped} with no description`,
);
```

- [ ] **Step 2: Verify it type-checks and fails cleanly without credentials**

Run: `npm run build && env -u JIRA_SITE -u JIRA_EMAIL -u JIRA_TOKEN node examples/import-jira.ts 'x'`
Expected: build clean; script prints `set JIRA_SITE, JIRA_EMAIL and JIRA_TOKEN in the environment` and exits 1.

- [ ] **Step 3: Commit**

```bash
git add examples/import-jira.ts
git commit -m "feat(examples): add a throwaway Jira importer for real requirement text"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md` — tool table, roadmap, and a new phase 3 section

**Interfaces:** none.

- [ ] **Step 1: Add both tools to the tool table**

Append two rows after the `audit_answer` row:

```markdown
| `assess_release_risk` | Given the areas a release touches, returns every unresolved requirement-stage finding on them, plus surrounding artifacts as unscored evidence. Makes no model call. |
| `release_submit` | Records a release verdict. Recomputes the signals itself and refuses a `ship` while one is live, unless given an explicit `override` reason. |
```

- [ ] **Step 2: Update the roadmap**

Replace the phase 3 bullet with:

```markdown
- **Phase 3 — `assess_release_risk`.** One-page release brief with a verdict, surfacing a
  requirement-stage finding that was never resolved and touches a changed area. Done.
```

And update the status line near the top to read:

```markdown
**Status: Phases 1, 1.5, 2, 2.5 and 3 complete.** The trace spine, the Inspector, the ambiguity
audit, the queue for answering what it finds, and the release brief that refuses to ship over
an unanswered question.
```

- [ ] **Step 3: Add a release-risk section after "Rubrics"**

```markdown
## Release risk

`assess_release_risk` takes the list of sourceRefs a release touches — JIRA keys, file paths —
and returns every unresolved finding on the requirements among them, together with the
artifacts around them as unscored evidence. It makes no model call; the calling agent writes
the brief.

Matching is exact `sourceRef` equality and changed-ness is never inferred transitively, so the
caller must pass both file paths and ticket keys. The alternative — walking edges to decide
what "changed" — lets one changed file mark every requirement in the store as changed.

`release_submit` records the verdict, and **recomputes the signals itself rather than trusting
the ones the caller was given.** A `ship` while an unresolved finding is live is rejected
unless the call carries `override: { reason }`, which is recorded on the verdict. So "we
shipped over an open question, and this is the reason given" is a fact in the store rather
than something somebody remembers.

Nothing prevents an agent from writing its own override, exactly as nothing prevents it from
answering its own audit questions. Provenance is the safeguard: the verdict records the model
that produced it, and the override sits in plain text beside it.

Real ticket text, instead of hand-written fixtures:

```bash
JIRA_SITE=yourteam.atlassian.net JIRA_EMAIL=you@example.com JIRA_TOKEN=... \
  node examples/import-jira.ts 'project = PROJ AND fixVersion = "2026.7.3"'
```

That script is a loader in `examples/`, not a feature. Nothing in `src/` knows what Jira is,
and the server still makes no network call of its own.
```

- [ ] **Step 4: Verify the full suite once more**

Run: `npm test && npm run build`
Expected: all PASS, build clean

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document assess_release_risk, release_submit and the Jira importer"
```

---

## Self-Review

**Spec coverage:**

| Spec item | Task |
| --- | --- |
| `store.bySourceRef`, empty-list guard | 1 |
| `assessReleaseRisk`, signals, unmatched, context | 2 |
| No `blocking` field on a signal | 2 |
| `recordVerdict`, 4 validation rules, ship veto, override | 3 |
| Signals recomputed, never caller-supplied | 3 |
| `promptVersion` not overridden | 3 (test) |
| MCP tools | 4 |
| `examples/import-jira.ts`, v2 endpoint | 5 |
| All 16 spec tests | 1 (2), 2 (6), 3 (9) = 17, one extra for cites dedup |
| 5 `ponytail:` ceilings | 1, 2 (×2), 3, 5 |
| No Inspector change | — (correctly absent) |

**Type consistency:** `RiskSignal.detail.findingId` / `.sourceRef` are used identically in Task 2's construction, Task 3's error message, and Task 2's tests. `recordVerdict` input matches the Task 4 `inputSchema` field for field.

**One deviation from the spec, deliberate:** the spec lists 16 tests; this plan has 17. The
extra one covers duplicate ids in `cites`, which would otherwise hit the
`PRIMARY KEY (from_id, to_id, relation)` constraint on the edges table and surface as an
opaque SQLite error. The dedup and its test are in Task 3.
