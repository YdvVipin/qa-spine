/**
 * `qa-spine demo` as a new user runs it, through the bin: it answers fast, it survives a busy
 * default port, it refuses a busy port the user chose in one line, and Ctrl-C stops it and
 * deletes its throwaway store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('src/cli.ts');
const env = () => ({ ...process.env, TMPDIR: mkdtempSync(join(tmpdir(), 'qa-spine-demo-env-')), QA_SPINE_PORT: '' });

/** Starts the demo and resolves once it prints its address. */
function startDemo(args: string[], e: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; url: string; store: string; out: () => string; ms: number }> {
  const started = Date.now();
  const child = spawn('node', [CLI, 'demo', ...args], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL'); // a failed start must not leave a server behind to hang the run
      fail(new Error(`demo did not start in 15 s:\n${out}`));
    }, 15000);
    const read = (d: Buffer) => {
      out += d;
      const url = out.match(/http:\/\/127\.0\.0\.1:\d+\S*/)?.[0];
      const store = out.match(/^store\s+(\S+)/m)?.[1];
      if (url && store) {
        clearTimeout(timer);
        ok({ child, url, store, out: () => out, ms: Date.now() - started });
      }
    };
    child.stdout!.on('data', read);
    child.stderr!.on('data', read);
    child.on('exit', (code) => fail(new Error(`demo exited ${code}:\n${out}`)));
  });
}

/** Holds a port so the demo cannot have it. */
function occupy(port: number): Promise<Server | undefined> {
  return new Promise((ok) => {
    const s = createServer().once('error', () => ok(undefined)); // already taken: fine, it is busy either way
    s.listen(port, '127.0.0.1', () => ok(s));
  });
}

test('the demo answers within 10 s, and Ctrl-C stops it and deletes its throwaway store', { skip: process.platform === 'win32' }, async () => {
  const demo = await startDemo(['--port', '0'], env());
  try {
    assert.ok(demo.ms < 10000, `took ${demo.ms} ms`);
    assert.equal((await fetch(demo.url)).status, 200);
    assert.ok(existsSync(demo.store), 'the store exists while it runs');
    const exited = new Promise<number | null>((ok) => demo.child.once('exit', ok));
    demo.child.kill('SIGINT');
    assert.equal(await exited, 0);
    assert.ok(!existsSync(demo.store), `the throwaway store is deleted: ${demo.store}`);
  } finally {
    demo.child.kill('SIGKILL');
  }
});

test('a busy default port is not the user\'s problem: the demo takes another one', { skip: process.platform === 'win32' }, async () => {
  const held = await occupy(4700);
  try {
    const demo = await startDemo([], env());
    try {
      assert.doesNotMatch(demo.url, /:4700\b/);
      assert.equal((await fetch(demo.url)).status, 200);
    } finally {
      demo.child.kill('SIGINT');
    }
  } finally {
    held?.close();
  }
});

test('a busy port the user chose gets one sentence and exit 1, not a stack trace', async () => {
  const held = await occupy(0);
  const port = (held!.address() as { port: number }).port;
  try {
    for (const cmd of ['demo', 'inspect']) {
      const r = spawnSync('node', [CLI, cmd, '--port', String(port)], {
        encoding: 'utf8',
        env: { ...env(), QA_SPINE_DB: join(mkdtempSync(join(tmpdir(), 'qa-spine-inspect-')), 'trace.db') },
        timeout: 15000,
      });
      assert.equal(r.status, 1, `${cmd}: ${r.stderr}`);
      const lines = r.stderr.trim().split('\n');
      assert.equal(lines.length, 1, `${cmd}: ${r.stderr}`);
      assert.match(lines[0], new RegExp(`port ${port} is in use.*--port`));
    }
  } finally {
    held!.close();
  }
});
