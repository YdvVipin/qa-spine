import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VERSION } from '../src/server.ts';

const REPO = process.cwd();

/**
 * Runs a subcommand from a scratch cwd with no QA_SPINE_DB override, so the test can
 * assert nothing created `.qa-spine/` there. The timeout matters: before the unknown-
 * subcommand guard existed, a typo fell through to the stdio MCP server and hung.
 */
function run(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-help-'));
  const env = { ...process.env };
  delete env.QA_SPINE_DB;
  try {
    const out = execFileSync('node', [resolve(REPO, 'src/server.ts'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      env,
      timeout: 10_000,
    });
    return { code: 0, out, err: '', madeStoreDir: existsSync(join(dir, '.qa-spine')) };
  } catch (err: any) {
    return {
      code: err.status ?? (err.signal ? `killed by ${err.signal}` : 1),
      out: (err.stdout ?? '') as string,
      err: (err.stderr ?? '') as string,
      madeStoreDir: existsSync(join(dir, '.qa-spine')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const flag of ['help', '--help', '-h']) {
  test(`${flag} prints the usage screen and exits 0`, () => {
    const { code, out, madeStoreDir } = run([flag]);
    assert.equal(code, 0);
    assert.match(out, /usage: qa-spine/);
    // Every subcommand a person can type must be on the screen.
    for (const sub of [
      'init',
      'demo',
      'inspect',
      'record',
      'brief',
      'audit-requirement',
      'audit-submit',
      'gate',
      'review-export',
    ]) {
      assert.match(out, new RegExp(`^\\s+${sub}`, 'm'), `usage must list ${sub}`);
    }
    assert.match(out, /MCP server/i, 'must say what running with no subcommand does');
    assert.equal(madeStoreDir, false, 'asking for help must not create .qa-spine/');
  });
}

for (const flag of ['version', '--version', '-v']) {
  test(`${flag} prints the version and exits 0`, () => {
    const { code, out, madeStoreDir } = run([flag]);
    assert.equal(code, 0);
    assert.equal(out.trim(), VERSION);
    assert.equal(madeStoreDir, false);
  });
}

test('a typo does not silently start a stdio MCP server', () => {
  const { code, out, err, madeStoreDir } = run(['hlep']);
  assert.equal(code, 1, `must exit 1, not hang or die by signal (got ${code})`);
  assert.match(err, /unknown subcommand 'hlep'/);
  assert.match(err, /usage: qa-spine/, 'the fix is on the same screen as the mistake');
  assert.equal(out, '', 'diagnostics belong on stderr');
  assert.equal(madeStoreDir, false, 'a typo must not create .qa-spine/');
});

test('the CLI reports the version package.json publishes, so the two cannot drift', async () => {
  const { readFileSync } = await import('node:fs');
  assert.equal(VERSION, JSON.parse(readFileSync('package.json', 'utf8')).version);
});
