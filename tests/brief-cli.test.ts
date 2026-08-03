import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';

/**
 * M6: `brief` is the one CLI path whose output gets redirected straight to a file (unlike
 * `record`, which prints JSON on both success and failure). A refactor that let an error
 * path fall through to `console.log` would silently turn a failed run into a "document"
 * containing an error page instead of an empty file — this is the guard against that.
 */
function runBrief(args: string[], db: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', ['src/server.ts', 'brief', ...args], {
      encoding: 'utf8',
      env: { ...process.env, QA_SPINE_DB: db },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err: any) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function withDb(fn: (db: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-brief-cli-'));
  try {
    fn(join(dir, 'trace.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('brief with a missing arg exits 1 with zero bytes on stdout', () => {
  withDb((db) => {
    const { code, stdout } = runBrief([], db);
    assert.equal(code, 1);
    assert.equal(stdout, '');
  });
});

test('brief given an unknown verdict id exits 1 with zero bytes on stdout', () => {
  withDb((db) => {
    new TraceStore(db).close();
    const { code, stdout } = runBrief(['verdict_deadbeef'], db);
    assert.equal(code, 1);
    assert.equal(stdout, '');
  });
});

test('brief given a non-verdict id exits 1 with zero bytes on stdout', () => {
  withDb((db) => {
    const store = new TraceStore(db);
    const req = store.record({
      type: 'requirement',
      sourceRef: 'PROJ-1',
      content: { text: 'Refunds must be processed quickly.' },
      provenance: { producer: 'human' },
    });
    store.close();

    const { code, stdout } = runBrief([req.id], db);
    assert.equal(code, 1);
    assert.equal(stdout, '');
  });
});

test('brief given a valid verdict id exits 0 and emits HTML', () => {
  withDb((db) => {
    const store = new TraceStore(db);
    const verdict = store.record({
      type: 'verdict',
      sourceRef: 'release/1',
      content: {
        verdict: 'ship',
        reason: 'Nothing outstanding.',
        changed: ['PROJ-1'],
        unmatched: [],
        override: null,
        liveFindings: [],
      },
      provenance: { producer: 'human' },
    });
    store.close();

    const { code, stdout } = runBrief([verdict.id], db);
    assert.equal(code, 0);
    assert.match(stdout, /^<!doctype html>/i);
    assert.match(stdout, /Cleared to ship/);
  });
});
