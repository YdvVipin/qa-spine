# Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make qa-spine usable by someone who installs it from npm and has never seen the repo — a demo that shows the product in one command, and an `init` that does the three things the code cannot do for itself.

**Architecture:** Two subcommands beside the existing ones in `src/server.ts`. The demo's seeding lives in its own module so tests can drive it without starting a blocking server, and its verdict goes through the real `recordVerdict` so the demo is subject to the product's own rules.

**Tech Stack:** TypeScript, Node >= 22.5, `node:sqlite`, `node:test`. No new dependencies.

## Global Constraints

- **No new dependencies.** Only `@modelcontextprotocol/sdk` and `zod` are permitted in `src/`.
- **Neither new command touches the user's store.** Not `.qa-spine/trace.db`, not a configured `QA_SPINE_DB` path, and not even the *directory* — see Task 1's guard.
- **`demo` deletes exactly one path** — `<tmpdir>/qa-spine-demo.db` — which it owns and names. Nothing else, ever.
- **`init` never clobbers.** An existing `rubrics/ambiguity.json` is left alone and reported.
- **The demo's verdict goes through `recordVerdict`**, never a raw `store.record`. That is what makes `liveFindings` real and subjects the demo's own prose to the lint.
- **Both commands print for a human**, on stdout, with errors on stderr and exit 1 — unlike `record` and the audit subcommands, whose caller parses one JSON object.
- The store is append-only. Never `UPDATE` or `DELETE`.
- Deliberate shortcuts get a `ponytail:` comment naming the ceiling and the upgrade path.
- **The repo's own `.qa-spine/trace.db` holds exactly 8 artifacts and must still hold 8.** Any manual run sets `QA_SPINE_DB` under `/tmp`, as an env var before the command.
- Spec: `docs/superpowers/specs/2026-08-07-packaging-design.md`

## File Structure

| File | Responsibility |
| --- | --- |
| `src/server.ts` (modify) | The `init` and `demo` cases, plus the store-directory guard. |
| `src/demo.ts` (create) | `seedDemo` and `runDemo` — the arc, and the seed-plus-brief step. |
| `tests/cli-init-demo.test.ts` (create) | All tests for both commands. |
| `README.md` (modify) | Install-first quickstart. |
| `examples/seed-demo.ts` (delete) | Superseded; writes pre-phase-2 data. |

---

### Task 1: `init`, and stop creating the store directory for commands that do not need one

**Files:**
- Modify: `src/server.ts` — imports, the guard above the switch (around line 296), a new case
- Create: `tests/cli-init-demo.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the `init` CLI contract. Task 3 documents it.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli-init-demo.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = process.cwd();

/** Runs a subcommand from a scratch cwd so nothing touches the repo. */
function run(args: string[], cwd: string): { code: number; out: string; err: string } {
  try {
    const out = execFileSync('node', [resolve(REPO, 'src/server.ts'), ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, QA_SPINE_DB: join(cwd, 'should-never-appear.db') },
    });
    return { code: 0, out, err: '' };
  } catch (err: any) {
    return { code: err.status ?? 1, out: err.stdout ?? '', err: err.stderr ?? '' };
  }
}

function withScratch(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-init-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('init copies the rubric into the project', () => {
  withScratch((dir) => {
    const { code } = run(['init'], dir);
    assert.equal(code, 0);

    const copied = join(dir, 'rubrics', 'ambiguity.json');
    assert.ok(existsSync(copied), 'rubric should be copied');
    const rubric = JSON.parse(readFileSync(copied, 'utf8'));
    assert.ok(rubric.version, 'the copy must be a usable rubric, not an empty file');
    assert.ok(Array.isArray(rubric.rules) && rubric.rules.length > 0);
  });
});

test('init does not clobber an existing rubric', () => {
  withScratch((dir) => {
    mkdirSync(join(dir, 'rubrics'), { recursive: true });
    writeFileSync(join(dir, 'rubrics', 'ambiguity.json'), '{"version":"mine/1","rules":[]}');

    const { code, out } = run(['init'], dir);
    assert.equal(code, 0);
    assert.match(out, /already exists/);

    const after = JSON.parse(readFileSync(join(dir, 'rubrics', 'ambiguity.json'), 'utf8'));
    assert.equal(after.version, 'mine/1', 'the user edit must survive');
  });
});

test('init creates .gitignore with the store entry when absent', () => {
  withScratch((dir) => {
    run(['init'], dir);
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^\.qa-spine\/$/m);
  });
});

test('init appends to an existing .gitignore without disturbing it', () => {
  withScratch((dir) => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndist/\n');
    run(['init'], dir);

    const after = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.match(after, /node_modules\//);
    assert.match(after, /dist\//);
    assert.match(after, /^\.qa-spine\/$/m);
  });
});

test('init does not add the gitignore entry twice', () => {
  withScratch((dir) => {
    writeFileSync(join(dir, '.gitignore'), '.qa-spine/\n');
    const { out } = run(['init'], dir);
    assert.match(out, /already ignores/);

    const lines = readFileSync(join(dir, '.gitignore'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() === '.qa-spine/');
    assert.equal(lines.length, 1);
  });
});

test('init prints an mcp line naming a server.js that exists', () => {
  withScratch((dir) => {
    const { out } = run(['init'], dir);
    const match = out.match(/claude mcp add qa-spine -- node (\S+)/);
    assert.ok(match, `expected an mcp line, got:\n${out}`);
    assert.ok(existsSync(match[1]), `printed path should exist: ${match[1]}`);
  });
});

test('init never creates a store directory', () => {
  withScratch((dir) => {
    run(['init'], dir);
    assert.ok(!existsSync(join(dir, '.qa-spine')), 'init must not create .qa-spine/');
    assert.ok(!existsSync(join(dir, 'should-never-appear.db')), 'init must not touch QA_SPINE_DB');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/cli-init-demo.test.ts`
