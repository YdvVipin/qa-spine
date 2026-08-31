import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolvePort } from '../src/server.ts';

const REPO = process.cwd();

/**
 * Runs a subcommand from a scratch cwd. Only the failing paths are driven through the
 * real CLI: a port that resolves starts a server and would not return.
 */
function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-port-'));
  try {
    execFileSync('node', [resolve(REPO, 'src/server.ts'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, QA_SPINE_DB: join(dir, 'trace.db'), ...env },
    });
    return { code: 0, err: '' };
  } catch (err: any) {
    return { code: err.status ?? 1, err: (err.stderr ?? '') as string };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('resolvePort reads --port, a bare positional, the env var, then the default', () => {
  assert.equal(resolvePort(['--port', '5000']), 5000);
  assert.equal(resolvePort(['5000']), 5000, 'the positional predates --port and still works');
  assert.equal(resolvePort([]), 4700);

  const prior = process.env.QA_SPINE_PORT;
  process.env.QA_SPINE_PORT = '5100';
  try {
    assert.equal(resolvePort([]), 5100);
    assert.equal(resolvePort(['--port', '5000']), 5000, 'an explicit flag beats the env var');
  } finally {
    if (prior === undefined) delete process.env.QA_SPINE_PORT;
    else process.env.QA_SPINE_PORT = prior;
  }
});

test('resolvePort rejects what would otherwise reach listen() as NaN', () => {
  // The exact regression: Number('--port') is NaN, and NaN reached server.listen().
  assert.throws(() => resolvePort(['--no-open']), /Unknown option/);
  assert.throws(() => resolvePort(['abc']), /invalid port: abc/);
  assert.throws(() => resolvePort(['--port', 'abc']), /invalid port: abc/);
  assert.throws(() => resolvePort(['70000']), /invalid port: 70000/);
});

test('inspect rejects a bad port with a message, not a RangeError stack', () => {
  const { code, err } = run(['inspect', '--port', 'abc']);
  assert.equal(code, 1);
  assert.match(err, /qa-spine inspect: invalid port: abc/);
  assert.doesNotMatch(err, /RangeError|ERR_SOCKET_BAD_PORT/, 'must not crash out of listen()');
});

test('demo rejects an unknown flag before it seeds anything', () => {
  const { code, err } = run(['demo', '--no-open']);
  assert.equal(code, 1);
  assert.match(err, /qa-spine demo: .*Unknown option/);
  assert.doesNotMatch(err, /RangeError|ERR_SOCKET_BAD_PORT/, 'must not crash out of listen()');
  // The seeding message would mean the port was checked too late to be free.
  assert.doesNotMatch(err, /failed while seeding/);
});

test('a bad QA_SPINE_PORT is caught too, not just a bad flag', () => {
  const { code, err } = run(['inspect'], { QA_SPINE_PORT: 'abc' });
  assert.equal(code, 1);
  assert.match(err, /invalid port: abc/);
  assert.doesNotMatch(err, /RangeError|ERR_SOCKET_BAD_PORT/);
});
