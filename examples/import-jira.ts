// Imports JIRA issues as requirements, so the ambiguity audit has real text to work on
// instead of hand-written fixtures.
//
//   JIRA_SITE=yourteam.atlassian.net JIRA_EMAIL=you@example.com JIRA_TOKEN=... \
//     node examples/import-jira.ts 'project = PROJ AND fixVersion = "2026.7.3"'
//
// Credentials are read from the environment and never written to disk. Nothing in src/
// knows what Jira is — this is a loader, not a feature.
import { mkdirSync } from 'node:fs';
import { TraceStore } from '../src/trace/store.ts';

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

const path = process.env.QA_SPINE_DB ?? '.qa-spine/trace.db';
mkdirSync(path.replace(/\/[^/]+$/, ''), { recursive: true });
const store = new TraceStore(path);

// v2, not v3: v3 returns `description` as Atlassian Document Format JSON, which would feed
// structural noise to the ambiguity rubric. v2 returns a plain string.
//
// ponytail: one page, maxResults=50, no pagination. Enough to audit a release. If you need
// more, follow `startAt` until `total` is reached. Atlassian has also been migrating
// /search to /search/jql — if this 404s or 410s, that is the line to change.
const url =
  `https://${JIRA_SITE}/rest/api/2/search` +
  `?jql=${encodeURIComponent(jql)}&maxResults=50&fields=summary,description`;

const res = await fetch(url, {
  headers: {
    authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64')}`,
    accept: 'application/json',
  },
});
if (!res.ok) {
  console.error(`jira ${res.status}: ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}

let imported = 0;
let skipped = 0;
for (const issue of (await res.json()).issues ?? []) {
  const text = String(issue.fields?.description ?? '').trim();
  // audit_requirement rejects blank text anyway; skipping keeps the store honest.
  if (!text) {
    skipped++;
    continue;
  }
  store.record({
    type: 'requirement',
    sourceRef: issue.key,
    content: { text, summary: issue.fields?.summary ?? '' },
    provenance: { producer: 'human' },
  });
  imported++;
}

console.error(
  `imported ${imported} requirement(s) into ${path}; skipped ${skipped} with no description`,
);