Expected: FAIL — there is no `init` case, so the server falls through to `default` and starts an MCP stdio server instead of printing.

- [ ] **Step 3: Add the imports**

In `src/server.ts`, widen the existing `node:fs` and `node:path` imports:

```ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
```

Keep any other members those import lines already carry.

- [ ] **Step 4: Stop creating the store directory for commands that do not use one**

Replace the two lines above the switch:

```ts
if (invokedAsScript()) {
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
```

with:

```ts
if (invokedAsScript()) {
  const subcommand = process.argv[2];
  const path = dbPath();
  // `init` and `demo` never read or write the configured store, so they must not
  // create its directory either — a demo that leaves an empty .qa-spine/ in your
  // working directory has already broken the promise it makes in its own output.
  //
  // ponytail: an exempt list rather than moving this into each case that opens a
  // store. Seven cases need it and two do not; inverting that is more churn than
  // it buys. If a third exempt command appears, move it into the cases instead.
  if (subcommand !== 'init' && subcommand !== 'demo') {
    mkdirSync(dirname(path), { recursive: true });
  }
```

- [ ] **Step 5: Add the `init` case**

After the `audit-submit` case and before `default`:

```ts
    case 'init': {
      // Human-readable on stdout, errors on stderr — this is a command a person runs
      // and reads, unlike `record` whose caller parses one JSON object.
      const packageRoot = resolve(import.meta.dirname, '..');
      let failed = false;

      // 1. The rubric. The README calls it "the thing a team argues about in review";
      // that is only true once the team owns the file and can commit it.
      const rubricDest = resolve(process.cwd(), 'rubrics', 'ambiguity.json');
      if (existsSync(rubricDest)) {
        console.log('· rubrics/ambiguity.json already exists — left alone');
      } else {
        try {
          mkdirSync(dirname(rubricDest), { recursive: true });
          copyFileSync(resolve(packageRoot, 'rubrics', 'ambiguity.json'), rubricDest);
          console.log('✓ rubrics/ambiguity.json — yours now, edit and commit it');
        } catch (err) {
          console.error(`could not write rubrics/ambiguity.json: ${err instanceof Error ? err.message : err}`);
          failed = true;
        }
      }

      // 2. .gitignore — a SQLite file in git means a binary merge conflict on every
      // parallel branch.
      const gitignorePath = resolve(process.cwd(), '.gitignore');
      const ENTRY = '.qa-spine/';
      try {
        const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
        if (current.split('\n').some((line) => line.trim() === ENTRY)) {
          console.log(`· .gitignore already ignores ${ENTRY}`);
        } else {
          const separator = current && !current.endsWith('\n') ? '\n' : '';
          writeFileSync(gitignorePath, `${current}${separator}${ENTRY}\n`);
          console.log(`✓ .gitignore += ${ENTRY}`);
        }
      } catch (err) {
        console.error(`could not update .gitignore: ${err instanceof Error ? err.message : err}`);
        failed = true;
      }

      // 3. The MCP line. The path is inside node_modules and differs per install —
      // nobody should have to go and find it.
      console.log('\nRegister with Claude Code:');
      console.log(`  claude mcp add qa-spine -- node ${resolve(packageRoot, 'dist', 'server.js')}`);
      console.log('\nThen: npx qa-spine demo   # see it working — writes only to a temp file');
      console.log('Set QA_SPINE_RUBRICS to use rubrics from somewhere other than ./rubrics.');

      if (failed) process.exitCode = 1;
      break;
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/cli-init-demo.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 7: Full suite and build**

Run: `npm test && npm run build`
Expected: all PASS (134 existing + 7 new = 141), `tsc` clean.

- [ ] **Step 8: Confirm the repo store is untouched**

```bash
node -e "
const { TraceStore } = await import('./src/trace/store.ts');
console.log(new TraceStore('.qa-spine/trace.db').list(undefined,500).length + ' artifacts (must be 8)');
"
```

- [ ] **Step 9: Commit**

```bash
git add src/server.ts tests/cli-init-demo.test.ts
git commit -m "feat(cli): add init, and stop creating a store dir for commands that need none"
```

---

### Task 2: `demo`

**Files:**
- Create: `src/demo.ts`
- Modify: `src/server.ts` — a new case after `init`
- Modify: `tests/cli-init-demo.test.ts` (append)

**Interfaces:**
- Consumes: existing `TraceStore`, `recordVerdict` from `./release.ts`, `renderBrief` from `./brief.ts`.
- Produces:
  - `seedDemo(store: TraceStore): { verdictId: string }`
  - `runDemo(dbPath: string, briefPath: string): { store: TraceStore; verdictId: string }` — deletes the db, seeds it, writes the brief. Task 3 documents the command that calls it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/cli-init-demo.test.ts`. Note the import line at the top of the file must gain
