/**
 * The 11 MCP tools against 0.4.0, over the real protocol (in-memory transport). RatifyQA and the
 * agent-evals case study call these by name, so the names are pinned. Each description says what
 * comes back; each input says what to pass, with an example; and the two refusals an agent hits
 * most (a status qa-spine does not read, a ship with missing evidence) say how to fix them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TraceStore } from '../src/trace/store.ts';
import { createServer } from '../src/server.ts';
import { RUN_STATUSES } from '../src/trace/schema.ts';
import { REASONS } from '../src/release.ts';
import { HOW_TO_CLOSE } from '../src/words.ts';

const TOOLS = [
  'health', 'trace_record', 'trace_query', 'audit_requirement', 'audit_submit', 'audit_open',
  'audit_answer', 'assess_release_risk', 'release_submit', 'fixtures_request', 'fixtures_submit',
];
const human = { producer: 'human' as const };

async function connect(store = new TraceStore(':memory:')) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(store).connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as any;
    return { isError: !!r.isError, text: r.content[0].text as string };
  };
  return { client, call, store };
}

test('the 11 tool names are exactly the ones callers use', async () => {
  const { client } = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...TOOLS].sort());
});

test('every tool says what it returns, and every input says what to pass', async () => {
  const { client } = await connect();
  const gaps: string[] = [];
  for (const tool of (await client.listTools()).tools) {
    if (!/\bReturns\b/.test(tool.description ?? '')) gaps.push(`${tool.name}: say what it returns`);
    const props = (tool.inputSchema as any).properties ?? {};
    for (const [name, schema] of Object.entries<any>(props)) {
      if (!schema.description?.trim()) gaps.push(`${tool.name}.${name}: no description`);
      else if (schema.type === 'string' && !schema.enum && !/e\.g\./.test(schema.description)) gaps.push(`${tool.name}.${name}: no example`);
    }
  }
  assert.deepEqual(gaps, []);
});

test('no tool description still says a named hand-recorded pass needs an override', async () => {
  const { client } = await connect();
  for (const tool of (await client.listTools()).tools) {
    assert.doesNotMatch(tool.description ?? '', /without a named override/, tool.name);
  }
});

test('trace_record with status "completed" is refused, naming the field and all eight statuses', async () => {
  const { call, store } = await connect();
  const tc = store.record({ type: 'test_case', content: { name: 't' }, provenance: human });
  const r = await call('trace_record', {
    type: 'test_run',
    content: { status: 'completed' },
    provenance: human,
    links: [{ to: tc.id, relation: 'verifies' }],
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /status/);
  for (const s of RUN_STATUSES) assert.ok(r.text.includes(s), `lists ${s}: ${r.text}`);
  assert.equal(store.list('test_run').length, 0, 'nothing written');
});

test('every reason code has a sentence saying how to close it', () => {
  for (const code of REASONS) assert.ok(HOW_TO_CLOSE[code]?.trim(), code);
});

test('release_submit ship with missing evidence is refused with each open reason and how to close it', async () => {
  const { call, store } = await connect();
  store.record({ type: 'requirement', sourceRef: 'QA-1', content: { text: 'Totals are right.' }, provenance: human });
  const assessed = JSON.parse((await call('assess_release_risk', { changed: ['QA-1', 'QA-404'] })).text);
  assert.equal(assessed.decision, 'UNKNOWN');
  assert.deepEqual(assessed.reasons, ['NO_TEST']);
  const r = await call('release_submit', {
    releaseRef: 'v1', verdict: 'ship', reason: 'Looks fine to ship.', cites: [], changed: ['QA-1'], provenance: human,
  });
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('NO_TEST'), r.text);
  assert.ok(r.text.includes(HOW_TO_CLOSE.NO_TEST), r.text);
  assert.equal(store.list('verdict').length, 0, 'nothing recorded');
});

test('an override does not get past missing evidence either, and the refusal says why', async () => {
  const { call, store } = await connect();
  store.record({ type: 'requirement', sourceRef: 'QA-1', content: { text: 'Totals are right.' }, provenance: human });
  const r = await call('release_submit', {
    releaseRef: 'v1', verdict: 'ship', reason: 'Shipping anyway, for the deadline.', cites: [], changed: ['QA-1'],
    override: { reason: 'Deadline; tracked in QA-9.' }, provenance: { ...human, approvedBy: 'qa.lead' },
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /cannot vouch for what was never checked/);
  assert.ok(r.text.includes(HOW_TO_CLOSE.NO_TEST));
});

test('assess_release_risk returns the decision and reasons from the one evaluator', async () => {
  const { call } = await connect();
  const r = JSON.parse((await call('assess_release_risk', { changed: ['NOTHING-1'] })).text);
  assert.equal(r.decision, 'UNKNOWN');
  assert.deepEqual(r.reasons, ['SCOPE_UNRESOLVED']);
});

test('health returns the version and the store it reads', async () => {
  const { call } = await connect();
  const r = JSON.parse((await call('health', {})).text);
  assert.equal(r.ok, true);
  assert.equal(typeof r.version, 'string');
  assert.equal(typeof r.artifacts, 'number');
});
