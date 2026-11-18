/**
 * E1, qa-spine's side: a write that fails is never silent and never partial. The CLI exits
 * non-zero with the reason, MCP returns isError, and the store holds exactly what it held before.
 * (Retrying, and an outbox for writes that fail, are the caller's: RatifyQA owns those.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TraceStore } from '../src/trace/store.ts';
import { createServer } from '../src/server.ts';

const CLI = resolve('src/cli.ts');
const human = { producer: 'human' as const };

function withStore(fn: (db: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-writes-'));
  const db = join(dir, 'trace.db');
  const s = new TraceStore(db);
  s.record({ type: 'requirement', sourceRef: 'QA-1', content: { text: 'Totals include tax.' }, provenance: human });
  s.close();
  return Promise.resolve(fn(db)).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const rows = (db: string) => {
  const s = new TraceStore(db);
  const n = s.list(undefined, 1e9).length;
  s.close();
  return n;
};
function record(db: string, payload: unknown): Promise<{ code: number; out: string }> {
  return new Promise((ok) => {
    const child = execFile('node', [CLI, 'record'], { env: { ...process.env, QA_SPINE_DB: db }, timeout: 20_000 }, (err, stdout) =>
      ok({ code: err ? ((err as any).code ?? 1) : 0, out: stdout }),
    );
    child.stdin!.end(JSON.stringify(payload));
  });
}

test('a record that cannot be written exits 1 with the reason, and writes nothing, not even half', async () => {
  await withStore(async (db) => {
    const r = await record(db, { type: 'test_case', content: { name: 't' }, provenance: human, links: [{ to: 'requirement_deadbeef', relation: 'covers' }] });
    assert.equal(r.code, 1);
    assert.match(JSON.parse(r.out).error, /requirement_deadbeef.*does not exist/);
    assert.equal(rows(db), 1, 'the test case was not left behind without its link');
  });
});

test('a store another process keeps locked: exit 1, a plain reason, and nothing written', async () => {
  await withStore(async (db) => {
    const holder = spawn('node', ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const d = new DatabaseSync(${JSON.stringify(db)});
      d.exec('BEGIN IMMEDIATE'); console.log('locked');
      setTimeout(() => { d.exec('ROLLBACK'); d.close(); }, 8000);`]);
    try {
      await new Promise<void>((ok) => holder.stdout.once('data', () => ok()));
      const r = await record(db, { type: 'requirement', sourceRef: 'QA-2', content: { text: 'Refunds post.' }, provenance: human });
      assert.equal(r.code, 1);
      assert.match(JSON.parse(r.out).error, /busy.*another process.*Nothing was written.*again/);
    } finally {
      holder.kill();
    }
    assert.equal(rows(db), 1);
  });
});

test('over MCP, a failed write is an error result, and nothing is written', async () => {
  const store = new TraceStore(':memory:');
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer(store).connect(s);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(c);
  const r = (await client.callTool({
    name: 'trace_record',
    arguments: { type: 'test_case', content: { name: 't' }, provenance: human, links: [{ to: 'requirement_deadbeef', relation: 'covers' }] },
  })) as any;
  assert.equal(r.isError, true);
  assert.equal(store.list(undefined, 1e9).length, 0);
});

test('the CLI exit code for a failed write is never 0', () => {
  let code = 0;
  try {
    execFileSync('node', [CLI, 'record'], { input: 'not json', env: { ...process.env, QA_SPINE_DB: join(tmpdir(), 'qa-spine-never', 'x.db') }, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err: any) {
    code = err.status;
  }
  assert.notEqual(code, 0);
});