`import { TraceStore } from '../src/trace/store.ts';` and `import { runDemo } from '../src/demo.ts';`

```ts
function withDemo(fn: (db: string, brief: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-demo-'));
  try {
    fn(join(dir, 'demo.db'), join(dir, 'brief.html'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('runDemo seeds the whole arc and writes the brief', () => {
  withDemo((db, brief) => {
    const { store, verdictId } = runDemo(db, brief);
    assert.equal(store.list(undefined, 1e9).length, 7);
    assert.ok(verdictId.startsWith('verdict_'));
    assert.ok(existsSync(brief));
  });
});

test("the brief reads as a hold and names the open question", () => {
  withDemo((db, brief) => {
    runDemo(db, brief);
    const html = readFileSync(brief, 'utf8');
    assert.match(html, /Not ready to ship/);
    assert.match(html, /What happens when notification delivery fails\?/);
  });
});

test('the seeded graph is connected — the verdict is reachable from the requirement', () => {
  withDemo((db, brief) => {
    const { store, verdictId } = runDemo(db, brief);
    const requirement = store.list('requirement', 10)[0];
    const chain = store.chain(requirement.id);
    assert.ok(chain, 'requirement must have a chain');
    assert.equal(chain.nodes.length, 7, 'every artifact should be reachable, not seven islands');
    assert.ok(chain.nodes.some((n) => n.id === verdictId));
  });
});

test('one question is answered and one is left open', () => {
  withDemo((db, brief) => {
    const { store } = runDemo(db, brief);
    const findings = store.list('finding', 10);
    assert.equal(findings.length, 2);

    const openFindings = store.openFindings();
    assert.equal(openFindings.length, 1, 'exactly one question should still be waiting');
    assert.equal(openFindings[0].content.category, 'AMB-UNTESTABLE');
  });
});

test('the verdict went through recordVerdict, not a raw write', () => {
  withDemo((db, brief) => {
    const { store, verdictId } = runDemo(db, brief);
    const verdict = store.get(verdictId);
    assert.ok(verdict);
    // liveFindings is computed by recordVerdict from real signals. A raw store.record
    // could not have produced it, so this is what makes the demo a check on the gate
    // rather than a staged picture of one.
    const live = verdict.content.liveFindings;
    assert.ok(Array.isArray(live) && live.length === 1, 'liveFindings must name the open finding');
    const open = store.openFindings()[0];
    assert.equal(live[0], open.id);
  });
});

test('running the demo twice does not stack a second copy', () => {
  withDemo((db, brief) => {
    runDemo(db, brief);
    const { store } = runDemo(db, brief);
    assert.equal(store.list(undefined, 1e9).length, 7, 'the ledger is append-only — start clean');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/cli-init-demo.test.ts`
