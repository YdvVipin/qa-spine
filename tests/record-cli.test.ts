import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs the subcommand against a throwaway DB. Returns exit code and parsed stdout. */
function runRecord(payload: unknown, db: string): { code: number; out: Record<string, any> } {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  try {
    const stdout = execFileSync('node', ['src/server.ts', 'record'], {
      input,
      encoding: 'utf8',
      env: { ...process.env, QA_SPINE_DB: db },
    });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (err: any) {
    return { code: err.status ?? 1, out: JSON.parse(err.stdout || '{}') };
  }
}

function withDb(fn: (db: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-cli-'));
  try {
    fn(join(dir, 'trace.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('record appends a human artifact and prints it', () => {
  withDb((db) => {
    const { code, out } = runRecord(
      {
        type: 'requirement',
        sourceRef: 'SCRUM-42',
        content: { text: 'Refunds must be processed quickly.' },
        provenance: { producer: 'human' },
      },
      db,
    );
    assert.equal(code, 0);
    assert.ok(String(out.id).startsWith('requirement_'), `unexpected id: ${out.id}`);
    assert.equal(out.sourceRef, 'SCRUM-42');
  });
});

test('record rejects an AI artifact with no model and writes nothing', () => {
  withDb((db) => {
    const { code, out } = runRecord(
      {
        type: 'test_case',
        content: { name: 'login works' },
        provenance: { producer: 'ai' },
      },
      db,
    );
    assert.equal(code, 1);
    assert.match(String(out.error), /model and promptVersion/);
  });
});

test('record rejects malformed JSON with a readable error', () => {
  withDb((db) => {
    const { code, out } = runRecord('{not json', db);
    assert.equal(code, 1);
    assert.ok(out.error, 'expected an error field');
    assert.doesNotMatch(String(out.error), /\n\s+at /, 'error should not be a raw stack trace');
  });
});

test('record rejects a link to an artifact that does not exist', () => {
  withDb((db) => {
    const { code, out } = runRecord(
      {
        type: 'test_case',
        content: { name: 'orphan' },
        provenance: { producer: 'human' },
        links: [{ to: 'requirement_deadbeef', relation: 'covers' }],
      },
      db,
    );
    assert.equal(code, 1);
    assert.match(String(out.error), /does not exist/);
  });
});
