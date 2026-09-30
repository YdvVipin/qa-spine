// Imports a Linear team's issues as requirements, keyed by identifier (ENG-123), which the
// gate's default ticket pattern already matches.
//
//   LINEAR_API_KEY=lin_api_... node examples/import-linear.ts ENG
//
// The key is read from the environment and never written to disk. LINEAR_API_URL overrides
// the endpoint. Nothing in src/ knows what Linear is — this is a loader.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TraceStore, recordRequirement } from '../src/trace/store.ts';

const { LINEAR_API_KEY } = process.env;
const team = process.argv[2];
if (!LINEAR_API_KEY || !team) {
  console.error('usage: LINEAR_API_KEY=... node examples/import-linear.ts <TEAM-KEY>');
  process.exit(1);
}

const path = resolve(process.env.QA_SPINE_DB ?? '.qa-spine/trace.db');
mkdirSync(dirname(path), { recursive: true });
const store = new TraceStore(path);

// ponytail: the first 100 issues, no pagination. Follow `pageInfo.endCursor` if you need more.
const query = `query($team: String!) {
  issues(first: 100, filter: { team: { key: { eq: $team } } }) { nodes { identifier title description } }
}`;
const res = await fetch(process.env.LINEAR_API_URL ?? 'https://api.linear.app/graphql', {
  method: 'POST',
  headers: { authorization: LINEAR_API_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ query, variables: { team } }),
});
const body = (await res.json().catch(() => ({}))) as any;
// GraphQL reports failure in the body, often with a 200. Either way it must not read as
// "this team has no issues".
if (!res.ok || body.errors?.length || !body.data) {
  console.error(`linear ${res.status}: ${body.errors?.map((e: any) => e.message).join('; ') ?? 'no data returned'}`);
  process.exit(1);
}

let imported = 0;
let skipped = 0;
for (const issue of body.data.issues.nodes) {
  const text = typeof issue.description === 'string' ? issue.description.trim() : '';
  if (!text) {
    skipped++;
    continue;
  }
  recordRequirement(store, {
    type: 'requirement',
    sourceRef: issue.identifier,
    content: { text, summary: issue.title ?? '' },
    provenance: { producer: 'human' },
  });
  imported++;
}

console.error(`imported ${imported} requirement(s) into ${path}; skipped ${skipped} with no description`);
