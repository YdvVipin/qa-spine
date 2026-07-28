# Phase 2 — `audit_requirement` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a published ambiguity rubric and two MCP tools that turn a requirement into recorded, rubric-validated findings — each carrying a question for a human.

**Architecture:** `audit_requirement` hands the requirement and the rubric to the calling agent (Claude Code does not implement MCP sampling, so the server cannot call a model itself). The agent reasons, then calls `audit_submit`, which validates every finding against the rubric — rule id must exist, quote must appear verbatim in the requirement — before writing any of them. All audit logic lives in one module of plain functions; the MCP tools are thin wrappers, so the tests exercise the functions directly.

**Tech Stack:** TypeScript on Node ≥ 22.5, `node:test`, `node:sqlite` via the existing `TraceStore`, Zod 4, `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-07-28-phase-2-audit-requirement-design.md`
**Visual brief:** https://claude.ai/code/artifact/3a78ae05-6fde-470a-a883-d675b28a54b4

## Global Constraints

- **No new dependencies.** Runtime deps stay exactly `@modelcontextprotocol/sdk` and `zod`. The rubric is JSON precisely so that no YAML parser is needed.
- **Node ≥ 22.5**, `"type": "module"`, TS run directly via node's type stripping — imports of local files carry the `.ts` extension (e.g. `./trace/store.ts`). Follow the existing import style exactly.
- **The store is append-only.** Nothing may be updated or deleted. A rejected submission must write *nothing at all* — validate the whole batch before recording any of it.
- **Findings emit questions, never rewrites.** Do not add a `suggestedRewrite` field, even though `examples/seed-demo.ts` has one.
- **Finding content field names are fixed by existing data:** `{ category, quote, question, confidence }`, with `confidence` a **string** (`'high' | 'medium' | 'low' | 'unknown'`), never a number. `category` holds the rubric rule id.
- **`promptVersion` is authored by the server** from the loaded rubric's `version`, overriding whatever the caller supplied.
- **Error messages name the offending value.** The consumer is a model that must correct and retry.
- **Git:** this repo currently has **zero commits** and all files are untracked. The commit steps below assume the user has made an initial commit first; if they have not, stage only the files each task names.

---

### Task 1: The rubric, its schema, and the `answer` artifact type

**Files:**
- Create: `rubrics/ambiguity.json`
- Create: `src/audit.ts`
- Modify: `src/trace/schema.ts` (the `ArtifactType` enum, around line 4)
- Test: `tests/audit.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Rubric` and `RubricRule` Zod schemas and inferred types; `rubricsDir(): string`; `loadRubric(name?: string): Rubric` where `Rubric = { version: string; rules: RubricRule[] }` and `RubricRule = { id: string; name: string; test?: string; triggers?: string[]; ask: string }`. Adds `'answer'` to `ArtifactType`.

- [ ] **Step 1: Write the failing test**

Create `tests/audit.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRubric } from '../src/audit.ts';
import { ArtifactType } from '../src/trace/schema.ts';

test('the shipped ambiguity rubric loads and validates', () => {
  const rubric = loadRubric();
  assert.equal(rubric.version, 'ambiguity/1');
  assert.ok(rubric.rules.length >= 4, 'ships at least four rules');

  const ids = rubric.rules.map((r) => r.id);
  assert.ok(ids.includes('AMB-VAGUE-QUANT'));
  assert.equal(new Set(ids).size, ids.length, 'rule ids are unique');
  for (const rule of rubric.rules) {
    assert.ok(rule.ask.length > 0, `${rule.id} has a question to ask`);
  }
});

test('a missing rubric fails with the path it looked in', () => {
  assert.throws(() => loadRubric('no-such-rubric'), /no-such-rubric/);
});

test('answer is a recordable artifact type', () => {
  assert.equal(ArtifactType.parse('answer'), 'answer');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/audit.ts'`

- [ ] **Step 3: Create the rubric file**

Create `rubrics/ambiguity.json`:

