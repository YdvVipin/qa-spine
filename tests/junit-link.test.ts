/**
 * A5: a test is linked to its story at ingest. Through the real CLI, end to end to the gate:
 * a ticket key in the test name, a key only in a <property name="requirement"> (what RatifyQA
 * sends), or a --map file for suites whose test names carry no key at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';

const SERVER = resolve('src/server.ts');

function cli(args: string[], db: string) {
  try {
    return { code: 0, out: execFileSync('node', [SERVER, ...args], { encoding: 'utf8', env: { ...process.env, QA_SPINE_DB: db } }), err: '' };
  } catch (err: any) {
    return { code: err.status as number, out: (err.stdout ?? '') as string, err: (err.stderr ?? '') as string };
  }
}

/** A store with one story, PROJ-7, and nothing covering it yet. */
function withStory(fn: (dir: string, db: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-link-'));
  try {
    const db = join(dir, 'trace.db');
    const s = new TraceStore(db);
    s.record({ type: 'requirement', sourceRef: 'PROJ-7', content: { text: 'Refund emails are sent.' }, provenance: { producer: 'human' } });
    s.close();
    fn(dir, db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const write = (dir: string, name: string, body: string) => {
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
};
const count = (db: string) => {
  const s = new TraceStore(db);
  const n = s.list(undefined, 1e9).length;
  s.close();
  return n;
};
const gate = (db: string) => {
  const r = cli(['gate', '--changed', 'PROJ-7', '--json'], db);
  return { code: r.code, decision: JSON.parse(r.out).decision as string };
};

/** One passing test named "email is sent": no ticket key anywhere in its name or classname. */
const UNKEYED = '<testsuite><testcase classname="refunds" name="email is sent"/></testsuite>';

test('a ticket key in the test name links it to the story, and its pass counts at the gate', () => {
  withStory((dir, db) => {
    const r = cli(['ingest-junit', write(dir, 'r.xml', '<testsuite><testcase classname="refunds" name="PROJ-7 email is sent"/></testsuite>'), '--commit', 'c1'], db);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(gate(db), { code: 0, decision: 'SHIP' });
  });
});

test('a key only in <property name="requirement"> links the test (what RatifyQA sends)', () => {
  withStory((dir, db) => {
    const xml =
      '<testsuite><testcase classname="refunds" name="email is sent">' +
      '<properties><property name="requirement" value="PROJ-7"/></properties></testcase></testsuite>';
    assert.equal(cli(['ingest-junit', write(dir, 'r.xml', xml), '--commit', 'c1'], db).code, 0);
    assert.deepEqual(gate(db), { code: 0, decision: 'SHIP' });
  });
});

test('without a key or a map, the test is recorded but links nothing: the story has no test', () => {
  withStory((dir, db) => {
    const r = JSON.parse(cli(['ingest-junit', write(dir, 'r.xml', UNKEYED), '--commit', 'c1'], db).out);
    assert.equal(r.unkeyed, 1);
    assert.deepEqual(gate(db), { code: 2, decision: 'UNKNOWN' });
  });
});

test('--map links a test by name, and by classname::name, to one key or several', () => {
  withStory((dir, db) => {
    const xml =
      '<testsuite><testcase classname="refunds" name="email is sent"/>' +
      '<testcase classname="refunds" name="amount is right"/></testsuite>';
    const map = write(dir, 'map.json', JSON.stringify({ 'email is sent': 'PROJ-7', 'refunds::amount is right': ['PROJ-7', 'PROJ-8'] }));
    const r = cli(['ingest-junit', write(dir, 'r.xml', xml), '--map', map, '--commit', 'c1'], db);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.unkeyed, 0);
    assert.deepEqual(out.uncovered, ['PROJ-8'], 'a mapped key with no story is reported, like a key in a name');
    assert.deepEqual(gate(db), { code: 0, decision: 'SHIP' });
  });
});

test('--map adds to the keys a name already carries; it does not replace them', () => {
  withStory((dir, db) => {
    const s = new TraceStore(db);
    s.record({ type: 'requirement', sourceRef: 'PROJ-8', content: { text: 'Amounts are right.' }, provenance: { producer: 'human' } });
    s.close();
    const xml = '<testsuite><testcase classname="refunds" name="PROJ-8 email is sent"/></testsuite>';
    const map = write(dir, 'map.json', JSON.stringify({ 'PROJ-8 email is sent': 'PROJ-7' }));
    assert.equal(cli(['ingest-junit', write(dir, 'r.xml', xml), '--map', map, '--commit', 'c1'], db).code, 0);
    assert.equal(gate(db).decision, 'SHIP');
    assert.equal(JSON.parse(cli(['gate', '--changed', 'PROJ-8', '--json'], db).out).decision, 'SHIP');
  });
});

test('a map entry naming a test the reports lack is reported, not silently ignored', () => {
  withStory((dir, db) => {
    const map = write(dir, 'map.json', JSON.stringify({ 'email is sent': 'PROJ-7', 'email is snet': 'PROJ-7' }));
    const out = JSON.parse(cli(['ingest-junit', write(dir, 'r.xml', UNKEYED), '--map', map, '--commit', 'c1'], db).out);
    assert.deepEqual(out.unusedMapEntries, ['email is snet']);
  });
});

test('a map that cannot be used stops the ingest before anything is written, and says why', () => {
  withStory((dir, db) => {
    const report = write(dir, 'r.xml', UNKEYED);
    const before = count(db);
    const cases: [string, RegExp][] = [
      ['{not json', /map\.json is not valid JSON/],
      ['["PROJ-7"]', /map\.json must be an object/],
      ['{"email is sent": 7}', /"email is sent".*a key or a list of keys/],
      ['{"email is sent": ["PROJ-7", " "]}', /"email is sent".*a key or a list of keys/],
    ];
    for (const [body, message] of cases) {
      const r = cli(['ingest-junit', report, '--map', write(dir, 'map.json', body)], db);
      assert.equal(r.code, 2, body);
      assert.match(r.err, message, body);
      assert.equal(count(db), before, `nothing written for ${body}`);
    }
    const missing = cli(['ingest-junit', report, '--map', join(dir, 'nope.json')], db);
    assert.equal(missing.code, 2);
    assert.match(missing.err, /cannot read .*nope\.json/);
  });
});
