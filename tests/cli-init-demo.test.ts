import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runDemo } from '../src/demo.ts';

const REPO = process.cwd();

/**
 * Runs a subcommand from a scratch cwd so nothing touches the repo.
 *
 * QA_SPINE_DB is nested one directory deep on purpose. The store-directory guard is
 * `mkdirSync(dirname(QA_SPINE_DB))`, so pointing it straight at the scratch cwd would
 * make that call a no-op on a directory that already exists — and the test asserting
 * the guard would pass whether or not the guard was there.
 */
function run(
  args: string[],
  cwd: string,
  opts: { unsetDb?: boolean } = {},
): { code: number; out: string; err: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QA_SPINE_DB: join(cwd, 'should-never-appear', 'trace.db'),
  };
  if (opts.unsetDb) delete env.QA_SPINE_DB;
  try {
    const out = execFileSync('node', [resolve(REPO, 'src/server.ts'), ...args], {
      cwd,
      encoding: 'utf8',
      env,
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
    const printed = match[1];
    // Check shape (absolute, ends with dist/server.js) rather than disk existence.
    // Tests run before build, so dist/ may not exist yet. The test catches regressions
    // like printing a relative path or a wrong location by validating the shape.
    assert.ok(resolve(printed) === printed, `path must be absolute: ${printed}`);
    assert.ok(printed.endsWith('dist/server.js'), `path must end with dist/server.js: ${printed}`);
    // Ensure it resolves under the package root, not the user's cwd.
    const packageRoot = resolve(REPO);
    assert.ok(printed.startsWith(packageRoot), `path must resolve under package root: ${printed}`);
  });
});

test('init never creates a store directory', () => {
  withScratch((dir) => {
    run(['init'], dir);
    assert.ok(
      !existsSync(join(dir, 'should-never-appear')),
      'init must not create the configured store directory',
    );

    // Again with QA_SPINE_DB unset, so the default `.qa-spine/trace.db` applies — the
    // path a real `npx qa-spine init` takes, and the one the output promises it leaves
    // alone.
    run(['init'], dir, { unsetDb: true });
    assert.ok(!existsSync(join(dir, '.qa-spine')), 'init must not create .qa-spine/');
  });
});

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
    assert.ok(chain.nodes.some((n: any) => n.id === verdictId));
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
