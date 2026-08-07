import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `npm install` puts the bin on disk as node_modules/.bin/qa-spine -> dist/server.js, so
 * every published invocation reaches the entrypoint through a symlink. The main-module
 * guard used to compare argv[1] (the link) against import.meta.filename (the target) and
 * silently did nothing — exit 0, no output. This runs the CLI the way an installer does.
 */
test('the CLI still runs when invoked through a bin symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-bin-'));
  try {
    const link = join(dir, 'qa-spine');
    symlinkSync(resolve('src/server.ts'), link);

    let stdout: string;
    let code = 0;
    try {
      stdout = execFileSync('node', [link, 'audit-requirement'], {
        encoding: 'utf8',
        env: { ...process.env, QA_SPINE_DB: join(dir, 'trace.db') },
      });
    } catch (err: any) {
      code = err.status ?? 1;
      stdout = err.stdout ?? '';
    }

    assert.equal(code, 1);
    assert.match(JSON.parse(stdout).error, /^usage: qa-spine audit-requirement/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
