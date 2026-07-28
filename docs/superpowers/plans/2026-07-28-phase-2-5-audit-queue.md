# Phase 2.5 — Audit Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every question phase 2 records a place to be answered, and make an answer retire the finding it resolves.

**Architecture:** Two new trace-layer queries (`edgesTo`, `openFindings`) answer "what is unresolved" in SQL. Two new plain functions in `src/audit.ts` (`openQuestions`, `recordAnswer`) carry all the logic. Those are exposed twice: as MCP tools for an agent, and as two Inspector endpoints behind a new `#/audit` view for a human. Resolution needs no new concept — the chain view already treats a finding as unresolved when nothing supersedes it, so an answer carrying a `supersedes` edge retires it for free.

**Tech Stack:** TypeScript on Node ≥ 22.5, `node:test`, `node:sqlite`, Zod 4, `@modelcontextprotocol/sdk`, vanilla DOM (no build step for UI).

**Spec:** `docs/superpowers/specs/2026-07-28-phase-2-5-audit-queue-design.md`

## Global Constraints

- **No new dependencies.** Runtime deps stay exactly `@modelcontextprotocol/sdk` and `zod`.
- **Node ≥ 22.5**, `"type": "module"`, TS run directly via node's type stripping. Local imports carry the `.ts` extension (e.g. `./trace/store.ts`).
- **The store is append-only.** A rejected call must write *nothing*. Validate fully before recording.
- **The answer artifact uses `content.text`**, never `content.answer` — `summarise()` in `app.js` checks `c.text` first, so answers render with no Inspector change.
- **`promptVersion` is NOT overridden** in `recordAnswer`. Unlike `audit_submit`, the server does not own an answer; the caller's provenance stands.
- **The Inspector's `POST /api/answer` hardcodes `provenance: { producer: 'human' }`** and must ignore any provenance in the request body. An agent answering uses the MCP tool.
- **The UI has no build step and no subdirectories.** `src/inspector/server.ts` rejects any static path containing `/`, so all UI code goes in the three existing files.
- **Error messages name the offending value.** The MCP consumer is a model that must correct and retry.
- **Git:** work on a branch off `main` (currently `a85eb87`). Stage only the files each task names — never `git add -A`. `.agent/` and `.superpowers/` are gitignored scratch and must never be committed.
- Commit messages end with: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

### Task 1: Trace-layer queries — `edgesTo` and `openFindings`

**Files:**
- Modify: `src/trace/store.ts` (`edgesFrom` is at lines 145-160; add beside it)
- Test: `tests/audit-queue.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `store.edgesTo(id: string): Edge[]` and `store.openFindings(limit?: number): Artifact[]`. Tasks 2 and 3 depend on both.

- [ ] **Step 1: Write the failing test**

Create `tests/audit-queue.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceStore } from '../src/trace/store.ts';

const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-opus-5', promptVersion: 'ambiguity/1' };

/** A requirement with one AI finding hanging off it — the shape phase 2 produces. */
function seed(store: TraceStore) {
  const req = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-114',
    content: { text: 'The dashboard should load quickly for all users.' },
    provenance: human,
  });
  const finding = store.record({
    type: 'finding',
    sourceRef: 'PROJ-114',
    content: {
      category: 'AMB-VAGUE-QUANT',
      quote: 'load quickly',
      question: 'What p95 counts as quickly?',
      confidence: 'high',
    },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });
  return { req, finding };
}

test('openFindings returns a finding nothing has superseded', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);

  const open = store.openFindings();
  assert.equal(open.length, 1);
  assert.equal(open[0].id, finding.id);
});

test('openFindings excludes a finding once something supersedes it', () => {
  const store = new TraceStore(':memory:');
  const { req, finding } = seed(store);

  store.record({
    type: 'answer',
    content: { text: 'p95 under 1.5s on 3G Fast.' },
    provenance: human,
    links: [
      { to: finding.id, relation: 'supersedes' },
      { to: req.id, relation: 'derived_from' },
    ],
  });

  assert.deepEqual(store.openFindings(), []);
});

test('openFindings ignores non-findings and non-supersedes edges', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);

  // A review points at the finding, but reviewing is not resolving.
  store.record({
    type: 'review',
    content: { verdict: 'good', note: '' },
    provenance: human,
    links: [{ to: finding.id, relation: 'reviews' }],
  });

  const open = store.openFindings();
  assert.equal(open.length, 1, 'a review must not retire a finding');
  assert.equal(open[0].id, finding.id);
  assert.ok(open.every((a) => a.type === 'finding'), 'only findings are ever returned');
});