```json
{
  "version": "ambiguity/1",
  "rules": [
    {
      "id": "AMB-VAGUE-QUANT",
      "name": "Unquantified adjective",
      "test": "A degree adjective with no measurable threshold.",
      "triggers": ["fast", "quick", "quickly", "scalable", "robust", "intuitive", "seamless"],
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
      "test": "A list left deliberately incomplete.",
      "triggers": ["etc", "and so on", "including but not limited to", "such as"],
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

- [ ] **Step 4: Add the `answer` type**

In `src/trace/schema.ts`, extend the `ArtifactType` enum. It currently ends with `'verdict'` then the commented `'review'` entry — add `answer` alongside, keeping the existing comment style:

```ts
export const ArtifactType = z.enum([
  'requirement',
  'finding',
  'test_case',
  'test_run',
  'defect',
  'verdict',
  /** A human's thumbs up/down on an AI artifact, captured by the Inspector. */
  'review',
  /** A human's reply to a finding's question. Supersedes the finding it answers. */
  'answer',
]);
```

- [ ] **Step 5: Write the rubric loader**

Create `src/audit.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * A rubric is published, versioned data — the thing a team argues about in review.
 * `triggers` are advisory hints for the model, not patterns the server runs: a rule
 * can fire legitimately on a synonym nobody listed.
 */
export const RubricRule = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  test: z.string().optional(),
  triggers: z.array(z.string()).optional(),
  ask: z.string().min(1),
});

export const Rubric = z.object({
  version: z.string().min(1),
  rules: z.array(RubricRule).min(1),
});

export type RubricRule = z.infer<typeof RubricRule>;
export type Rubric = z.infer<typeof Rubric>;

/** Resolves from source and from a built `dist` alike: both sit one level under the package root. */
export function rubricsDir(): string {
  return process.env.QA_SPINE_RUBRICS
    ? resolve(process.env.QA_SPINE_RUBRICS)
    : resolve(import.meta.dirname, '..', 'rubrics');
}

/**
 * Read at tool-call time rather than at startup, so a malformed rubric cannot stop the
 * trace tools from working.
 */
export function loadRubric(name = 'ambiguity'): Rubric {
  const path = resolve(rubricsDir(), `${name}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`rubric unreadable at ${path}: ${err instanceof Error ? err.message : err}`);
  }
  const parsed = Rubric.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`rubric ${name} failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all three new tests, plus the existing 15.

- [ ] **Step 7: Commit**

```bash
git add rubrics/ambiguity.json src/audit.ts src/trace/schema.ts tests/audit.test.ts
git commit -m "feat(audit): publish ambiguity rubric and add answer artifact type"
```

---

### Task 2: `auditRequirement` — hand over the requirement and the rubric

**Files:**
- Modify: `src/audit.ts`
- Test: `tests/audit.test.ts`

**Interfaces:**
- Consumes: `loadRubric()` and the `Rubric` type from Task 1.
- Produces: `auditRequirement(store: TraceStore, requirementId: string)` returning `{ requirement: { id: string; sourceRef: string | null; text: string }, rubric: Rubric, instructions: string }`. Also the internal helper `requirementFor(store, id)` returning that same `requirement` shape, which Task 3 reuses.

- [ ] **Step 1: Write the failing test**

Append to `tests/audit.test.ts`. Extend the existing `../src/audit.ts` import rather than
adding a second one — it should read `import { loadRubric, auditRequirement } from '../src/audit.ts';`
— and add the store import at the top:

```ts
import { TraceStore } from '../src/trace/store.ts';

const REQ_TEXT = 'The dashboard should load quickly, and users are notified when it fails.';

function seedRequirement(store: TraceStore) {
  return store.record({
    type: 'requirement',
    sourceRef: 'PROJ-114',
    content: { text: REQ_TEXT },
    provenance: { producer: 'human' },
  });
}

test('audit_requirement returns the requirement text and the rubric', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);

  const result = auditRequirement(store, req.id);

  assert.equal(result.requirement.id, req.id);
  assert.equal(result.requirement.sourceRef, 'PROJ-114');
  assert.equal(result.requirement.text, REQ_TEXT);
  assert.equal(result.rubric.version, 'ambiguity/1');
  assert.match(result.instructions, /verbatim/i, 'tells the model the quote is checked');
});

test('audit_requirement rejects an unknown id', () => {
  const store = new TraceStore(':memory:');
  assert.throws(() => auditRequirement(store, 'nope_123'), /no artifact with id nope_123/);
});

test('audit_requirement rejects an artifact that is not a requirement', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);
  const finding = store.record({
    type: 'finding',
    content: { category: 'vague_qualifier', quote: 'quickly', confidence: 'high' },
    provenance: { producer: 'ai', model: 'claude-opus-5', promptVersion: 'ambiguity/1' },
    links: [{ to: req.id, relation: 'derived_from' }],
  });

  assert.throws(() => auditRequirement(store, finding.id), /is a finding, not a requirement/);
});

test('audit_requirement rejects a requirement with no text', () => {
  const store = new TraceStore(':memory:');
  const empty = store.record({
    type: 'requirement',
    content: { note: 'no text field here' },
    provenance: { producer: 'human' },
  });

  assert.throws(() => auditRequirement(store, empty.id), /has no content\.text to audit/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `auditRequirement is not a function` / not exported.

- [ ] **Step 3: Implement it**

Add to `src/audit.ts` — the imports go at the top with the others, the rest at the end of the file:

```ts
import type { TraceStore } from './trace/store.ts';
```

```ts
const INSTRUCTIONS =
  'For each rule that fires, return { category, quote, question, confidence }. ' +
  '`category` must be a rule id from this rubric. `quote` must be copied verbatim from the ' +
  'requirement text — it is checked on submit, and a quote that is not present rejects the ' +
  'whole submission. `question` is for a human to answer: never return a rewritten ' +
  'requirement. `confidence` is one of high, medium, low, unknown. Submit with audit_submit.';

/** Loads a requirement and proves it is auditable. Shared by both audit tools. */
function requirementFor(store: TraceStore, id: string) {
  const artifact = store.get(id);
  if (!artifact) throw new Error(`no artifact with id ${id}`);
  if (artifact.type !== 'requirement') {
    throw new Error(`artifact ${id} is a ${artifact.type}, not a requirement`);
  }
  const text = artifact.content.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`requirement ${id} has no content.text to audit`);
  }
  return { id: artifact.id, sourceRef: artifact.sourceRef, text };
}

