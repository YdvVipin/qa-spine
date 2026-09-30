import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TraceStore, assertRawRecordAllowed } from '../src/trace/store.ts';
import { createServer } from '../src/server.ts';
import { validateFixture, assertSupportedSchema, loadLocale, submitFixtures } from '../src/fixtures.ts';

const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-haiku-4-5' } as any;
const de = () => loadLocale('de-DE');

const CUSTOMER = {
  type: 'object',
  required: ['name', 'email', 'phone', 'postcode', 'tier'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 40 },
    email: { type: 'string', format: 'email' },
    phone: { type: 'string', format: 'phone' },
    postcode: { type: 'string', format: 'postal-code' },
    tier: { enum: ['free', 'pro'] },
    joined: { type: 'string', format: 'date' },
    refunds: { type: 'array', maxItems: 3, items: { type: 'number', minimum: 0 } },
  },
};
const GOOD = { name: 'Jana Weber', email: 'jana@example.de', phone: '+49 30 12345678', postcode: '10115', tier: 'pro', joined: '2026-03-01', refunds: [12.5] };

test('a fixture that satisfies the schema and the locale has no problems', () => {
  assert.deepEqual(validateFixture(CUSTOMER, GOOD, de()), []);
});

test('each broken rule is reported at its path', () => {
  const bad = { ...GOOD, name: '', email: 'not-an-email', phone: '555-0100', postcode: '1011', tier: 'gold', joined: '2026-02-30', refunds: [-1, 2, 3, 4], extra: true };
  const problems = validateFixture(CUSTOMER, bad, de());
  for (const path of ['$.name', '$.email', '$.phone', '$.postcode', '$.tier', '$.joined', '$.refunds', '$.refunds[0]', '$.extra']) {
    assert.ok(problems.some((p) => p.startsWith(path + ':')), `${path} in ${JSON.stringify(problems)}`);
  }
});

test('a missing required field and a wrong type are reported', () => {
  const problems = validateFixture(CUSTOMER, { ...GOOD, email: undefined, refunds: 'many' }, de());
  assert.ok(problems.some((p) => p.includes('$.email')));
  assert.ok(problems.some((p) => p.startsWith('$.refunds:') && p.includes('array')));
});

test('integer is stricter than number', () => {
  assert.deepEqual(validateFixture({ type: 'integer' }, 3, de()), []);
  assert.equal(validateFixture({ type: 'integer' }, 3.5, de()).length, 1);
});

test('the locale decides what a phone number and a postcode look like', () => {
  const us = loadLocale('en-US');
  assert.deepEqual(validateFixture({ type: 'string', format: 'postal-code' }, '94103', us), []);
  assert.deepEqual(validateFixture({ type: 'string', format: 'postal-code' }, 'SW1A 1AA', loadLocale('en-GB')), []);
  assert.equal(validateFixture({ type: 'string', format: 'postal-code' }, 'SW1A 1AA', us).length, 1);
  assert.deepEqual(validateFixture({ type: 'string', format: 'phone' }, '+91 98765 43210', loadLocale('en-IN')), []);
});

test('a schema keyword the validator does not check is refused, not ignored', () => {
  assert.throws(() => assertSupportedSchema({ type: 'object', properties: { a: { oneOf: [{ type: 'string' }] } } }), /unsupported keyword "oneOf" at \$\.a/);
  assert.throws(() => assertSupportedSchema({ type: 'string', format: 'hostname' }), /unsupported format "hostname"/);
  assert.throws(() => assertSupportedSchema({ type: 'object', additionalProperties: true }), /additionalProperties/);
  assert.doesNotThrow(() => assertSupportedSchema(CUSTOMER));
});

test('an unknown locale is refused with the ones that exist', () => {
  assert.throws(() => loadLocale('xx-XX'), /no locale pack "xx-XX".*de-DE/);
});

function seed(store: TraceStore) {
  const req = store.record({ type: 'requirement', sourceRef: 'PROJ-1', content: { text: 'r' }, provenance: human });
  return store.record({ type: 'test_case', content: { name: 't' }, provenance: human, links: [{ to: req.id, relation: 'covers' }] });
}