test('edgesTo finds incoming edges that edgesFrom cannot see', () => {
  const store = new TraceStore(':memory:');
  const { req, finding } = seed(store);
  const answer = store.record({
    type: 'answer',
    content: { text: 'p95 under 1.5s on 3G Fast.' },
    provenance: human,
    links: [
      { to: finding.id, relation: 'supersedes' },
      { to: req.id, relation: 'derived_from' },
    ],
  });

  const incoming = store.edgesTo(finding.id);
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].fromArtifactId, answer.id);
  assert.equal(incoming[0].relation, 'supersedes');

  // The point of the method: the resolving edge is invisible from the finding's own side.
  assert.deepEqual(
    store.edgesFrom(finding.id).filter((e) => e.relation === 'supersedes'),
    [],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `store.openFindings is not a function`

- [ ] **Step 3: Refactor `edgesFrom` and add `edgesTo`**

In `src/trace/store.ts`, replace the existing `edgesFrom` method with a shared private helper plus the two public methods. The column name comes from a closed union of two literals, never from user input, so interpolating it into the SQL is safe:

```ts
  /** Shared by edgesFrom/edgesTo. `column` is a closed union, never caller input. */
  private edgesBy(column: 'from_id' | 'to_id', id: string): Edge[] {
    const rows = this.db.prepare(`SELECT * FROM edges WHERE ${column} = ?`).all(id) as {
      from_id: string;
      to_id: string;
      relation: string;
      created_at: string;
    }[];
    return rows.map((e) =>
      Edge.parse({
        fromArtifactId: e.from_id,
        toArtifactId: e.to_id,
        relation: e.relation,
        createdAt: e.created_at,
      }),
    );
  }

  edgesFrom(id: string): Edge[] {
    return this.edgesBy('from_id', id);
  }

  /** Incoming edges. What resolves a finding points AT it, so edgesFrom cannot find it. */
  edgesTo(id: string): Edge[] {
    return this.edgesBy('to_id', id);
  }
```

- [ ] **Step 4: Add `openFindings`**

Add after `list()`:

```ts
  /**
   * Findings nothing has superseded — the audit queue's worklist. Asked in SQL rather than
   * by listing every finding and filtering in JS, which would be right only at today's size.
   *
   * ponytail: `limit` is the only paging. A queue a human works down does not need more;
   * if one ever holds more open findings than this, it needs real paging, not a bigger number.
   */
  openFindings(limit = 500): Artifact[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM artifacts a
          WHERE a.type = 'finding'
            AND NOT EXISTS (
              SELECT 1 FROM edges e WHERE e.to_id = a.id AND e.relation = 'supersedes'
            )
          ORDER BY a.created_at DESC
          LIMIT ?`,
      )
      .all(limit);
    return (rows as Row[]).map(toArtifact);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 4 new tests, plus the 32 existing.

- [ ] **Step 6: Commit**

```bash
git add src/trace/store.ts tests/audit-queue.test.ts
git commit -m "feat(trace): add edgesTo and openFindings for the audit queue"
```

---

### Task 2: `openQuestions` — the worklist with its context

**Files:**
- Modify: `src/audit.ts` (append; the file ends at line 152 with `submitFindings`)
- Test: `tests/audit-queue.test.ts`

**Interfaces:**
- Consumes: `store.openFindings()`, `store.edgesFrom()` from Task 1.
- Produces: a non-exported helper `requirementOf(store, findingId): Artifact | undefined`, which Task 3 reuses; and `openQuestions(store: TraceStore, requirementId?: string)` returning `{ open: Array<{ findingId: string; category: unknown; quote: unknown; question: unknown; confidence: unknown; requirement: { id: string; sourceRef: string | null; text: string } | null }> }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/audit-queue.test.ts`, and add the import at the top of the file:

```ts
import { openQuestions } from '../src/audit.ts';
```

```ts
test('openQuestions attaches the requirement needed to answer', () => {
  const store = new TraceStore(':memory:');
  const { req, finding } = seed(store);

  const { open } = openQuestions(store);
  assert.equal(open.length, 1);
  assert.equal(open[0].findingId, finding.id);
  assert.equal(open[0].category, 'AMB-VAGUE-QUANT');
  assert.equal(open[0].quote, 'load quickly');
  assert.equal(open[0].question, 'What p95 counts as quickly?');
  assert.equal(open[0].confidence, 'high');
  assert.equal(open[0].requirement?.id, req.id);
  assert.equal(open[0].requirement?.sourceRef, 'PROJ-114');
  assert.match(open[0].requirement?.text ?? '', /load quickly/);
});

test('openQuestions filtered by requirementId excludes other requirements', () => {
  const store = new TraceStore(':memory:');
  const { req } = seed(store);

  const other = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-200',
    content: { text: 'Exports must be timely.' },
    provenance: human,
  });
  store.record({
    type: 'finding',
    content: {
      category: 'AMB-VAGUE-QUANT',
      quote: 'timely',
      question: 'How timely?',
      confidence: 'low',
    },
    provenance: ai,
    links: [{ to: other.id, relation: 'derived_from' }],
  });

  assert.equal(openQuestions(store).open.length, 2, 'unfiltered sees both');
  const mine = openQuestions(store, req.id).open;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].requirement?.id, req.id);
});

test('openQuestions keeps a parentless finding, with requirement null', () => {
  const store = new TraceStore(':memory:');
  const orphan = store.record({
    type: 'finding',
    content: {
      category: 'AMB-UNTESTABLE',
      quote: 'somehow',
      question: 'Observable how?',
      confidence: 'unknown',
    },
    provenance: ai,
  });

  const { open } = openQuestions(store);
  assert.equal(open.length, 1, 'a broken edge must not hide work');
  assert.equal(open[0].findingId, orphan.id);
  assert.equal(open[0].requirement, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `openQuestions is not a function` / not exported.

- [ ] **Step 3: Implement it**

Append to `src/audit.ts`:

```ts
/** The requirement a finding came from, if that edge is intact. */
function requirementOf(store: TraceStore, findingId: string): Artifact | undefined {
  return store
    .edgesFrom(findingId)
    .filter((e) => e.relation === 'derived_from')
    .map((e) => store.get(e.toArtifactId))
    .find((a) => a?.type === 'requirement');
}

