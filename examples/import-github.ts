// Imports open GitHub issues as requirements, keyed `#<number>` so the gate matches the
// "Fixes #123" in a commit message. Run the gate with `--ticket-pattern '#\d+'`.
//
//   GITHUB_TOKEN=... node examples/import-github.ts owner/repo [label]
//
// GITHUB_TOKEN is optional for a public repository. GITHUB_API_URL points at GitHub
// Enterprise (https://github.example.com/api/v3). Credentials are read from the environment
// and never written to disk. Nothing in src/ knows what GitHub is — this is a loader.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TraceStore, recordRequirement } from '../src/trace/store.ts';

const [repo, label] = process.argv.slice(2);
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('usage: node examples/import-github.ts owner/repo [label]');
  process.exit(1);
}

const path = resolve(process.env.QA_SPINE_DB ?? '.qa-spine/trace.db');
mkdirSync(dirname(path), { recursive: true });
const store = new TraceStore(path);

// ponytail: one page of 100, no pagination. Enough to audit a release; follow the `Link`
// header's rel="next" if you need more.
const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const url = `${api}/repos/${repo}/issues?state=open&per_page=100` + (label ? `&labels=${encodeURIComponent(label)}` : '');
const res = await fetch(url, {
  headers: {
    accept: 'application/vnd.github+json',
    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  },
});
if (!res.ok) {
  console.error(`github ${res.status}: ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}

let imported = 0;
let skipped = 0;
for (const issue of (await res.json()) as any[]) {
  // The issues endpoint returns pull requests too. A pull request is a change, not a requirement.
  if (issue.pull_request) continue;
  const text = typeof issue.body === 'string' ? issue.body.trim() : '';
  if (!text) {
    skipped++;
    continue;
  }
  // Versioned, not duplicated: an unchanged issue writes nothing, an edited one supersedes.
  recordRequirement(store, {
    type: 'requirement',
    sourceRef: `#${issue.number}`,
    content: { text, summary: issue.title ?? '' },
    provenance: { producer: 'human' },
  });
  imported++;
}

console.error(`imported ${imported} requirement(s) into ${path}; skipped ${skipped} with no description`);
