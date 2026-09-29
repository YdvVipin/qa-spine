import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';

const REPO = process.cwd();

function run(sub: string, args: string[], db: string, cwd = REPO) {
  try {
    const out = execFileSync('node', [resolve(REPO, 'src/server.ts'), sub, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, QA_SPINE_DB: db },
    });
    return { code: 0, out, err: '' };
  } catch (err: any) {
    return { code: err.status ?? 1, out: err.stdout ?? '', err: err.stderr ?? '' };
  }
}

function withDir(fn: (dir: string, db: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-junit-'));
  try {
    const db = join(dir, 'trace.db');
    const store = new TraceStore(db);
    store.record({ type: 'requirement', sourceRef: 'PROJ-7', content: { text: 'r' }, provenance: { producer: 'human' } });
    store.close();
    fn(dir, db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FAILING = '<testsuite><testcase classname="refunds" name="PROJ-7 email sent"><failure message="no email"/></testcase></testsuite>';
const count = (db: string) => new TraceStore(db).list(undefined, 1e9).length;

test('ingest-junit records a report and prints what it did as JSON', () => {
  withDir((dir, db) => {
    const file = join(dir, 'junit.xml');
    writeFileSync(file, FAILING);
    const { code, out } = run('ingest-junit', [file, '--run-ref', 'https://ci/run/5', '--commit', 'abc'], db);
    assert.equal(code, 0);
    const r = JSON.parse(out);
    assert.equal(r.runs.length, 1);
    const stored = new TraceStore(db).get(r.runs[0].testRunId)!;
    assert.equal(stored.sourceRef, 'https://ci/run/5');
    assert.equal(stored.content.commit, 'abc');
    assert.equal(stored.provenance.toolVersion !== undefined, true);
  });
});

test('ingest-junit defaults the commit to HEAD inside a git repository', () => {
  withDir((dir, db) => {
    const file = join(dir, 'junit.xml');
    writeFileSync(file, FAILING);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    const r = JSON.parse(run('ingest-junit', [file], db).out);
    assert.equal(new TraceStore(db).get(r.runs[0].testRunId)!.content.commit, head);
  });
});

test('ingest-junit outside a git repository records no commit rather than failing', () => {
  withDir((dir, db) => {
    const file = join(dir, 'junit.xml');
    writeFileSync(file, FAILING);
    const { code, out } = run('ingest-junit', [file], db, dir);
    assert.equal(code, 0);
    assert.equal(new TraceStore(db).get(JSON.parse(out).runs[0].testRunId)!.content.commit, undefined);
  });
});

test('a missing file or no file at all exits 2 and writes nothing', () => {
  withDir((dir, db) => {
    const good = join(dir, 'good.xml');
    writeFileSync(good, FAILING);
    const before = count(db);
    const missing = run('ingest-junit', [good, join(dir, 'nope.xml')], db);
    assert.equal(missing.code, 2);
    assert.match(missing.err, /nope\.xml/);
    assert.equal(run('ingest-junit', [], db).code, 2);
    assert.equal(count(db), before);
  });
});

test('an ingested failing test blocks the gate, end to end', () => {
  withDir((dir, db) => {
    const file = join(dir, 'junit.xml');
    writeFileSync(file, FAILING);
    assert.equal(run('ingest-junit', [file], db).code, 0);
    const gate = run('gate', ['--changed', 'PROJ-7'], db);
    assert.equal(gate.code, 1);
    assert.match(gate.out, /PROJ-7 email sent/);
  });
});
