// Imports JIRA issues as requirements, so the ambiguity audit has real text to work on
// instead of hand-written fixtures.
//
//   JIRA_SITE=yourteam.atlassian.net JIRA_EMAIL=you@example.com JIRA_TOKEN=... \
//     node examples/import-jira.ts 'project = PROJ AND fixVersion = "2026.7.3"'
//
// Credentials are read from the environment and never written to disk. Nothing in src/
// knows what Jira is — this is a loader, not a feature.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TraceStore, recordRequirement } from '../src/trace/store.ts';

const { JIRA_SITE, JIRA_EMAIL, JIRA_TOKEN } = process.env;
if (!JIRA_SITE || !JIRA_EMAIL || !JIRA_TOKEN) {
  console.error('set JIRA_SITE, JIRA_EMAIL and JIRA_TOKEN in the environment');
  process.exit(1);
}
const jql = process.argv[2];
if (!jql) {
  console.error('usage: node examples/import-jira.ts "<jql>"');
  process.exit(1);
}
const pageSize = Number(process.env.JIRA_PAGE_SIZE ?? 100);
if (!Number.isInteger(pageSize) || pageSize < 1) {
  console.error('usage: JIRA_PAGE_SIZE must be a positive integer');
  process.exit(1);
}
// Overridable so tests can point the importer at a local fake.
const base = process.env.JIRA_API_URL ?? `https://${JIRA_SITE}`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// M4: `dirname()` from node:path, not a regex — `resolve()` first so a slash-free
// QA_SPINE_DB (e.g. `trace.db`) still has a real parent directory to create. A regex like
// `path.replace(/\/[^/]+$/, '')` is a no-op on that input, so `mkdirSync` would create a
// directory named `trace.db` and the store could never open it. src/server.ts does this
// the same way.
const path = resolve(process.env.QA_SPINE_DB ?? '.qa-spine/trace.db');
mkdirSync(dirname(path), { recursive: true });
const store = new TraceStore(path);

// Jira Cloud's v2 enhanced search (/rest/api/2/search/jql; the old /search returns 410).
// It pages by `nextPageToken` (no `startAt`, no `total`) until `isLast`, and returns ids
// only unless `fields` is explicit. v2, not v3: v3 returns `description` as Atlassian
// Document Format JSON, which would feed structural noise to the ambiguity rubric; v2
// returns a wiki-markup string. Every page is fetched before anything is written, so a
// failure on page 2 records nothing in this append-only store.
const headers = {
  authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64')}`,
  accept: 'application/json',
};
const MAX_PAGES = 100; // a guard, not a feature: stops a server that keeps sending tokens
const issues: any[] = [];
const seenTokens = new Set<string>();
let token: string | undefined;
for (let page = 1; ; page++) {
  if (page > MAX_PAGES) fail(`stopped after ${MAX_PAGES} pages; narrow the JQL`);
  const params = new URLSearchParams({ jql, maxResults: String(pageSize), fields: 'summary,description' });
  if (token) params.set('nextPageToken', token);
  const res = await fetch(`${base}/rest/api/2/search/jql?${params}`, { headers });
  if (!res.ok) fail(`jira ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const body = await res.json();
  issues.push(...(body.issues ?? []));
  // A short page is not the last page; only the token and `isLast` decide that.
  token = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
  if (!token || body.isLast === true) break;
  if (seenTokens.has(token)) fail('jira returned the same nextPageToken twice; stopping');
  seenTokens.add(token);
}

let imported = 0;
let skipped = 0;
let skippedNonText = 0;
for (const issue of issues) {
  // M5: only a string is accepted. v3 returns `description` as Atlassian Document Format
  // JSON, and `String({...})` stringifies to the non-blank '[object Object]' — that would
  // pass the blank check below and get recorded permanently into this append-only store.
  const description = issue.fields?.description;
  if (description != null && typeof description !== 'string') {
    skippedNonText++;
    continue;
  }
  const text = (description ?? '').trim();
  // audit_requirement rejects blank text anyway; skipping keeps the store honest.
  if (!text) {
    skipped++;
    continue;
  }
  // Versioned, not duplicated: an unchanged ticket writes nothing, an edited one supersedes
  // the version it replaces, so re-running an import is safe.
  recordRequirement(store, {
    type: 'requirement',
    sourceRef: issue.key,
    content: { text, summary: issue.fields?.summary ?? '' },
    provenance: { producer: 'human' },
  });
  imported++;
}

console.error(
  `imported ${imported} requirement(s) into ${path}; skipped ${skipped} with no description` +
    (skippedNonText ? `; skipped ${skippedNonText} with a non-text description (expected a v2 string)` : ''),
);