/**
 * Every question still waiting on an answer, each carrying enough of its requirement to be
 * answered without a second call. A finding whose parent requirement is missing still
 * appears, with `requirement: null` — a broken edge must not hide work from the queue.
 */
export function openQuestions(store: TraceStore, requirementId?: string) {
  const open = store.openFindings().map((f) => {
    const parent = requirementOf(store, f.id);
    return {
      findingId: f.id,
      category: f.content.category ?? null,
      quote: f.content.quote ?? null,
      question: f.content.question ?? null,
      confidence: f.content.confidence ?? null,
      requirement: parent
        ? { id: parent.id, sourceRef: parent.sourceRef, text: String(parent.content.text ?? '') }
        : null,
    };
  });
  return { open: requirementId ? open.filter((q) => q.requirement?.id === requirementId) : open };
}
```

`Artifact` is already imported as a type in `src/audit.ts` (from Task 3 of phase 2); confirm the import line reads `import type { Artifact, Provenance } from './trace/schema.ts';` and leave it alone if so.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 3 new tests green.

- [ ] **Step 5: Commit**

```bash
git add src/audit.ts tests/audit-queue.test.ts
git commit -m "feat(audit): add openQuestions to list unanswered findings"
```

---

### Task 3: `recordAnswer` — answering retires the finding

**Files:**
- Modify: `src/audit.ts`
- Test: `tests/audit-queue.test.ts`

**Interfaces:**
- Consumes: `requirementOf()` from Task 2; `store.edgesTo()` from Task 1.
- Produces: `recordAnswer(store: TraceStore, input: { findingId: string; answer: string; provenance: Provenance }): Artifact`. Tasks 4 and 5 both call it.

- [ ] **Step 1: Write the failing test**

Append to `tests/audit-queue.test.ts`. Extend the existing `../src/audit.ts` import so it reads `import { openQuestions, recordAnswer } from '../src/audit.ts';` — do not add a second import statement from the same module.

```ts
const countArtifacts = (store: TraceStore) => store.list(undefined, 1e9).length;

test('recordAnswer links to both the finding and the requirement, and closes the question', () => {
  const store = new TraceStore(':memory:');
  const { req, finding } = seed(store);

  const answer = recordAnswer(store, {
    findingId: finding.id,
    answer: 'p95 under 1.5s on 3G Fast, at first contentful paint.',
    provenance: human,
  });

  assert.equal(answer.type, 'answer');
  assert.equal(answer.content.text, 'p95 under 1.5s on 3G Fast, at first contentful paint.');
  assert.equal(answer.sourceRef, 'PROJ-114');

  const edges = store.edgesFrom(answer.id);
  assert.ok(
    edges.some((e) => e.toArtifactId === finding.id && e.relation === 'supersedes'),
    'supersedes the finding',
  );
  assert.ok(
    edges.some((e) => e.toArtifactId === req.id && e.relation === 'derived_from'),
    'derived from the requirement',
  );
  assert.deepEqual(openQuestions(store).open, [], 'the question leaves the queue');
});

test('an answered finding reads as resolved through chain()', () => {
  const store = new TraceStore(':memory:');
  const { req, finding } = seed(store);
  recordAnswer(store, { findingId: finding.id, answer: 'Under 1.5s.', provenance: human });

  const chain = store.chain(req.id);
  assert.ok(chain);
  // This is exactly the test the chain view runs to decide whether to render a finding red.
  const stillUnresolved = !chain.edges.some(
    (e) => e.toArtifactId === finding.id && e.relation === 'supersedes',
  );
  assert.equal(stillUnresolved, false, 'the chain view will now render it resolved');
});

