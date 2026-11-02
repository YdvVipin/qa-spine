import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { TraceStore } from '../src/trace/store.ts';

/** A stand-in API: answers every request with `body`, and remembers what it was asked. */
async function fakeApi(t: TestContext, body: unknown) {
  const seen: { url: string; auth: string | undefined; payload: string }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let payload = '';
    req.on('data', (c) => (payload += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, payload });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/**
 * A stand-in paged API: picks the page by the `nextPageToken` query parameter ('' for the
 * first request) and answers with its `status` (default 200) and `body`.
 */
async function fakePagedApi(t: TestContext, pages: Record<string, { status?: number; body: unknown }>) {
  const seen: { url: URL; auth: string | undefined }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '', 'http://fake');
    seen.push({ url, auth: req.headers.authorization });
    const page = pages[url.searchParams.get('nextPageToken') ?? ''] ?? { status: 404, body: { error: 'no such page' } };
    res.statusCode = page.status ?? 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(page.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** Runs an importer asynchronously, so the fake API in this process can answer it. */
function run(script: string, args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; err: string }>((resolve) => {
    execFile('node', [script, ...args], { env: { ...process.env, ...env } }, (error: any, _out, err) =>
      resolve({ code: error ? error.code ?? 1 : 0, err }),
    );
  });
}

function scratch(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-import-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'trace.db');
}

const ISSUES = [
  { number: 12, title: 'Refunds', body: 'Refunds must be processed quickly.' },
  { number: 13, title: 'A pull request', body: 'Not a requirement.', pull_request: { url: 'x' } },
  { number: 14, title: 'Empty', body: null },
];

test('the GitHub importer records open issues as #N requirements, skipping pull requests and empty bodies', async (t) => {
  const api = await fakeApi(t, ISSUES);
  const db = scratch(t);
  const env = { GITHUB_API_URL: api.url, GITHUB_TOKEN: 'secret', QA_SPINE_DB: db };
  const { code, err } = await run('examples/import-github.ts', ['acme/shop', 'requirement'], env);
  assert.equal(code, 0, err);
  const reqs = new TraceStore(db).list('requirement');
  assert.deepEqual(reqs.map((r) => [r.sourceRef, r.content.text]), [['#12', 'Refunds must be processed quickly.']]);
  assert.equal(api.seen[0].url, '/repos/acme/shop/issues?state=open&per_page=100&labels=requirement');
  assert.equal(api.seen[0].auth, 'Bearer secret');
  assert.match(err, /imported 1 requirement\(s\).*skipped 1 with no description/);
});

test('re-running the GitHub importer on unchanged issues writes nothing', async (t) => {
  const api = await fakeApi(t, ISSUES);
  const db = scratch(t);
  const env = { GITHUB_API_URL: api.url, QA_SPINE_DB: db };
  await run('examples/import-github.ts', ['acme/shop'], env);
  await run('examples/import-github.ts', ['acme/shop'], env);
  assert.equal(new TraceStore(db).list('requirement').length, 1);
  assert.equal(api.seen[1].auth, undefined, 'a public repository needs no token');
});

test('the Linear importer records a team\'s issues by identifier', async (t) => {
  const api = await fakeApi(t, {
    data: { issues: { nodes: [
      { identifier: 'ENG-7', title: 'Receipts', description: 'Receipts are emailed appropriately.' },
      { identifier: 'ENG-8', title: 'Blank', description: '' },
    ] } },
  });
  const db = scratch(t);
  const { code, err } = await run('examples/import-linear.ts', ['ENG'], { LINEAR_API_URL: api.url, LINEAR_API_KEY: 'lin_key', QA_SPINE_DB: db });
  assert.equal(code, 0, err);
  assert.deepEqual(new TraceStore(db).list('requirement').map((r) => [r.sourceRef, r.content.text]), [['ENG-7', 'Receipts are emailed appropriately.']]);
  assert.equal(api.seen[0].auth, 'lin_key');
  assert.deepEqual(JSON.parse(api.seen[0].payload).variables, { team: 'ENG' });
});

test('the Linear importer reports an API error rather than importing nothing quietly', async (t) => {
  const api = await fakeApi(t, { errors: [{ message: 'Authentication required' }] });
  const db = scratch(t);
  const { code, err } = await run('examples/import-linear.ts', ['ENG'], { LINEAR_API_URL: api.url, LINEAR_API_KEY: 'bad', QA_SPINE_DB: db });
  assert.equal(code, 1);
  assert.match(err, /Authentication required/);
});

test('each importer refuses to run without its arguments', async (t) => {
  const db = scratch(t);
  // Asserting the message, not just the exit code: without the check, each script would
  // go on to call the real API and fail there, which also exits 1.
  const github = await run('examples/import-github.ts', [], { QA_SPINE_DB: db });
  assert.equal(github.code, 1);
  assert.match(github.err, /usage: node examples\/import-github\.ts/);
  const linear = await run('examples/import-linear.ts', ['ENG'], { QA_SPINE_DB: db, LINEAR_API_KEY: '' });
  assert.equal(linear.code, 1);
  assert.match(linear.err, /usage: LINEAR_API_KEY/);
  const jira = await run('examples/import-jira.ts', [], { ...JIRA_ENV, QA_SPINE_DB: db });
  assert.equal(jira.code, 1);
  assert.match(jira.err, /usage: node examples\/import-jira\.ts/);
  const noSite = await run('examples/import-jira.ts', ['project = PROJ'], { ...JIRA_ENV, JIRA_SITE: '', QA_SPINE_DB: db });
  assert.equal(noSite.code, 1);
  assert.match(noSite.err, /set JIRA_SITE, JIRA_EMAIL and JIRA_TOKEN/);
});