Expected: FAIL — cannot find module `../src/demo.ts`.

- [ ] **Step 3: Write `src/demo.ts`**

```ts
import { rmSync, writeFileSync } from 'node:fs';
import { TraceStore } from './trace/store.ts';
import { recordVerdict } from './release.ts';
import { renderBrief } from './brief.ts';

/**
 * One worked example: a requirement, two questions raised against it, one answered
 * and one not, a test that fails, and a release held because of the one nobody
 * answered. It is the product's whole argument in seven artifacts.
 *
 * Both quotes are verbatim substrings of the requirement text and both categories are
 * real rubric rule ids, so this data would survive `audit_submit`'s validation — not
 * merely `store.record`'s. The old examples/seed-demo.ts did not, which is why its
 * verdict rendered a brief with empty sections.
 */
const AI = { producer: 'ai' as const, model: 'claude-haiku-4-5', promptVersion: 'ambiguity/1' };
const HUMAN = { producer: 'human' as const };

const REQUIREMENT_TEXT =
  'Refunds must be processed quickly and the customer notified appropriately.';

export function seedDemo(store: TraceStore): { verdictId: string } {
  const requirement = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-42',
    content: { text: REQUIREMENT_TEXT },
    provenance: HUMAN,
  });

  const answered = store.record({
    type: 'finding',
    sourceRef: 'PROJ-42',
    content: {
      category: 'AMB-VAGUE-QUANT',
      quote: 'processed quickly',
      question: 'What measurable threshold makes a refund quick?',
      confidence: 'high',
    },
    provenance: AI,
    links: [{ to: requirement.id, relation: 'derived_from' }],
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
    provenance: AI,
    links: [{ to: requirement.id, relation: 'derived_from' }],
  });

  store.record({
    type: 'answer',
    sourceRef: 'PROJ-42',
    content: { text: 'Within three business days, measured from approval.' },
    provenance: HUMAN,
    links: [
      { to: answered.id, relation: 'supersedes' },
      { to: requirement.id, relation: 'derived_from' },
    ],
  });

  const testCase = store.record({
    type: 'test_case',
    sourceRef: 'features/refund.feature',
    content: { name: 'refund completes and emails the customer' },
    provenance: AI,
    links: [{ to: requirement.id, relation: 'covers' }],
  });

  store.record({
    type: 'test_run',
    sourceRef: 'ci/run/8812',
    content: {
      status: 'failed',
      run_passed: false,
      message: 'timed out waiting for notification',
    },
    provenance: HUMAN,
    links: [{ to: testCase.id, relation: 'verifies' }],
  });

  // Through the real recordVerdict, never store.record. That computes liveFindings from
  // actual signals and subjects this reason to the prose lint — so if the gate ever
  // regresses, the demo fails loudly instead of seeding a verdict no real call could
  // have produced.
  const verdict = recordVerdict(store, {
    releaseRef: 'release/2026.8.1',
    verdict: 'hold',
    reason:
      'One question raised when this work was specified was never answered, and it ' +
      'touches an area this release changed.',
    cites: [open.id, requirement.id],
    changed: ['PROJ-42'],
    provenance: { producer: 'ai', model: 'claude-opus-5', promptVersion: 'release-brief/1' },
  });

  return { verdictId: verdict.id };
}

/**
 * Seed a throwaway store and render its brief.
 *
 * The database is deleted first: the ledger is append-only, so re-running would
 * otherwise stack a second copy of the arc that nothing could remove.
 *
 * ponytail: one hardcoded arc, no flags to vary it and no way to seed a clean ship.
 * Fine for a first-run demo; a second scenario becomes a flag when somebody asks.
 */
export function runDemo(dbPath: string, briefPath: string): { store: TraceStore; verdictId: string } {
  rmSync(dbPath, { force: true });
  const store = new TraceStore(dbPath);
  const { verdictId } = seedDemo(store);
  writeFileSync(briefPath, renderBrief(store, verdictId));
  return { store, verdictId };
}
```

