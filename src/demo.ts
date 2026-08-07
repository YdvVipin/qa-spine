import { rmSync, writeFileSync } from 'node:fs';
import { TraceStore } from './trace/store.ts';
import { recordVerdict } from './release.ts';
import { renderBrief } from './brief.ts';

/**
 * One worked example: a requirement, two questions raised against it, one answered
 * and one not, a test that fails, and a release held because of the one nobody
 * answered. It is the product's whole argument in seven artifacts.
 *
 * Both quotes are verbatim substrings of the requirement text and both categories are
 * real rubric rule ids, so this data would survive `audit_submit`'s validation — not
 * merely `store.record`'s. The old examples/seed-demo.ts did not, which is why its
 * verdict rendered a brief with empty sections.
 */
const AI = { producer: 'ai' as const, model: 'claude-haiku-4-5', promptVersion: 'ambiguity/1' };
const HUMAN = { producer: 'human' as const };

const REQUIREMENT_TEXT =
  'Refunds must be processed quickly and the customer notified appropriately.';

export function seedDemo(store: TraceStore): { verdictId: string } {
  const requirement = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-42',
    content: { text: REQUIREMENT_TEXT },
    provenance: HUMAN,
  });

  const answered = store.record({
    type: 'finding',
    sourceRef: 'PROJ-42',
    content: {
      category: 'AMB-VAGUE-QUANT',
      quote: 'processed quickly',
      question: 'What measurable threshold makes a refund quick?',
      confidence: 'high',
    },
    provenance: AI,
    links: [{ to: requirement.id, relation: 'derived_from' }],
  });

  const open = store.record({
    type: 'finding',
    sourceRef: 'PROJ-42',
    content: {
      category: 'AMB-UNTESTABLE',
      quote: 'notified appropriately',
      question: 'What happens when notification delivery fails?',
      confidence: 'unknown',
    },
    provenance: AI,
    links: [{ to: requirement.id, relation: 'derived_from' }],
  });

  store.record({
    type: 'answer',
    sourceRef: 'PROJ-42',
    content: { text: 'Within three business days, measured from approval.' },
    provenance: HUMAN,
    links: [
      { to: answered.id, relation: 'supersedes' },
      { to: requirement.id, relation: 'derived_from' },
    ],
  });

  const testCase = store.record({
    type: 'test_case',
    sourceRef: 'features/refund.feature',
    content: { name: 'refund completes and emails the customer' },
    provenance: AI,
    links: [{ to: requirement.id, relation: 'covers' }],
  });

  store.record({
    type: 'test_run',
    sourceRef: 'ci/run/8812',
    content: {
      status: 'failed',
      run_passed: false,
      message: 'timed out waiting for notification',
    },
    provenance: HUMAN,
    links: [{ to: testCase.id, relation: 'verifies' }],
  });

  // Through the real recordVerdict, never store.record. That computes liveFindings from
  // actual signals and subjects this reason to the prose lint — so if the gate ever
  // regresses, the demo fails loudly instead of seeding a verdict no real call could
  // have produced.
  const verdict = recordVerdict(store, {
    releaseRef: 'release/2026.8.1',
    verdict: 'hold',
    reason:
      'One question raised when this work was specified was never answered, and it ' +
      'touches an area this release changed.',
    cites: [open.id, requirement.id],
    changed: ['PROJ-42'],
    provenance: { producer: 'ai', model: 'claude-opus-5', promptVersion: 'release-brief/1' },
  });

  return { verdictId: verdict.id };
}

/**
 * Seed a throwaway store and render its brief.
 *
 * The database is deleted first: the ledger is append-only, so re-running would
 * otherwise stack a second copy of the arc that nothing could remove.
 *
 * ponytail: one hardcoded arc, no flags to vary it and no way to seed a clean ship.
 * Fine for a first-run demo; a second scenario becomes a flag when somebody asks.
 */
export function runDemo(dbPath: string, briefPath: string): { store: TraceStore; verdictId: string } {
  rmSync(dbPath, { force: true });
  const store = new TraceStore(dbPath);
  const { verdictId } = seedDemo(store);
  writeFileSync(briefPath, renderBrief(store, verdictId));
  return { store, verdictId };
}
