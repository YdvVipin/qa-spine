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