- [ ] **Step 4: Add the `demo` case**

In `src/server.ts`, after the `init` case:

```ts
    case 'demo': {
      // QA_SPINE_DB is deliberately ignored: the point of the demo is that it does not
      // write where your data lives. The ledger is append-only, so a demo seeded into a
      // real store would be permanent.
      const demoDb = join(tmpdir(), 'qa-spine-demo.db');
      const briefPath = join(tmpdir(), 'qa-spine-demo-brief.html');

      let demo: { store: InstanceType<typeof TraceStore>; verdictId: string };
      try {
        const { runDemo } = await import('./demo.ts');
        demo = runDemo(demoDb, briefPath);
      } catch (err) {
        // Fail before starting the Inspector — nobody should be shown a half-built store.
        console.error(`demo failed while seeding: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
        break;
      }

      const port = Number(process.argv[3] ?? process.env.QA_SPINE_PORT ?? 4700);
      const { startInspector } = await import('./inspector/server.ts');
      await startInspector(demo.store, port);

      console.log(`seeded ${demoDb}`);
      console.log(`brief  ${briefPath}`);
      console.log(`\nqa-spine inspector → http://127.0.0.1:${port}`);
      console.log('\nA throwaway store — your own data is untouched. Ctrl-C to stop.');
      break;
    }