test('recordAnswer rejects a blank or whitespace-only answer and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const before = countArtifacts(store);

  assert.throws(
    () => recordAnswer(store, { findingId: finding.id, answer: '', provenance: human }),
    /answer must not be blank/,
  );
  assert.throws(
    () => recordAnswer(store, { findingId: finding.id, answer: '   \n ', provenance: human }),
    /answer must not be blank/,
  );
  assert.equal(countArtifacts(store), before, 'store untouched');
});

test('recordAnswer rejects an id that is not a finding, and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const { req } = seed(store);
  const before = countArtifacts(store);

  assert.throws(
    () => recordAnswer(store, { findingId: req.id, answer: 'Under 1.5s.', provenance: human }),
    /is a requirement, not a finding/,
  );
  assert.throws(
    () => recordAnswer(store, { findingId: 'nope_123', answer: 'Under 1.5s.', provenance: human }),
    /no artifact with id nope_123/,
  );
  assert.equal(countArtifacts(store), before, 'store untouched');
});

test('recordAnswer refuses to double-answer, naming the answer to supersede', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const first = recordAnswer(store, {
    findingId: finding.id,
    answer: 'Under 1.5s.',
    provenance: human,
  });
  const before = countArtifacts(store);

  assert.throws(
    () => recordAnswer(store, { findingId: finding.id, answer: 'Actually 2s.', provenance: human }),
    new RegExp(`already resolved by ${first.id}`),
  );
  assert.equal(countArtifacts(store), before, 'store untouched');
});

