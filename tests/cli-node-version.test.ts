/**
 * The `bin` is dist/cli.js, which checks Node before anything loads `node:sqlite`: on an older
 * Node that import fails before any of qa-spine's code runs, with an error that never says
 * "upgrade Node". CI runs the packed cli.js on a real Node 20 (the old-node job); these tests
 * hold the check and the hand-off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nodeTooOld } from '../src/cli.ts';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

test('a Node older than 22.13 gets one sentence naming both versions and what to do', () => {
  for (const old of ['18.19.0', '20.11.0', '22.5.1', '22.12.9']) {
    const message = nodeTooOld(old);
    assert.ok(message, old);
    assert.match(message, /qa-spine needs Node 22\.13 or later/);
    assert.ok(message.includes(`this is Node ${old}`), message);
    assert.match(message, /nodejs\.org/);
    assert.equal(message.split('\n').length, 1, 'one line, no stack trace');
  }
});

test('22.13 and every later Node pass', () => {
  for (const ok of ['22.13.0', '22.23.4', '23.0.0', '24.1.0', '26.0.0']) assert.equal(nodeTooOld(ok), undefined, ok);
});

test('the bin is cli.js, and the check matches engines', () => {
  assert.equal(pkg.bin['qa-spine'], 'dist/cli.js');
  assert.equal(pkg.engines.node, '>=22.13');
});

const run = (file: string, args: string[]) =>
  execFileSync('node', [file, ...args], { encoding: 'utf8', env: { ...process.env, QA_SPINE_DB: join(tmpdir(), 'qa-spine-never-created', 'x.db') } });

test('cli hands every command to the server: version, and a subcommand with its arguments', () => {
  assert.equal(run('src/cli.ts', ['--version']).trim(), pkg.version);
  let out = '';
  try {
    run('src/cli.ts', ['audit-requirement']);
  } catch (err: any) {
    assert.equal(err.status, 1);
    out = err.stdout;
  }
  assert.match(JSON.parse(out).error, /^usage: qa-spine audit-requirement/);
});

test('cli runs through a bin symlink, the way npm installs it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-cli-bin-'));
  try {
    const link = join(dir, 'qa-spine');
    symlinkSync(resolve('src/cli.ts'), link);
    assert.equal(run(link, ['--version']).trim(), pkg.version);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server.js still runs on its own, so existing `node …/dist/server.js` MCP lines keep working', () => {
  assert.equal(run('src/server.ts', ['--version']).trim(), pkg.version);
});
