// Seeds one complete spine so the Inspector has something to show before the agents exist.
//   node examples/seed-demo.ts && npm run inspect
import { mkdirSync } from 'node:fs';
import { TraceStore } from '../src/trace/store.ts';

const path = process.argv[2] ?? process.env.QA_SPINE_DB ?? '.qa-spine/trace.db';
mkdirSync(path.replace(/\/[^/]+$/, ''), { recursive: true });
const s = new TraceStore(path);
const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-opus-5', promptVersion: 'sha256:9f2a1c', inputDigest: 'sha256:71bd0e' };

const req = s.record({
  type: 'requirement',
  sourceRef: 'PROJ-42',
  content: { text: 'Refunds must be processed quickly and the customer notified appropriately.' },
  provenance: human,
});
const f1 = s.record({
  type: 'finding',
  content: { category: 'vague_qualifier', severity: 'high', quote: 'quickly', why: 'No time bound is given, so no test can decide pass or fail.', suggestedRewrite: 'within 3 business days', confidence: 'high' },
  provenance: ai,
  links: [{ to: req.id, relation: 'derived_from' }],
});
const f2 = s.record({
  type: 'finding',
  content: { category: 'missing_negative_path', severity: 'medium', quote: 'notified appropriately', why: 'Behaviour when notification delivery fails is unspecified.', confidence: 'unknown' },
  provenance: ai,
  links: [{ to: req.id, relation: 'derived_from' }],
});
const tc = s.record({
  type: 'test_case',
  sourceRef: 'tests/refund.spec.ts:14',
  content: { name: 'refund completes and emails the customer' },
  provenance: human,
  links: [{ to: req.id, relation: 'covers' }, { to: f1.id, relation: 'supersedes' }],
});
const run = s.record({
  type: 'test_run',
  sourceRef: 'ci/run/8812',
  content: { status: 'failed', durationMs: 4100, message: 'timed out waiting for notification' },
  provenance: human,
  links: [{ to: tc.id, relation: 'verifies' }],
});
s.record({
  type: 'verdict',
  sourceRef: 'release/2026.7.3',
  content: { verdict: 'hold', reason: 'PROJ-42 notification-failure ambiguity was flagged at requirement stage, never resolved, and the touching test now fails.' },
  provenance: ai,
  links: [{ to: run.id, relation: 'derived_from' }, { to: f2.id, relation: 'derived_from' }],
});

console.error(`seeded ${path}: requirement ${req.id} -> unresolved finding ${f2.id} -> hold verdict`);
