/**
 * R12: `init` copies the rubric and says it is yours to edit, so an edit has to change the
 * next audit. Precedence: QA_SPINE_RUBRICS, then ./rubrics in the project, then the package.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';

const SERVER = resolve('src/server.ts');
const PACKAGE_VERSION = JSON.parse(readFileSync('rubrics/ambiguity.json', 'utf8')).version;

function inProject(fn: (dir: string, cli: (args: string[], extra?: { input?: string; env?: NodeJS.ProcessEnv }) => string, requirementId: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-rubric-'));
  const db = join(dir, '.qa-spine', 'trace.db');
  const env = { ...process.env, QA_SPINE_DB: db };
  delete env.QA_SPINE_RUBRICS;
  const cli = (args: string[], extra: { input?: string; env?: NodeJS.ProcessEnv } = {}) =>
    execFileSync('node', [SERVER, ...args], { cwd: dir, encoding: 'utf8', input: extra.input, env: { ...env, ...extra.env } });
  try {
    mkdirSync(join(dir, '.qa-spine'));
    const store = new TraceStore(db);
    const req = store.record({ type: 'requirement', sourceRef: 'PROJ-1', content: { text: 'Refunds post quickly.' }, provenance: { producer: 'human' } });
    store.close();
    fn(dir, cli, req.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rubricVersion = (out: string) => JSON.parse(out).rubric.version;

function editVersion(file: string, version: string) {
  const rubric = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...rubric, version }));
}

test('the rubric init copies is the one the next audit uses, and its version is stamped on the result', () => {
  inProject((dir, cli, id) => {
    const init = cli(['init']);
    assert.ok(init.includes(`Audits use ${join(dir, 'rubrics', 'ambiguity.json')}.`), init);
    editVersion(join(dir, 'rubrics', 'ambiguity.json'), 'customer-custom/99');

    assert.equal(rubricVersion(cli(['audit-requirement', id])), 'customer-custom/99');
    cli(['audit-submit'], { input: JSON.stringify({ requirementId: id, findings: [], provenance: { producer: 'ai', model: 'm' } }) });

    const store = new TraceStore(join(dir, '.qa-spine', 'trace.db'));
    const audit = store.list('audit')[0];
    store.close();
    assert.equal(audit.provenance.promptVersion, 'customer-custom/99');
  });
});

test('QA_SPINE_RUBRICS wins over ./rubrics; with neither, the package rubric is used', () => {
  inProject((dir, cli, id) => {
    assert.equal(rubricVersion(cli(['audit-requirement', id])), PACKAGE_VERSION);

    cli(['init']);
    editVersion(join(dir, 'rubrics', 'ambiguity.json'), 'project/1');
    const team = join(dir, 'team-rubrics');
    mkdirSync(team);
    writeFileSync(join(team, 'ambiguity.json'), readFileSync(join(dir, 'rubrics', 'ambiguity.json')));
    editVersion(join(team, 'ambiguity.json'), 'team/1');

    assert.equal(rubricVersion(cli(['audit-requirement', id], { env: { QA_SPINE_RUBRICS: team } })), 'team/1');
    assert.equal(rubricVersion(cli(['audit-requirement', id])), 'project/1');
  });
});