test('submitFixtures records one fixture artifact linked to what it serves, stamped with the pack', () => {
  const store = new TraceStore(':memory:');
  const tc = seed(store);
  const f = submitFixtures(store, { schema: CUSTOMER, locale: 'de-DE', fixtures: [GOOD, { ...GOOD, name: 'Lukas Braun' }], forId: tc.id, provenance: ai });
  assert.equal(f.type, 'fixture');
  assert.equal(f.content.count, 2);
  assert.equal(f.content.locale, 'de-DE');
  assert.match(String(f.content.schemaDigest), /^[0-9a-f]{64}$/);
  assert.equal(f.provenance.promptVersion, `fixtures/de-DE@${de().version}`);
  assert.deepEqual(store.edgesFrom(f.id).map((e) => [e.toArtifactId, e.relation]), [[tc.id, 'derived_from']]);
});

test('one bad fixture refuses the whole submission, naming it', () => {
  const store = new TraceStore(':memory:');
  const tc = seed(store);
  const before = store.list(undefined, 1e9).length;
  assert.throws(
    () => submitFixtures(store, { schema: CUSTOMER, locale: 'de-DE', fixtures: [GOOD, { ...GOOD, phone: '555' }], forId: tc.id, provenance: ai }),
    /fixture 1: \$\.phone/,
  );
  assert.equal(store.list(undefined, 1e9).length, before);
});

test('fixtures must serve a test case or requirement that exists, and there must be some', () => {
  const store = new TraceStore(':memory:');
  const tc = seed(store);
  assert.throws(() => submitFixtures(store, { schema: CUSTOMER, locale: 'de-DE', fixtures: [GOOD], forId: 'test_case_nope0000', provenance: ai }), /no test case or requirement/);
  assert.throws(() => submitFixtures(store, { schema: CUSTOMER, locale: 'de-DE', fixtures: [], forId: tc.id, provenance: ai }), /at least one/);
});

test('the raw write paths refuse a fixture', () => {
  assert.throws(() => assertRawRecordAllowed(new TraceStore(':memory:'), { type: 'fixture' }), /fixtures_submit/);
});

test('fixtures_request and fixtures_submit work over MCP', async () => {
  const store = new TraceStore(':memory:');
  const tc = seed(store);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer(store).connect(s);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(c);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
  };
  const req = await call('fixtures_request', { locale: 'de-DE' });
  assert.equal(req.body.locale.id, 'de-DE');
  assert.match(req.body.instructions, /fixtures_submit/);
  const sub = await call('fixtures_submit', { schema: CUSTOMER, locale: 'de-DE', fixtures: [GOOD], forId: tc.id, provenance: ai });
  assert.equal(sub.isError, false, JSON.stringify(sub.body));
  assert.equal(store.get(sub.body.id)!.type, 'fixture');
});

test('the CLI twins: fixtures-request prints the pack, fixtures-submit records from stdin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-fix-'));
  try {
    const db = join(dir, 'trace.db');
    const store = new TraceStore(db);
    const tc = seed(store);
    store.close();
    const env = { ...process.env, QA_SPINE_DB: db };
    assert.equal(JSON.parse(execFileSync('node', ['src/server.ts', 'fixtures-request', 'en-GB'], { encoding: 'utf8', env })).locale.id, 'en-GB');
    const out = execFileSync('node', ['src/server.ts', 'fixtures-submit'], {
      input: JSON.stringify({ schema: CUSTOMER, locale: 'de-DE', fixtures: [GOOD], forId: tc.id, provenance: ai }),
      encoding: 'utf8',
      env,
    });
    assert.equal(new TraceStore(db).get(JSON.parse(out).id)!.content.count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a locale id is held to the shape of a locale tag, so it cannot walk out of the directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-loc-'));
  try {
    // A readable JSON file outside the locales directory, shaped like a pack.
    writeFileSync(join(dir, 'evil.json'), JSON.stringify({ id: 'evil', version: '1', name: 'x', currency: 'X', formats: { phone: '.*', 'postal-code': '.*' } }));
    const rel = join('..', '..', '..', '..', '..', '..', '..', '..', dir, 'evil').replaceAll('\\', '/');
    assert.throws(() => loadLocale(rel), /no locale pack/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
