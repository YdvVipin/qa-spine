import type { TraceStore } from '../src/trace/store.ts';

/**
 * A covering test whose latest run passed, from qa-spine's own ingest. Since 0.4 a requirement
 * ships only with evidence, so a test about something else (briefs, dropped areas, retractions)
 * gives its requirement this rather than relying on "no tests" reading as clean.
 */
export function passingTest(store: TraceStore, requirementId: string) {
  const tc = store.record({
    type: 'test_case',
    content: { name: 'covering test' },
    provenance: { producer: 'human' },
    links: [{ to: requirementId, relation: 'covers' }],
  });
  store.record({
    type: 'test_run',
    content: { status: 'passed' },
    provenance: { producer: 'tool', tool: 'qa-spine ingest-junit' },
    links: [{ to: tc.id, relation: 'verifies' }],
  });
  return tc;
}