test('recordAnswer keeps AI provenance exactly as given', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);

  const answer = recordAnswer(store, {
    findingId: finding.id,
    answer: 'p95 under 1.5s.',
    provenance: { producer: 'ai', model: 'claude-opus-5', promptVersion: 'answer/1' },
  });

  assert.equal(answer.provenance.producer, 'ai');
  assert.equal(answer.provenance.model, 'claude-opus-5');
  // Unlike audit_submit, the server does not own an answer and must not restamp this.
  assert.equal(answer.provenance.promptVersion, 'answer/1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `recordAnswer is not a function` / not exported.

- [ ] **Step 3: Implement it**

Append to `src/audit.ts`:

```ts
/**
 * Records a human's or an agent's answer to an open question. The `supersedes` edge is what
 * retires the finding — the chain view already treats a finding with nothing superseding it
 * as unresolved, so this needs no new concept.
 *
 * Provenance is recorded exactly as given. Unlike `submitFindings`, the server does not own
 * this artifact and has no rubric version to stamp: an AI answer stays visibly an AI answer.
 */
export function recordAnswer(
  store: TraceStore,
  input: { findingId: string; answer: string; provenance: Provenance },
): Artifact {
  const finding = store.get(input.findingId);
  if (!finding) throw new Error(`no artifact with id ${input.findingId}`);
  if (finding.type !== 'finding') {
    throw new Error(`artifact ${input.findingId} is a ${finding.type}, not a finding`);
  }

  const answer = input.answer.trim();
  if (!answer) throw new Error('answer must not be blank');

  const resolver = store.edgesTo(input.findingId).find((e) => e.relation === 'supersedes');
  if (resolver) {
    throw new Error(
      `finding ${input.findingId} is already resolved by ${resolver.fromArtifactId} — ` +
        'supersede that answer instead of adding another',
    );
  }

  const requirement = requirementOf(store, input.findingId);
  return store.record({
    type: 'answer',
    sourceRef: requirement?.sourceRef ?? finding.sourceRef,
    content: { text: answer },
    provenance: input.provenance,
    links: [
      { to: input.findingId, relation: 'supersedes' },
      // A finding without a parent requirement is still answerable.
      ...(requirement ? [{ to: requirement.id, relation: 'derived_from' as const }] : []),
    ],
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 6 new tests green, 45 total.

- [ ] **Step 5: Commit**

```bash
git add src/audit.ts tests/audit-queue.test.ts
git commit -m "feat(audit): add recordAnswer so an answer retires its finding"
```

---

### Task 4: MCP tools — `audit_open` and `audit_answer`

**Files:**
- Modify: `src/server.ts` (extend the `./audit.ts` import at line 9; register tools inside `createServer` after `audit_submit`, before `return server;`)

**Interfaces:**
- Consumes: `openQuestions()`, `recordAnswer()` from Tasks 2-3; the existing `json()`, `fail()` helpers and the already-imported `z` and `ProvenanceInput`.
- Produces: MCP tools `audit_open`, `audit_answer`. Nothing later depends on these.

- [ ] **Step 1: Extend the import**

`src/server.ts` line 9 currently reads:

```ts
import { auditRequirement, submitFindings, AuditFinding } from './audit.ts';
```

Change it to:

```ts
import {
  auditRequirement,
  submitFindings,
  AuditFinding,
  openQuestions,
  recordAnswer,
} from './audit.ts';
```

- [ ] **Step 2: Register `audit_open`**

Inside `createServer`, after the `audit_submit` registration and before `return server;`:

```ts
  server.registerTool(
    'audit_open',
    {
      description:
        'List ambiguity questions still waiting on an answer. Each carries the rule it came ' +
        'from, the quoted span, and the requirement text needed to answer it, so no second ' +
        'call is required. Omit requirementId for everything outstanding.',
      inputSchema: {
        requirementId: z.string().optional().describe('Limit to one requirement.'),
      },
    },
    ({ requirementId }) => {
      try {
        return json(openQuestions(store, requirementId));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
```

- [ ] **Step 3: Register `audit_answer`**

Immediately after:

```ts
  server.registerTool(
    'audit_answer',
    {
      description:
        'Answer an open ambiguity question. The answer supersedes the finding, which retires ' +
        'it. Rejects a blank answer, an id that is not a finding, and a finding something has ' +
        'already resolved. Your provenance is recorded as given and is not rewritten: an ' +
        'answer produced by AI stays visibly an AI answer.',
      inputSchema: {
        findingId: z.string().describe('The finding whose question you are answering.'),
        answer: z.string().describe('The answer, in full. Blank answers are rejected.'),
        provenance: ProvenanceInput.describe(
          'Who is answering. AI must give `model` and `promptVersion`.',
        ),
      },
    },
    (args) => {
      try {
        return json(recordAnswer(store, args));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
```

- [ ] **Step 4: Verify build and suite**

Run: `npm run build && npm test`
Expected: tsc clean, 45 tests passing.

- [ ] **Step 5: Verify the tools convert to valid JSON Schema**

Registering a tool does not validate its schema — the SDK converts lazily on `tools/list`, so tsc passing proves nothing. Check it live:

```bash
node --input-type=module -e "
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TraceStore } from './src/trace/store.ts';
import { createServer } from './src/server.ts';
const [a, b] = InMemoryTransport.createLinkedPair();
const server = createServer(new TraceStore(':memory:'));
const client = new Client({ name: 'check', version: '0' }, { capabilities: {} });
await Promise.all([server.connect(a), client.connect(b)]);
const { tools } = await client.listTools();
console.log(tools.map((t) => t.name).join(', '));
console.log(JSON.stringify(tools.find((t) => t.name === 'audit_answer').inputSchema, null, 2));
await client.close();
"
```

Expected: the list includes `audit_open` and `audit_answer`, and `audit_answer`'s schema shows `findingId`, `answer` and `provenance` as plain JSON Schema with no `$ref` or effects artifacts. Paste the real output into your report.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat(audit): expose audit_open and audit_answer as MCP tools"
```

---

### Task 5: Inspector endpoints — `GET /api/open`, `POST /api/answer`

**Files:**
- Modify: `src/inspector/server.ts` (add the import; add both handlers after the `/api/review` handler which ends around line 55)
- Test: `tests/audit-queue.test.ts`

**Interfaces:**
- Consumes: `openQuestions()`, `recordAnswer()` from Tasks 2-3; the existing `send()` and `text()` helpers in `src/inspector/server.ts`.
- Produces: two HTTP endpoints. Task 6's UI calls both.

- [ ] **Step 1: Write the failing test**

Append to `tests/audit-queue.test.ts`. Extend the existing `node:test` import to bring in the
type — `tests/inspector.test.ts` already does exactly this, so match it — and add two new
import lines:

```ts
import { test, type TestContext } from 'node:test';   // extend the existing line
import type { AddressInfo } from 'node:net';          // new
import { createInspector } from '../src/inspector/server.ts';  // new
```

Do not add a second `import { ... } from 'node:test'` statement.

```ts
/** Boots the inspector on an ephemeral port and hands back a fetch bound to it. */
async function serve(store: TraceStore, t: TestContext) {
  const server = createInspector(store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return (path: string, init?: RequestInit) => fetch(base + path, init);
}

const postAnswer = (api: (p: string, i?: RequestInit) => Promise<Response>, body: unknown) =>
  api('/api/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('GET /api/open lists the queue and shrinks when a question is answered', async (t) => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const api = await serve(store, t);

  const before = await (await api('/api/open')).json();
  assert.equal(before.open.length, 1);
  assert.equal(before.open[0].findingId, finding.id);

  const res = await postAnswer(api, { findingId: finding.id, answer: 'Under 1.5s.' });
  assert.equal(res.status, 200);

  const after = await (await api('/api/open')).json();
  assert.deepEqual(after.open, [], 'answering removes it from the queue');
});

test('POST /api/answer always records human provenance, whatever the body claims', async (t) => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const api = await serve(store, t);

  const res = await postAnswer(api, {
    findingId: finding.id,
    answer: 'Under 1.5s.',
    // The Inspector must ignore this: its writes are human by definition.
    provenance: { producer: 'ai', model: 'sneaky', promptVersion: 'x' },
  });

  const answer = await res.json();
  assert.equal(answer.provenance.producer, 'human');
  assert.equal(answer.provenance.model, undefined);
});

test('POST /api/answer rejects a blank answer with 400 and writes nothing', async (t) => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const api = await serve(store, t);
  const before = countArtifacts(store);

  const res = await postAnswer(api, { findingId: finding.id, answer: '  ' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /answer must not be blank/);
  assert.equal(countArtifacts(store), before, 'store untouched');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `/api/open` falls through to the static handler and 404s, so `before.open` is undefined.

- [ ] **Step 3: Add the import**

In `src/inspector/server.ts`, alongside the existing imports:

```ts
import { openQuestions, recordAnswer } from '../audit.ts';
```

- [ ] **Step 4: Add both handlers**

After the `/api/review` handler, before the `if (req.method === 'GET')` static-file branch:

```ts
      if (req.method === 'GET' && url.pathname === '/api/open') {
        return send(200, openQuestions(store));
      }

      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const body = JSON.parse(await text(req));
        try {
          // Provenance is hardcoded, not read from the body: everything the Inspector writes
          // is a human act. An agent that wants to answer uses the audit_answer MCP tool,
          // where its own provenance is recorded and stays visible.
          return send(
            200,
            recordAnswer(store, {
              findingId: String(body.findingId ?? ''),
              answer: String(body.answer ?? ''),
              provenance: { producer: 'human' },
            }),
          );
        } catch (err) {
          return send(400, { error: err instanceof Error ? err.message : String(err) });
        }
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 3 new tests, 48 total.

- [ ] **Step 6: Commit**

```bash
git add src/inspector/server.ts tests/audit-queue.test.ts
git commit -m "feat(inspector): add /api/open and /api/answer endpoints"
```

---

### Task 6: The `#/audit` view and the AI-answer treatment

**Files:**
- Modify: `src/inspector/ui/app.js` (add the view before the routing section at the end; change `route()`; one change in `chainView`'s node builder around line 256)
- Modify: `src/inspector/ui/style.css` (append a queue section)
- Modify: `src/inspector/ui/index.html` (one nav link)

**Interfaces:**
- Consumes: `GET /api/open` and `POST /api/answer` from Task 5; the existing `h()`, `get()`, `ago()`, `summarise()` helpers in `app.js`.
- Produces: the `#/audit` route. Nothing later depends on it.

- [ ] **Step 1: Add the audit view**

In `src/inspector/ui/app.js`, insert before the `// ------ routing` section:

```js
// --------------------------------------------------------------- audit queue

/** One open question: the rule that fired, the quote in context, and a box to answer it. */
function questionCard(q) {
  const box = h('textarea', { placeholder: 'answer…', rows: 2 });
  const status = h('span', { className: 'said' });

  const submit = async () => {
    const res = await fetch('/api/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ findingId: q.findingId, answer: box.value }),
    });
    if (res.ok) return route(); // answered questions leave the queue
    status.textContent = (await res.json()).error ?? 'failed';
    status.className = 'said verdict-bad';
  };

  // Show the quote inside its surrounding text, so a mis-quote is as obvious here as in
  // the detail view. Windowed to 40 characters either side to keep cards scannable.
  const text = q.requirement?.text ?? '';
  const at = q.quote ? text.indexOf(q.quote) : -1;
  const context =
    at === -1
      ? h('span', { className: 'flag' }, q.quote ? `⚠ "${q.quote}" not found in source` : '—')
      : h(
          'span',
          {},
          (at > 40 ? '…' : '') + text.slice(Math.max(0, at - 40), at),
          h('mark', {}, q.quote),
          text.slice(at + q.quote.length, at + q.quote.length + 40),
        );

  return h(
    'div',
    { className: 'q' },
    h(
      'div',
      { className: 'q-top' },
      h('span', { className: 'q-rule' }, q.category ?? '—'),
      h('span', {}, `conf ${q.confidence ?? '—'}`),
      h('a', { className: 'q-src', href: `#/a/${q.findingId}` },
        q.requirement?.sourceRef ?? q.findingId),
    ),
    h('div', { className: 'q-quote' }, context),
    h('div', { className: 'q-ask' }, q.question ?? ''),
    h('div', { className: 'q-answer' },
      box,
      h('button', { className: 'good', textContent: 'Record answer', onclick: submit }),
      status),
  );
}

/** An answered question. Producer and model are shown because that is the only safeguard
    against an agent quietly answering its own audit. */
function answeredCard(a) {
  const p = a.provenance;
  return h(
    'div',
    { className: 'q done' },
    h(
      'div',
      { className: 'q-top' },
      h('span', { className: 'producer-' + p.producer }, p.producer),
      p.model ? h('span', {}, p.model) : null,
      h('a', { className: 'q-src', href: `#/a/${a.id}` }, a.sourceRef ?? a.id),
      h('span', {}, ago(a.createdAt)),
    ),
    h('div', { className: 'q-ask' }, summarise(a)),
  );
}

async function auditView(show) {
  const showing = show === 'answered' ? 'answered' : 'open';
  const filters = h(
    'div',
    { className: 'filters' },
    ['open', 'answered'].map((f) =>
      h('button', {
        textContent: f,
        ariaPressed: String(showing === f),
        onclick: () => (location.hash = `#/audit?show=${f}`),
      }),
    ),
  );

  if (showing === 'answered') {
    const { artifacts } = await get('/api/artifacts?type=answer');
    crumbs.replaceChildren(`${artifacts.length} answered`);
    return view.replaceChildren(
      filters,
      artifacts.length
        ? h('div', { className: 'queue' }, artifacts.map(answeredCard))
        : h('p', { className: 'empty' }, 'Nothing answered yet.'),
    );
  }

  const { open } = await get('/api/open');
  crumbs.replaceChildren(`${open.length} question${open.length === 1 ? '' : 's'} open`);
  view.replaceChildren(
    filters,
    open.length
      ? h('div', { className: 'queue' }, open.map(questionCard))
      : h('p', { className: 'empty' }, 'Nothing to answer.'),
  );
}
```

- [ ] **Step 2: Route to it**

Replace the existing `route()` function body. The `#/audit` check must come before the `listView` fallthrough, which otherwise swallows every unmatched hash:

```js
function route() {
  const query = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const [, path, id] = location.hash.match(/^#\/(a|c)\/(.+)$/) ?? [];
  if (path === 'a') return detailView(decodeURIComponent(id));
  if (path === 'c') return chainView(decodeURIComponent(id));
  if (location.hash.startsWith('#/audit')) return auditView(query.get('show'));
  return listView(query.get('type'));
}
```

- [ ] **Step 3: Mark AI answers in the chain view**

In `chainView`, the node builder currently computes `unresolved` then builds `className`. Add the AI-answer flag alongside it:

```js
          const unresolved =
            n.type === 'finding' &&
            !edges.some((e) => e.toArtifactId === n.id && e.relation === 'supersedes');
          // An answer produced by AI is marked in the graph, not just in its detail panel:
          // an agent resolving its own audit finding should be visible at a glance.
          const aiAnswer = n.type === 'answer' && n.provenance.producer === 'ai';
          const card = h(
            'a',
            {
              className:
                'node' +
                (n.id === chain.root.id ? ' root' : '') +
                (unresolved ? ' unresolved' : '') +
                (aiAnswer ? ' ai-answer' : ''),
              href: `#/a/${n.id}`,
            },
```

Leave the rest of the node builder unchanged.

- [ ] **Step 4: Add a nav link**

In `src/inspector/ui/index.html`, the header currently holds the brand link and `<nav id="crumbs">`. Add an audit link between them:

```html
      <a href="#/audit" class="navlink">audit</a>
```

- [ ] **Step 5: Add the styles**

Append to `src/inspector/ui/style.css`, before the `/* --- motion --- */` section so the existing transition rules still apply to the new buttons:

```css
/* --- audit queue --- */
.navlink { color: var(--dim); }
.navlink:hover { color: var(--accent); }
.queue { display: flex; flex-direction: column; gap: 0.75rem; }
.q {
  background: var(--panel);
  border: 1px solid var(--line);
  border-left: 3px solid #e0af68;
  border-radius: 5px;
  padding: 0.65rem 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.q.done { border-left-color: var(--good); }
.q-top { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: baseline; font-size: 12px; color: var(--dim); }
.q-rule { color: #e0af68; }
.q-src { margin-left: auto; }
.q-quote { font-size: 13px; color: var(--dim); border-left: 2px solid var(--line); padding-left: 0.6rem; overflow-wrap: anywhere; }
.q-ask { line-height: 1.5; }
.q-answer { display: flex; gap: 0.5rem; align-items: stretch; flex-wrap: wrap; }
.q-answer textarea {
  flex: 1 1 18rem;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0.5rem;
  font: inherit;
  resize: vertical;
}
.q-answer button {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--fg);
  padding: 0.4rem 0.9rem;
  cursor: pointer;
  font: inherit;
}
.q-answer button:hover { border-color: var(--good); color: var(--good); }
.node.ai-answer { border-left-color: var(--ai); }
```

- [ ] **Step 6: Verify by driving the real UI**

There is no automated test for this view; verify it by hand against a real store.

```bash
rm -rf .qa-spine && node examples/seed-demo.ts
npm run inspect
```

In the browser at http://127.0.0.1:4700 confirm, and report what you actually saw:

1. `#/audit` lists the seeded demo's unresolved findings, each with its rule, quote highlighted in context, and question
2. Typing an answer and pressing "Record answer" makes that card disappear from the open list
3. The `answered` filter shows it, with producer `human`
4. Answering every question leaves "Nothing to answer."
5. `#/c/<a requirement id>` shows the previously-red finding no longer red, with an `answer` node beside it
6. Posting an answer via the MCP path instead — use the node snippet below — and reloading the chain shows that answer's card with a purple (`--ai`) left border:

```bash
node --input-type=module -e "
import { TraceStore } from './src/trace/store.ts';
import { openQuestions, recordAnswer } from './src/audit.ts';
const store = new TraceStore('.qa-spine/trace.db');
const q = openQuestions(store).open[0];
if (!q) { console.log('nothing open — answer fewer in the UI first'); process.exit(0); }
const a = recordAnswer(store, { findingId: q.findingId, answer: 'Answered by an agent.',
  provenance: { producer: 'ai', model: 'claude-opus-5', promptVersion: 'answer/1' } });
console.log('recorded', a.id, a.provenance.producer);
"
```

Then stop the server and `rm -rf .qa-spine`. Leave no process running and no stray files.

- [ ] **Step 7: Confirm nothing regressed**

Run: `npm test && npm run build`
Expected: 48 tests passing, tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/inspector/ui/app.js src/inspector/ui/style.css src/inspector/ui/index.html
git commit -m "feat(inspector): add the audit queue view and mark AI answers in the chain"
```

---

### Task 7: Document the phase

**Files:**
- Modify: `README.md` (Tools table, the Rubrics section, the Inspector section's three-view list, Roadmap, status line)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code depends on.

- [ ] **Step 1: Add both tools to the Tools table**

After the `audit_submit` row:

```markdown
| `audit_open` | Lists ambiguity questions still waiting on an answer, each with the requirement text needed to answer it. |
| `audit_answer` | Records an answer. The answer supersedes the finding, which retires it. |
```

- [ ] **Step 2: Update the Inspector's view list**

The Inspector section describes "Three views". Change that word to "Four views" and add a fourth bullet after the chain-view bullet:

```markdown
- **Audit queue** — every question phase 2 raised that nobody has answered, with the quote
  shown in context and a box to answer it. Answering appends an `answer` that supersedes the
  finding, so the chain view stops showing it red. The empty state is the goal.
```

- [ ] **Step 3: Note who answered**

Add to the Rubrics section, after the paragraph ending "A hallucinated quote cannot enter the store.":

```markdown
An agent can answer its own audit questions through `audit_answer`, and nothing prevents it.
Provenance is the safeguard rather than a lock: the queue shows the producer and model of
every answered question, and an AI-authored answer is drawn in the chain view in the colour
used for AI artifacts. If you need approval before an AI answer counts as resolving a
finding, the `approvedBy` field on every artifact's provenance is the place to build it.
```

- [ ] **Step 4: Update status line and roadmap**

The status line reads "**Status: Phases 1, 1.5 and 2 complete.**…". Replace with:

```markdown
**Status: Phases 1, 1.5, 2 and 2.5 complete.** The trace spine, the Inspector, the ambiguity
audit, and the queue for answering what it finds.
```

In the Roadmap, replace the phase 2.5 entry with:

```markdown
- **Phase 2.5 — audit queue.** An Inspector view and two MCP tools for answering those
  questions, where an answer supersedes the finding it resolves. Done.
```

- [ ] **Step 5: Re-read the whole README for contradictions**

Read it top to bottom. The edits above touch four separate places, and a status line that disagrees with the roadmap, or a view count that disagrees with the bullet list, is exactly the kind of thing this step exists to catch. Report anything inconsistent rather than silently rewriting prose this task did not ask you to touch.

- [ ] **Step 6: Verify nothing regressed**

Run: `npm test && npm run build`
Expected: 48 tests passing, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: document the audit queue and how AI answers are surfaced"
```

---

## Done when

- `npm test` passes with 16 new tests (48 total); `npm run build` clean
- `#/audit` lists open questions, answering one removes it, and the empty state reads "Nothing to answer."
- An answered finding stops rendering red in the chain view, with no change to that view's resolution logic
- An AI-authored answer is visually distinct in both the queue and the chain view
- `audit_open` and `audit_answer` appear in `tools/list` with valid plain JSON Schema

## Not in this plan

- **Approval gating of AI answers.** The `approvedBy` / `approvedAt` fields exist and stay unused; the README names them as the upgrade path.
- **Editing or retracting an answer.** Append-only: supersede the answer.
- **Grouping or paging the queue.** Marked with `ponytail:` comments on `openFindings`.
- **Phase 3 (`assess_release_risk`)**, which this phase unblocks.
