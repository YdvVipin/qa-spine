/**
 * The GitHub Action and the gate's CI inputs (research R13). A PR title is attacker-written
 * text: it reaches the Action as data, and the gate reads ticket keys out of it rather than
 * treating the whole title as one requirement ID.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';
import { runGate } from '../src/gate.ts';
import { passingTest } from './support.ts';

const ACTION = readFileSync('action.yml', 'utf8');

/** Each `run:` script in action.yml, by indentation — no YAML dependency for one file. */
function runScripts(): string[] {
  const lines = ACTION.split('\n');
  const scripts: string[] = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m) return;
    if (m[2] !== '|') return void scripts.push(m[2]);
    const indent = m[1].length;
    const body: string[] = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() && next.length - next.trimStart().length <= indent) break;
      body.push(next);
    }
    scripts.push(body.join('\n'));
  });
  return scripts;
}

test('action.yml: no ${{ }} expression inside a run script — every value arrives through env', () => {
  const scripts = runScripts();
  assert.ok(scripts.length >= 3, 'found the run scripts');
  for (const s of scripts) assert.doesNotMatch(s, /\$\{\{/);
});

/** Stands in for npx: a shell function, so nothing is executed from a temp directory. */
const STUB_NPX =
  'npx() { printf "%s\\0" "$@" >> "$NPX_LOG"; ' +
  'if printf "%s\\n" "$@" | grep -qx gate; then echo "# summary" > gate.md; echo \'{"decision":"SHIP","shippable":true}\'; else echo "{}"; fi; }\n';

/** Runs the Action's main step under bash with a stub npx that records what it was asked. */
function runStep(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-action-'));
  try {
    const script = runScripts().find((s) => s.includes('verify.json'))!;
    for (const f of ['out', 'summary']) writeFileSync(join(dir, f), '');
    const r = spawnSync('bash', ['-e', '-c', STUB_NPX + script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        NPX_LOG: join(dir, 'npx.log'),
        GITHUB_OUTPUT: join(dir, 'out'),
        GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        QS_VERSION: 'latest',
        ...env,
      },
    });
    const log = existsSync(join(dir, 'npx.log')) ? readFileSync(join(dir, 'npx.log'), 'utf8').split('\0') : [];
    return { status: r.status, stderr: r.stdout + r.stderr, log, pwned: existsSync(join(dir, 'pwned')), out: readFileSync(join(dir, 'out'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HOSTILE = 'PROJ-42: fix "$(touch pwned)" `touch pwned` ; touch pwned\nnext line';

test('Action: hostile text, refs, reasons and patterns reach the gate as literal arguments', () => {
  const r = runStep({
    QS_TEXT: HOSTILE,
    QS_CHANGED: '$(touch pwned)',
    QS_REASON: '`touch pwned`',
    QS_OVERRIDE_REASON: '$(touch pwned)',
    QS_APPROVED_BY: 'a; touch pwned',
    QS_RELEASE_REF: 'v1$(touch pwned)',
    QS_TICKET_PATTERN: '[A-Z]+-\\d+',
  });
  assert.equal(r.pwned, false, 'nothing from the inputs ran');
  assert.equal(r.status, 0, r.stderr);
  const gate = r.log.slice(r.log.indexOf('gate'));
  assert.equal(gate[gate.indexOf('--text') + 1], HOSTILE);
  assert.equal(gate[gate.indexOf('--changed') + 1], '$(touch pwned)');
  assert.equal(gate[gate.indexOf('--approved-by') + 1], 'a; touch pwned');
  assert.match(r.out, /decision=SHIP/);
});

test('Action: a version that is not a release or dist-tag is refused before npx runs', () => {
  for (const v of ['npm:other-package', '1.0.0 other', 'file:../x', 'https://example.com/x.tgz']) {
    const r = runStep({ QS_VERSION: v });
    assert.equal(r.status, 2, v);
    assert.deepEqual(r.log, [], `npx never ran for ${v}`);
  }
  assert.equal(runStep({ QS_VERSION: '0.4.0' }).status, 0);
  assert.equal(runStep({ QS_VERSION: '0.4.0-rc.1' }).status, 0);
});

function withStore(fn: (db: string, store: TraceStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-text-'));
  const db = join(dir, 'trace.db');
  const store = new TraceStore(db);
  try {
    const req = store.record({ type: 'requirement', sourceRef: 'PROJ-42', content: { text: 'Refunds post within a day.' }, provenance: { producer: 'human' } });
    passingTest(store, req.id);
    fn(db, store);
  } finally {
    try {
      store.close();
    } catch {} // the CLI test closes it first, to let another process open the file
    rmSync(dir, { recursive: true, force: true });
  }
}

test('gate text: ticket keys are read out of a PR title, not the title taken as one ref', () => {
  withStore((_db, store) => {
    const r = runGate(store, { changed: [], text: ['PROJ-42: Refund copy (follow-up to OPS-9)'] });
    assert.deepEqual(r.changed.sort(), ['OPS-9', 'PROJ-42']);
    assert.equal(r.decision, 'SHIP');
  });
});

test('gate text: text with no ticket key gives nothing to assess, not a clean pass', () => {
  withStore((_db, store) => {
    assert.throws(() => runGate(store, { changed: [], text: ['Bump dependencies'] }), /nothing to assess/);
  });
});

test('CLI: gate --text extracts keys with --ticket-pattern', () => {
  withStore((db, store) => {
    store.close();
    const out = execFileSync('node', ['src/server.ts', 'gate', '--text', 'proj-42 tidy; PROJ-42 again, see OPS-9', '--ticket-pattern', 'PROJ-\\d+', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, QA_SPINE_DB: db },
    });
    assert.deepEqual(JSON.parse(out).changed, ['PROJ-42']);
  });
});
