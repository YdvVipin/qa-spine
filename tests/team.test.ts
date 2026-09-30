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
import { assessReleaseRisk, recordVerdict } from '../src/release.ts';
import { recordAnswer, loadRubric } from '../src/audit.ts';

const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-haiku-4-5', promptVersion: 'ambiguity/1' };

async function connect(store = new TraceStore(':memory:')) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(store).connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return { store, client };
}

// --- X3: resources and prompts ---

test('the rubric is an MCP resource a client can list and read', async () => {
  const { client } = await connect();
  const { resources } = await client.listResources();
  assert.ok(resources.some((r) => r.uri === 'qa-spine://rubrics/ambiguity'));
  const read = await client.readResource({ uri: 'qa-spine://rubrics/ambiguity' });
  assert.equal(JSON.parse((read.contents[0] as any).text).version, loadRubric().version);
});

test('audit-ticket is an MCP prompt that names the requirement and the tools to use', async () => {
  const { store, client } = await connect();
  const req = store.record({ type: 'requirement', sourceRef: 'PROJ-42', content: { text: 'Refunds are quick.' }, provenance: human });
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.some((p) => p.name === 'audit-ticket'));
  const got = await client.getPrompt({ name: 'audit-ticket', arguments: { sourceRef: 'PROJ-42' } });
  const text = (got.messages[0].content as any).text as string;
  assert.ok(text.includes(req.id));
  assert.match(text, /audit_requirement/);
  assert.match(text, /audit_submit/);
});

test('audit-ticket for a ref with no requirement says so rather than inventing one', async () => {
  const { client } = await connect();
  const got = await client.getPrompt({ name: 'audit-ticket', arguments: { sourceRef: 'PROJ-404' } });
  assert.match((got.messages[0].content as any).text, /no requirement is recorded for PROJ-404/i);
});

// --- R6: AI answers need a person's approval, when asked ---

function seedAnswered(store: TraceStore, producer: 'ai' | 'human') {
  const req = store.record({ type: 'requirement', sourceRef: 'PROJ-9', content: { text: 'r' }, provenance: human });
  const finding = store.record({ type: 'finding', content: { question: 'How quick?' }, provenance: ai, links: [{ to: req.id, relation: 'derived_from' }] });
  const answer = recordAnswer(store, { findingId: finding.id, answer: 'Two days.', provenance: producer === 'ai' ? ai : human });
  return { finding, answer };
}
const open = (store: TraceStore, requireHumanAnswers?: boolean) =>
  assessReleaseRisk(store, { changed: ['PROJ-9'], requireHumanAnswers }).signals.filter((s) => s.kind === 'unresolved_finding_on_changed_area');

test('by default an AI answer retires a question, as it always has', () => {
  const store = new TraceStore(':memory:');
  seedAnswered(store, 'ai');
  assert.equal(open(store).length, 0);
});

test('with requireHumanAnswers, an AI answer leaves the question open until a person approves it', () => {
  const store = new TraceStore(':memory:');
  const { answer } = seedAnswered(store, 'ai');
  const [signal] = open(store, true);
  assert.equal(signal.detail.awaitingApproval, answer.id);
  store.record({ type: 'review', content: { verdict: 'bad', note: '' }, provenance: human, links: [{ to: answer.id, relation: 'reviews' }] });
  assert.equal(open(store, true).length, 1, 'a thumbs-down is not an approval');
  store.record({ type: 'review', content: { verdict: 'good', note: '' }, provenance: human, links: [{ to: answer.id, relation: 'reviews' }] });
  assert.equal(open(store, true).length, 0);
});

test('with requireHumanAnswers, a human answer counts at once', () => {
  const store = new TraceStore(':memory:');
  seedAnswered(store, 'human');
  assert.equal(open(store, true).length, 0);
});

test('recordVerdict applies the same policy, so the gate and the verdict agree', () => {
  const store = new TraceStore(':memory:');
  seedAnswered(store, 'ai');
  assert.throws(
    () => recordVerdict(store, { releaseRef: 'r', verdict: 'ship', reason: 'Fine.', cites: [], changed: ['PROJ-9'], provenance: human, requireHumanAnswers: true }),
    /cannot ship/,
  );
});

function cli(args: string[], db: string, env: Record<string, string> = {}) {
  try {
    return { code: 0, out: execFileSync('node', ['src/server.ts', ...args], { encoding: 'utf8', env: { ...process.env, QA_SPINE_DB: db, ...env } }), err: '' };
  } catch (err: any) {
    return { code: err.status as number, out: err.stdout as string, err: err.stderr as string };
  }
}

test('gate --require-human-answers blocks on an unapproved AI answer; qa-spine approve clears it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-approve-'));
  try {
    const db = join(dir, 'trace.db');
    const store = new TraceStore(db);
    const { answer } = seedAnswered(store, 'ai');
    store.close();
    assert.equal(cli(['gate', '--changed', 'PROJ-9'], db).code, 0);
    const blocked = cli(['gate', '--changed', 'PROJ-9', '--require-human-answers'], db);
    assert.equal(blocked.code, 1);
    assert.ok(blocked.out.includes(`qa-spine approve ${answer.id} --by <your name>`), blocked.out);
    const nameless = cli(['approve', answer.id], db);
    assert.equal(nameless.code, 1, 'a name is required');
    assert.match(nameless.err, /--by is required/, 'refused for the right reason, not a crash');
    assert.equal(cli(['approve', answer.id, '--by', 'a.rivera'], db).code, 0);
    assert.equal(cli(['gate', '--changed', 'PROJ-9', '--require-human-answers'], db).code, 0);
    assert.equal(cli(['gate', '--changed', 'PROJ-9'], db, { QA_SPINE_REQUIRE_HUMAN_ANSWERS: '1' }).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('QA_SPINE_REQUIRE_HUMAN_ANSWERS=1 turns the policy on without a flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-approve-'));
  try {
    const db = join(dir, 'trace.db');
    seedAnswered(new TraceStore(db), 'ai');
    assert.equal(cli(['gate', '--changed', 'PROJ-9'], db, { QA_SPINE_REQUIRE_HUMAN_ANSWERS: '1' }).code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an AI thumbs-up on an AI answer is not a person approving it', () => {
  const store = new TraceStore(':memory:');
  const { answer } = seedAnswered(store, 'ai');
  store.record({ type: 'review', content: { verdict: 'good', note: '' }, provenance: ai, links: [{ to: answer.id, relation: 'reviews' }] });
  assert.equal(open(store, true).length, 1);
});
