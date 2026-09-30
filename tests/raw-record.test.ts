import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TraceStore } from '../src/trace/store.ts';
import { createServer } from '../src/server.ts';

const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-opus-5', promptVersion: 'ambiguity/1' };

/** An MCP client wired to a server over an in-memory store — the path an agent takes. */
async function connect() {
  const store = new TraceStore(':memory:');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(store).connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res: any = await client.callTool({ name, arguments: args });
    return { isError: !!res.isError, body: JSON.parse(res.content[0].text) };
  };
  return { store, call };
}

function seed(store: TraceStore) {
  const req = store.record({ type: 'requirement', sourceRef: 'PROJ-1', content: { text: 'r' }, provenance: human });
  const finding = store.record({
    type: 'finding',
    content: { category: 'AMB-VAGUE-QUANT', quote: 'r', question: 'q?' },
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });
  const tc = store.record({ type: 'test_case', content: { name: 't' }, provenance: human, links: [{ to: req.id, relation: 'covers' }] });
  return { req, finding, tc };
}

for (const [type, tool] of [['finding', 'audit_submit'], ['answer', 'audit_answer'], ['verdict', 'release_submit']]) {
  test(`trace_record refuses a ${type} and names ${tool}`, async () => {
    const { store, call } = await connect();
    const before = store.list(undefined, 1e9).length;
    const res = await call('trace_record', { type, content: { text: 'x' }, provenance: human });
    assert.equal(res.isError, true);
    assert.match(res.body.error, new RegExp(tool));
    assert.equal(store.list(undefined, 1e9).length, before);
  });
}

test('trace_record refuses a supersedes link onto a finding', async () => {
  const { store, call } = await connect();
  const { finding } = seed(store);
  const res = await call('trace_record', {
    type: 'test_case',
    content: { name: 'sneaky' },
    provenance: human,
    links: [{ to: finding.id, relation: 'supersedes' }],
  });
  assert.equal(res.isError, true);
  assert.match(res.body.error, /audit_answer/);
  assert.equal(store.openFindings().length, 1, 'the finding is still open');
});

test("trace_record still accepts everything QAAE writes", async () => {
  const { store, call } = await connect();
  const { req, tc } = seed(store);
  for (const args of [
    { type: 'requirement', sourceRef: 'PROJ-2', content: { text: 'r2' }, provenance: human },
    { type: 'test_case', content: { name: 't2' }, provenance: ai, links: [{ to: req.id, relation: 'covers' }] },
    { type: 'test_run', content: { status: 'passed' }, provenance: human, links: [{ to: tc.id, relation: 'verifies' }] },
    { type: 'test_case', content: { name: 'healed' }, provenance: ai, links: [{ to: tc.id, relation: 'supersedes' }] },
  ]) {
    const res = await call('trace_record', args);
    assert.equal(res.isError, false, JSON.stringify(res.body));
  }
});

test('the CLI record subcommand refuses the same things', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-raw-'));
  try {
    const db = join(dir, 'trace.db');
    const run = (payload: unknown) => {
      try {
        return { code: 0, out: JSON.parse(execFileSync('node', ['src/server.ts', 'record'], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, QA_SPINE_DB: db } })) };
      } catch (err: any) {
        return { code: err.status, out: JSON.parse(err.stdout) };
      }
    };
    const verdict = run({ type: 'verdict', content: { verdict: 'ship' }, provenance: human });
    assert.equal(verdict.code, 1);
    assert.match(verdict.out.error, /release_submit/);
    assert.equal(run({ type: 'requirement', content: { text: 'ok' }, provenance: human }).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