// Dummy credentials only. JIRA_API_URL points the importer at the local fake.
const JIRA_ENV = { JIRA_SITE: 'example.invalid', JIRA_EMAIL: 'qa@example.com', JIRA_TOKEN: 'test-token' };
const JQL = 'project = PROJ ORDER BY key';
const issue = (key: string, description: unknown) => ({ key, fields: { summary: `${key} summary`, description } });
const TWO_PAGES = {
  '': { body: { issues: [issue('PROJ-1', 'Refunds complete within a day.'), issue('PROJ-2', 'Receipts are emailed.')], nextPageToken: 'p2', isLast: false } },
  p2: { body: { issues: [issue('PROJ-3', 'Exports include every column.')], isLast: true } },
};

test('the Jira importer follows nextPageToken through /rest/api/2/search/jql', async (t) => {
  const api = await fakePagedApi(t, TWO_PAGES);
  const db = scratch(t);
  const { code, err } = await run('examples/import-jira.ts', [JQL], { ...JIRA_ENV, JIRA_API_URL: api.url, QA_SPINE_DB: db });
  assert.equal(code, 0, err);
  assert.deepEqual(
    new TraceStore(db).list('requirement').map((r) => [r.sourceRef, r.content.text]).sort(),
    [['PROJ-1', 'Refunds complete within a day.'], ['PROJ-2', 'Receipts are emailed.'], ['PROJ-3', 'Exports include every column.']],
  );
  assert.equal(api.seen.length, 2);
  for (const { url, auth } of api.seen) {
    assert.equal(url.pathname, '/rest/api/2/search/jql');
    assert.equal(url.searchParams.get('jql'), JQL);
    assert.equal(url.searchParams.get('fields'), 'summary,description');
    assert.equal(url.searchParams.has('startAt'), false);
    assert.equal(auth, `Basic ${Buffer.from('qa@example.com:test-token').toString('base64')}`);
  }
  assert.equal(api.seen[0].url.searchParams.has('nextPageToken'), false);
  assert.equal(api.seen[1].url.searchParams.get('nextPageToken'), 'p2');
  assert.match(err, /imported 3 requirement\(s\)/);
});

test('the Jira importer handles an empty result in one request', async (t) => {
  const api = await fakePagedApi(t, { '': { body: { issues: [], isLast: true } } });
  const db = scratch(t);
  const { code, err } = await run('examples/import-jira.ts', [JQL], { ...JIRA_ENV, JIRA_API_URL: api.url, QA_SPINE_DB: db });
  assert.equal(code, 0, err);
  assert.equal(new TraceStore(db).list('requirement').length, 0);
  assert.equal(api.seen.length, 1);
  assert.match(err, /imported 0 requirement\(s\)/);
});

test('an error on page 2 makes the Jira importer write nothing', async (t) => {
  const api = await fakePagedApi(t, { '': TWO_PAGES[''], p2: { status: 500, body: { errorMessages: ['boom'] } } });
  const db = scratch(t);
  const { code, err } = await run('examples/import-jira.ts', [JQL], { ...JIRA_ENV, JIRA_API_URL: api.url, QA_SPINE_DB: db });
  assert.equal(code, 1);
  assert.match(err, /jira 500/);
  assert.equal(new TraceStore(db).list('requirement').length, 0);
});

test('the Jira importer reports a 410 from a removed endpoint', async (t) => {
  const api = await fakePagedApi(t, { '': { status: 410, body: { errorMessages: ['gone'] } } });
  const db = scratch(t);
  const { code, err } = await run('examples/import-jira.ts', [JQL], { ...JIRA_ENV, JIRA_API_URL: api.url, QA_SPINE_DB: db });
  assert.equal(code, 1);
  assert.match(err, /jira 410/);
});

test('the Jira importer skips an ADF description instead of storing [object Object]', async (t) => {
  const api = await fakePagedApi(t, { '': { body: {
    issues: [issue('PROJ-1', 'Refunds complete within a day.'), issue('PROJ-2', { type: 'doc', version: 1, content: [] })],
    isLast: true,
  } } });
  const db = scratch(t);
  const { code, err } = await run('examples/import-jira.ts', [JQL], { ...JIRA_ENV, JIRA_API_URL: api.url, QA_SPINE_DB: db });
  assert.equal(code, 0, err);
  assert.deepEqual(new TraceStore(db).list('requirement').map((r) => r.sourceRef), ['PROJ-1']);
  assert.match(err, /imported 1 requirement\(s\).*skipped 0 with no description; skipped 1 with a non-text description/);
});

test('re-running the Jira importer on unchanged issues writes nothing', async (t) => {
  const api = await fakePagedApi(t, TWO_PAGES);
  const db = scratch(t);
  const env = { ...JIRA_ENV, JIRA_API_URL: api.url, QA_SPINE_DB: db };
  await run('examples/import-jira.ts', [JQL], env);
  await run('examples/import-jira.ts', [JQL], env);
  assert.equal(new TraceStore(db).list('requirement').length, 3);
  assert.equal(api.seen.length, 4);
});