/**
 * Makes no model call. This tool is a librarian: it hands over the text and the rules.
 *
 * ponytail: returns the whole rubric on every call. Fine at four rules; if rubrics grow
 * past what is comfortable in a tool result, return only rules whose triggers appear.
 */
export function auditRequirement(store: TraceStore, requirementId: string) {
  return {
    requirement: requirementFor(store, requirementId),
    rubric: loadRubric(),
    instructions: INSTRUCTIONS,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — four new tests green, nothing else broken.

- [ ] **Step 5: Commit**

```bash
git add src/audit.ts tests/audit.test.ts
git commit -m "feat(audit): add audit_requirement to hand over requirement and rubric"
```

---

### Task 3: `submitFindings` — the validation gate

**Files:**
- Modify: `src/audit.ts`
- Test: `tests/audit.test.ts`

**Interfaces:**
- Consumes: `requirementFor()`, `loadRubric()` from Tasks 1–2.
- Produces: `AuditFinding` Zod schema and inferred type `{ category: string; quote: string; question: string; confidence: 'high'|'medium'|'low'|'unknown'; severity?: 'high'|'medium'|'low' }`; and `submitFindings(store: TraceStore, input: { requirementId: string; findings: AuditFinding[]; provenance: Provenance }): Artifact[]`. Task 4 wires both into MCP tools.

- [ ] **Step 1: Write the failing test**

Append to `tests/audit.test.ts`. Again extend the existing import, which should now read
`import { loadRubric, auditRequirement, submitFindings, type AuditFinding } from '../src/audit.ts';`

```ts
const ai = { producer: 'ai' as const, model: 'claude-opus-5', promptVersion: 'caller-supplied' };

const vagueFinding = (over: Partial<AuditFinding> = {}): AuditFinding => ({
  category: 'AMB-VAGUE-QUANT',
  quote: 'load quickly',
  question: 'What p95 load time counts as "quickly", and on what connection?',
  confidence: 'high',
  ...over,
});

const countArtifacts = (store: TraceStore) => store.list(undefined, 1e9).length;

test('audit_submit records findings linked back to the requirement', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);

  const written = submitFindings(store, {
    requirementId: req.id,
    findings: [vagueFinding(), vagueFinding({ category: 'AMB-MISSING-ACTOR', quote: 'are notified' })],
    provenance: ai,
  });

  assert.equal(written.length, 2);
  assert.equal(written[0].type, 'finding');
  assert.equal(written[0].sourceRef, 'PROJ-114', 'inherits the requirement sourceRef');
  assert.equal(written[0].content.category, 'AMB-VAGUE-QUANT');
  assert.equal(written[0].content.confidence, 'high', 'confidence stays a string');

  const chain = store.chain(req.id);
  assert.ok(chain);
  const ids = chain.nodes.map((n) => n.id);
  assert.ok(written.every((f) => ids.includes(f.id)), 'both findings are in the chain');
  assert.ok(
    chain.edges.some((e) => e.fromArtifactId === written[0].id && e.toArtifactId === req.id && e.relation === 'derived_from'),
  );
});

test('audit_submit stamps promptVersion from the rubric, ignoring the caller', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);

  const [finding] = submitFindings(store, {
    requirementId: req.id,
    findings: [vagueFinding()],
    provenance: ai,
  });

  assert.equal(finding.provenance.promptVersion, 'ambiguity/1');
  assert.equal(finding.provenance.model, 'claude-opus-5', 'model is still the caller’s');
});

test('audit_submit rejects an unknown rule id and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);
  const before = countArtifacts(store);

  assert.throws(
    () => submitFindings(store, { requirementId: req.id, findings: [vagueFinding({ category: 'AMB-TYPO' })], provenance: ai }),
    /unknown rule "AMB-TYPO"/,
  );
  assert.equal(countArtifacts(store), before, 'store untouched');
});

test('audit_submit rejects a quote absent from the requirement and writes nothing', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);
  const before = countArtifacts(store);

  assert.throws(
    () => submitFindings(store, { requirementId: req.id, findings: [vagueFinding({ quote: 'blazingly fast' })], provenance: ai }),
    /quote not found in requirement text: "blazingly fast"/,
  );
  assert.equal(countArtifacts(store), before, 'store untouched');
});

test('audit_submit is all-or-nothing when one finding of several is invalid', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);
  const before = countArtifacts(store);

  assert.throws(
    () =>
      submitFindings(store, {
        requirementId: req.id,
        findings: [vagueFinding(), vagueFinding({ quote: 'never written here' })],
        provenance: ai,
      }),
    /quote not found/,
  );
  assert.equal(countArtifacts(store), before, 'the valid finding was not written either');
});

test('audit_submit rejects an empty findings list', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);

  assert.throws(() => submitFindings(store, { requirementId: req.id, findings: [], provenance: ai }), /must not be empty/);
});

test('audit_submit still enforces the AI provenance rule', () => {
  const store = new TraceStore(':memory:');
  const req = seedRequirement(store);
  const before = countArtifacts(store);

  assert.throws(() =>
    submitFindings(store, {
      requirementId: req.id,
      findings: [vagueFinding()],
      // producer 'ai' with no model. This type-checks — `model` is optional on the object —
      // and is rejected at runtime by the refinement in schema.ts. No cast needed.
      provenance: { producer: 'ai' },
    }),
  );
  assert.equal(countArtifacts(store), before);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `submitFindings is not a function` / not exported.

- [ ] **Step 3: Implement it**

Add the import at the top of `src/audit.ts` alongside the existing ones:

```ts
import type { Artifact, Provenance } from './trace/schema.ts';
```

Then append:

```ts
/** The shape a finding must arrive in. Deliberately no `suggestedRewrite`: this phase asks, it does not rewrite. */
export const AuditFinding = z.object({
  category: z.string().min(1).describe('A rule id from the rubric returned by audit_requirement.'),
  quote: z.string().min(1).describe('Copied verbatim from the requirement text.'),
  question: z.string().min(1).describe('What a human needs to answer to remove the ambiguity.'),
  confidence: z.enum(['high', 'medium', 'low', 'unknown']),
  severity: z.enum(['high', 'medium', 'low']).optional(),
});
export type AuditFinding = z.infer<typeof AuditFinding>;

/**
 * Validates every finding before writing any of them. The store is append-only, so a
 * half-written batch could never be cleaned up — a partially valid submission must be
 * rejected whole.
 *
 * ponytail: re-auditing a requirement appends duplicate findings; there is no dedup.
 * Fine while audits are human-triggered one at a time. If that changes, skip findings
 * whose (category, quote) pair already exists on the requirement.
 */
export function submitFindings(
  store: TraceStore,
  input: { requirementId: string; findings: AuditFinding[]; provenance: Provenance },
): Artifact[] {
  const requirement = requirementFor(store, input.requirementId);
  if (!input.findings.length) throw new Error('findings must not be empty');

  const rubric = loadRubric();
  const ids = new Set(rubric.rules.map((r) => r.id));

  for (const f of input.findings) {
    if (!ids.has(f.category)) {
      throw new Error(
        `unknown rule "${f.category}" — rubric ${rubric.version} defines: ${[...ids].join(', ')}`,
      );
    }
    // The Inspector already runs this comparison at render time to flag a bad quote.
    // Running it at write time makes a hallucinated quote unrecordable instead.
    if (!requirement.text.includes(f.quote)) {
      throw new Error(`quote not found in requirement text: "${f.quote}"`);
    }
  }

  return input.findings.map((f) =>
    store.record({
      type: 'finding',
      sourceRef: requirement.sourceRef,
      content: { ...f },
      // promptVersion is the one provenance field the server can honestly author, and
      // it is what makes a rubric edit measurable against the exported review labels.
      provenance: { ...input.provenance, promptVersion: rubric.version },
      links: [{ to: requirement.id, relation: 'derived_from' }],
    }),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — seven new tests green.

- [ ] **Step 5: Commit**

```bash
git add src/audit.ts tests/audit.test.ts
git commit -m "feat(audit): validate findings against rubric and quote before recording"
```

---

### Task 4: Register the two MCP tools

**Files:**
- Modify: `src/server.ts` (add imports at the top; register tools inside `createServer`, after the existing `trace_query` registration around line 81)

**Interfaces:**
- Consumes: `auditRequirement()`, `submitFindings()`, `AuditFinding` from Tasks 2–3; the existing `json()` and `fail()` helpers in `src/server.ts`.
- Produces: MCP tools `audit_requirement` and `audit_submit`. No further task depends on these.

- [ ] **Step 1: Add the imports**

In `src/server.ts`, alongside the existing imports:

```ts
import { auditRequirement, submitFindings, AuditFinding } from './audit.ts';
```

- [ ] **Step 2: Register `audit_requirement`**

Inside `createServer`, after the `trace_query` registration and before `return server;`:

```ts
  server.registerTool(
    'audit_requirement',
    {
      description:
        'Load a requirement and the published ambiguity rubric. Returns both, plus instructions. ' +
        'This tool makes no model call: reason over what it returns, then record what you find ' +
        'with `audit_submit`. Emit questions for a human, never a rewritten requirement.',
      inputSchema: {
        requirementId: z.string().describe('The artifact id of the requirement to audit.'),
      },
    },
    ({ requirementId }) => {
      try {
        return json(auditRequirement(store, requirementId));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
```

- [ ] **Step 3: Register `audit_submit`**

Immediately after:

```ts
  server.registerTool(
    'audit_submit',
    {
      description:
        'Record ambiguity findings against a requirement. Every finding must cite a rule id from ' +
        'the rubric and quote the requirement verbatim; if any finding fails either check the ' +
        'whole submission is rejected and nothing is written. `promptVersion` is set by the ' +
        'server from the rubric version, not by the caller.',
      inputSchema: {
        requirementId: z.string(),
        findings: z.array(AuditFinding).min(1),
        provenance: ProvenanceInput.describe('Who produced these. AI must give `model`.'),
      },
    },
    (args) => {
      try {
        return json({ recorded: submitFindings(store, args).map((a) => a.id) });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
```

- [ ] **Step 4: Verify the build and the whole suite**

Run: `npm run build && npm test`
Expected: `tsc` exits clean, all tests pass (15 existing + 14 new).

- [ ] **Step 5: Smoke-test against the real store**

```bash
rm -rf .qa-spine
node examples/seed-demo.ts
node --input-type=module -e "
import { TraceStore } from './src/trace/store.ts';
import { auditRequirement, submitFindings } from './src/audit.ts';
const store = new TraceStore('.qa-spine/trace.db');
const req = store.list('requirement', 1).at(0);
const { requirement, rubric } = auditRequirement(store, req.id);
console.log('requirement:', requirement.text);
console.log('rules:', rubric.rules.map(r => r.id).join(', '));
const quote = requirement.text.split(' ').slice(0, 3).join(' ');
const [f] = submitFindings(store, {
  requirementId: req.id,
  findings: [{ category: 'AMB-VAGUE-QUANT', quote, question: 'Smoke test question?', confidence: 'unknown' }],
  provenance: { producer: 'ai', model: 'smoke-test', promptVersion: 'ignored' },
});
console.log('recorded:', f.id, 'promptVersion:', f.provenance.promptVersion);
"
npm run inspect
```

Expected: the recorded finding's `promptVersion` prints as `ambiguity/1`. In the Inspector at http://127.0.0.1:4700, the new finding appears in the list with its quote as the summary, and opening it highlights that quote inside the requirement text — with no Inspector code having changed. Then `rm -rf .qa-spine` to discard the smoke data.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat(audit): expose audit_requirement and audit_submit as MCP tools"
```

---

### Task 5: Document the phase

**Files:**
- Modify: `README.md` (the Tools table around line 37, the Roadmap around line 89, and the trace-store section's artifact list around line 76)

**Interfaces:**
- Consumes: the finished tools from Task 4.
- Produces: nothing code depends on.

- [ ] **Step 1: Add both tools to the Tools table**

Add two rows after the existing `trace_query` row:

```markdown
| `audit_requirement` | Returns a requirement plus the published ambiguity rubric, for the calling agent to reason over. Makes no model call. |
| `audit_submit` | Records ambiguity findings, rejecting any that cite an unknown rule or a quote absent from the requirement. |
```

- [ ] **Step 2: Add a rubric section**

After the "The trace store" section:

```markdown
## Rubrics

`rubrics/ambiguity.json` is published, versioned data — the thing a team argues about in
review rather than a prompt buried in the server. Its `version` is stamped onto every
finding as `promptVersion`, which is what makes "did that rubric edit help?" answerable
from the exported review labels instead of a matter of taste.

Point `QA_SPINE_RUBRICS` at your own directory to publish rubrics for your team.

The server never calls a model. `audit_requirement` hands the requirement and the rubric
to the calling agent; `audit_submit` takes what comes back and refuses anything that
cites an unknown rule or quotes text that is not in the requirement. A hallucinated quote
cannot enter the store.
```

- [ ] **Step 3: Update the artifact type list**

In "The trace store", the sentence listing artifact types currently reads
`requirement | finding | test_case | test_run | defect | verdict`. Add `answer`:

```markdown
Artifacts are `requirement | finding | test_case | test_run | defect | verdict | answer`.
```

- [ ] **Step 4: Update the status line and roadmap**

The status line near the top currently reads "**Status: Phases 1 and 1.5 complete.** The trace spine and the Inspector work. The agents that write into them do not exist yet." Replace with:

```markdown
**Status: Phases 1, 1.5 and 2 complete.** The trace spine, the Inspector, and the first
agent — an ambiguity audit against a published rubric — all work.
```

And in the Roadmap, mark phase 2 done and add 2.5:

```markdown
- **Phase 2 — `audit_requirement`.** Ambiguity audit against a published JSON rubric.
  Emits questions for a human, never rewritten requirements. Done.
- **Phase 2.5 — audit queue.** An Inspector view for answering those questions, where an
  answer supersedes the finding it resolves.
```

- [ ] **Step 5: Verify nothing regressed**

Run: `npm test && npm run build`
Expected: all tests pass, build clean.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document the audit tools, rubrics and phase 2 status"
```

---

## Done when

- `npm test` passes with 14 new tests covering both tools and every rejection path
- `npm run build` is clean
- A finding recorded by `audit_submit` renders in the Inspector — list summary, highlighted quote in the requirement, red in the chain view — with zero Inspector changes
- `rubrics/ambiguity.json` ships in the package (`files` in `package.json` already lists `rubrics`)

## Not in this plan

- **Phase 2.5, the audit queue UI.** Designed in the visual brief; needs its own spec and plan.
- **Dedup of repeated audits.** Marked with a `ponytail:` comment in `submitFindings`.
- **Any Inspector change.** Verified unnecessary — see the spec's trace table.