```

Add `join` and `tmpdir` to the imports at the top of `src/server.ts`:

```ts
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/cli-init-demo.test.ts`
Expected: PASS, 13 tests (7 from Task 1, 6 new)

- [ ] **Step 6: Run the demo for real**

```bash
npm run build
node dist/server.js demo &
sleep 2
curl -s http://127.0.0.1:4700/api/artifacts | head -c 200
kill %1
head -c 120 /tmp/qa-spine-demo-brief.html
```

Expected: the API returns artifacts, and the brief starts with `<!doctype html>`. Open
`/tmp/qa-spine-demo-brief.html` in a browser and confirm it reads "Not ready to ship".

- [ ] **Step 7: Confirm the repo store is untouched**

```bash
node -e "
const { TraceStore } = await import('./src/trace/store.ts');
console.log(new TraceStore('.qa-spine/trace.db').list(undefined,500).length + ' artifacts (must be 8)');
"
```

Also confirm no `.qa-spine/` directory appeared anywhere it should not: `git status --porcelain`
should show only the files you changed.

- [ ] **Step 8: Full suite and build**

Run: `npm test && npm run build`
Expected: all PASS (134 + 13 = 147), `tsc` clean.

- [ ] **Step 9: Commit**

```bash
git add src/demo.ts src/server.ts tests/cli-init-demo.test.ts
git commit -m "feat(cli): add demo, seeding a throwaway store through the real gate"
```

---

### Task 3: The quickstart, and delete the stale seeder

**Files:**
- Modify: `README.md`
- Delete: `examples/seed-demo.ts`

**Interfaces:**
- Consumes: the `init` and `demo` contracts from Tasks 1 and 2.
- Produces: nothing importable.

- [ ] **Step 1: Replace the "Run it" section**

`README.md` currently opens its instructions with `npm install / npm test / npm run build` and a
`claude mcp add` line naming `/path/to/qa-spine/dist/server.js`. Replace that whole section with:

````markdown
## Quickstart

```bash
npx qa-spine demo     # see it working — writes only to a temp file
npx qa-spine init     # set up your project
```

`demo` seeds a worked example into a throwaway database, writes a release brief beside it, and
opens the Inspector on it. It never touches your own store: the ledger is append-only, so anything
seeded into it would be permanent.

`init` copies the ambiguity rubric into your project so your team owns and versions it, adds
`.qa-spine/` to `.gitignore`, and prints the line to register the MCP server with Claude Code.

The trace store is a SQLite file at `.qa-spine/trace.db`, overridable with `QA_SPINE_DB`. Rubrics
are read from the package unless you point `QA_SPINE_RUBRICS` at your own directory.

## Working on qa-spine itself

```bash
npm install
npm test
npm run build
```
````

- [ ] **Step 2: Update the Inspector section**

That section currently begins:

```
node examples/seed-demo.ts   # one complete spine to look at
npm run inspect              # → http://127.0.0.1:4700
```

Replace those two lines with:

```
npx qa-spine demo            # one complete spine to look at, in a throwaway store
```

and leave the rest of the section as it is.

- [ ] **Step 3: Check for other references**

Run: `grep -rn "seed-demo" README.md docs/ src/ tests/ examples/ 2>/dev/null`

Every hit outside `docs/superpowers/` must be updated or removed. Hits **inside**
`docs/superpowers/specs/` and `docs/superpowers/plans/` are historical records of decisions and
must be left exactly as they are — they describe what was true when they were written.

- [ ] **Step 4: Delete the stale seeder**

```bash
git rm examples/seed-demo.ts
```

It writes pre-phase-2 data: categories like `vague_qualifier` that are not rubric rule ids,
findings with no `question`, and a verdict predating `changed` and `liveFindings`. The
release-brief review found that rendering its verdict produced a page with empty sections.

- [ ] **Step 5: Confirm `examples/` is either useful or gone**

Run: `ls examples/`

If `import-jira.ts` is the only file left, the directory still earns its place — leave it. If the
directory is now empty, remove it.

- [ ] **Step 6: Full suite and build**

Run: `npm test && npm run build`
Expected: all PASS, `tsc` clean. Nothing imports the deleted file, so this is a formality — but it
is the formality that catches the case where something did.

- [ ] **Step 7: Verify the package still contains what it should**

Run: `npm pack --dry-run 2>&1 | grep -E "qa-spine|total files"`

Expected: `dist/demo.js` now appears in the tarball, and the file count has grown by one from 14.

- [ ] **Step 8: Commit**

```bash
git add README.md
git commit -m "docs: install-first quickstart, and drop the stale seeder"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| `init` copies the rubric, never clobbering | 1 (tests 1, 2) |
| `init` adds `.qa-spine/` to `.gitignore`, once | 1 (tests 3, 4, 5) |
| `init` prints the resolved MCP path | 1 (test 6) |
| Neither command creates the store directory | 1 (test 7), the guard in Step 4 |
| `demo` seeds a throwaway store, deletes it first | 2 (tests 8, 13) |
| The seven-artifact arc, one answered and one open | 2 (tests 8, 11) |
| Verdict through `recordVerdict`, `liveFindings` real | 2 (test 12) |
| The brief renders a hold naming the open question | 2 (test 9) |
| The graph is connected | 2 (test 10) |
| `demo` ignores `QA_SPINE_DB` | 1 (test 7 asserts it for init); 2's case comment and Step 7 |
| Install-first quickstart | 3 |
| `examples/seed-demo.ts` deleted | 3 |
| 3 `ponytail:` ceilings | 1 (the exempt list), 2 (the hardcoded arc, in `runDemo`) |

**Placeholder scan:** none — every step carries runnable code or an exact command.

**Type consistency:** `seedDemo(store) -> { verdictId }` and `runDemo(dbPath, briefPath) -> { store, verdictId }` are identical in Task 2's definition, its tests, and the Task 2 call site. `withDemo` and `withScratch` are distinct helpers with distinct signatures.

**One gap I am leaving deliberate, flagged:** the spec's test 14 says "neither command writes to a `QA_SPINE_DB` path when one is set". Task 1's test 7 proves it for `init` via the subprocess. For `demo` there is no equivalent subprocess test, because `demo` starts a blocking Inspector and killing it mid-test is flaky. `runDemo` takes its paths as arguments and never reads the environment, so the property is structural rather than asserted — and Task 2's Step 7 checks it by hand. If a reviewer judges that insufficient, the fix is a subprocess test that spawns `demo`, polls the port, and kills it; that is worth doing only if the hand check ever fails.

**One risk worth stating:** Task 1 Step 4 changes behaviour for *every* subcommand by making the store-directory creation conditional. The exempt list is two entries and the existing suite covers the other seven paths — if any existing test fails after that change, the guard is wrong, not the test.
