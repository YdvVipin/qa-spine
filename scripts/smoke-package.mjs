#!/usr/bin/env node
/**
 * Installs a packed qa-spine tarball into a fresh project — under a path with a space in it —
 * and walks what a user does: version, init, record, ingest, gate, verify, export, the MCP
 * handshake and the Inspector. It tests the artifact that gets published, not the source
 * tree. Plain JavaScript, so it runs on the oldest supported Node, which cannot run .ts.
 *
 *   npm pack && node scripts/smoke-package.mjs qa-spine-0.4.0.tgz
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const tgz = process.argv[2] ? resolve(process.argv[2]) : assert.fail('usage: smoke-package.mjs <qa-spine-x.y.z.tgz>');
const work = mkdtempSync(join(tmpdir(), 'qa spine smoke '));
const win = process.platform === 'win32';
const env = { ...process.env, QA_SPINE_DB: join(work, '.qa-spine', 'trace.db') };
delete env.QA_SPINE_RUBRICS;

/** Windows runs npm and the bin shim as .cmd files, which need a shell — and quoting there. */
function run(cmd, args, { input, status = 0 } = {}) {
  const q = (s) => (win && /\s/.test(s) ? `"${s}"` : s);
  const r = spawnSync(q(cmd), args.map(q), { cwd: work, env, input, encoding: 'utf8', shell: win });
  assert.equal(r.status, status, `${cmd} ${args.join(' ')} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
const bin = join(work, 'node_modules', '.bin', win ? 'qa-spine.cmd' : 'qa-spine');
const qs = (args, opts) => run(bin, args, opts);
const step = (name) => console.log(`· ${name}`);

try {
  step(`install ${tgz}`);
  run(win ? 'npm.cmd' : 'npm', ['init', '-y']);
  run(win ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', tgz]);
  const pkgDir = join(work, 'node_modules', 'qa-spine');
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

  step('version and packaged assets');
  assert.equal(qs(['--version']).trim(), pkg.version);
  for (const f of ['rubrics/ambiguity.json', 'locales/en-US.json', 'dist/inspector/ui/index.html', 'dist/inspector/ui/app.js']) {
    assert.ok(existsSync(join(pkgDir, f)), `the package is missing ${f}`);
  }

  step('init uses the project rubric');
  assert.match(qs(['init']), /Audits use .*rubrics/);
  assert.ok(existsSync(join(work, 'rubrics', 'ambiguity.json')));

  step('record, ingest, gate');
  qs(['record'], { input: JSON.stringify({ type: 'requirement', sourceRef: 'PROJ-1', content: { text: 'Refunds post within one day.' }, provenance: { producer: 'human' } }) });
  writeFileSync(
    join(work, 'report.xml'),
    '<testsuite name="refunds"><testcase classname="refunds" name="PROJ-1 posts within a day"/></testsuite>',
  );
  qs(['ingest-junit', 'report.xml', '--commit', 'c1', '--run-ref', 'smoke']);
  assert.equal(JSON.parse(qs(['gate', '--changed', 'PROJ-1', '--commit', 'c1', '--json'])).decision, 'SHIP');
  assert.equal(JSON.parse(qs(['gate', '--text', 'PROJ-1: tidy', '--commit', 'c2', '--json'], { status: 2 })).decision, 'UNKNOWN');

  step('verify and export');
  qs(['verify']);
  assert.match(qs(['export', '--format', 'html']), /PROJ-1/);

  step('MCP handshake');
  const require = createRequire(join(work, 'package.json'));
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(pkgDir, 'dist', 'server.js')], env, cwd: work }));
  assert.equal(client.getServerVersion().version, pkg.version);
  assert.ok((await client.listTools()).tools.some((t) => t.name === 'assess_release_risk'));
  await client.close();

  step('Inspector serves its page');
  const port = String(47000 + Math.floor(Math.random() * 2000));
  const inspector = spawn(process.execPath, [join(pkgDir, 'dist', 'server.js'), 'inspect', '--port', port], { cwd: work, env, stdio: 'ignore' });
  try {
    let page;
    for (let i = 0; i < 50 && !page; i++) {
      page = await fetch(`http://127.0.0.1:${port}/`).then((r) => (r.ok ? r.text() : undefined), () => undefined);
      if (!page) await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(page ?? '', /<html/i, 'the Inspector did not serve its page');
  } finally {
    // Wait for it to go: on Windows a live process holding the folder as its cwd blocks the
    // cleanup below with EBUSY.
    if (inspector.exitCode === null && inspector.signalCode === null) {
      const exited = once(inspector, 'exit');
      inspector.kill();
      await exited;
    }
  }

  console.log(`ok — qa-spine ${pkg.version} on Node ${process.version} (${process.platform})`);
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}
