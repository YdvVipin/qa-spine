import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';
import { submitFindings, recordAnswer, openQuestions } from '../src/audit.ts';
import { recordVerdict } from '../src/release.ts';
import { renderBrief } from '../src/brief.ts';

const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-haiku-4-5' } as any;
const TEXT = 'Refunds must be processed quickly and the customer notified appropriately.';
const SUGGESTION = 'Within three business days of approval.';

function seed(store: TraceStore, suggestedAnswer: string | undefined = SUGGESTION) {
  const req = store.record({ type: 'requirement', sourceRef: 'PROJ-42', content: { text: TEXT }, provenance: human });
  const [finding] = submitFindings(store, {
    requirementId: req.id,
    findings: [{ category: 'AMB-VAGUE-QUANT', quote: 'processed quickly', question: 'How quick is quick?', confidence: 'high', ...(suggestedAnswer ? { suggestedAnswer } : {}) }],
    provenance: ai,
  });
  return { req, finding };
}

test('a finding can carry a suggested answer, and the queue shows it', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  assert.equal(finding.content.suggestedAnswer, SUGGESTION);
  assert.equal(openQuestions(store).open[0].suggestedAnswer, SUGGESTION);
});

test('a suggested answer must be plain language, like the question', () => {
  const store = new TraceStore(':memory:');
  assert.throws(() => seed(store, 'Link a test_case to requirement_9f8e21ab.'), /suggestedAnswer contains internal terminology/);
});

test('accepting the suggestion word for word marks the answer as an assumption', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const answer = recordAnswer(store, { findingId: finding.id, answer: `  ${SUGGESTION} `, provenance: human });
  assert.equal(answer.content.assumption, true);
});

test('an answer in the answerer\'s own words is not an assumption', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const answer = recordAnswer(store, { findingId: finding.id, answer: 'Two business days, from the moment of approval.', provenance: human });
  assert.equal('assumption' in answer.content, false);
});

test('an answer records who gave it when a name is supplied', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const answer = recordAnswer(store, { findingId: finding.id, answer: 'Two days.', provenance: human, by: 'a.rivera' });
  assert.equal(answer.content.answeredBy, 'a.rivera');
});

test('a verdict records the assumptions behind the areas it covers, and the brief shows them', () => {
  const store = new TraceStore(':memory:');
  const { finding } = seed(store);
  const answer = recordAnswer(store, { findingId: finding.id, answer: SUGGESTION, provenance: human });
  const verdict = recordVerdict(store, { releaseRef: 'r', verdict: 'ship', reason: 'All answered.', cites: [], changed: ['PROJ-42'], provenance: human });
  assert.deepEqual(verdict.content.assumptions, [answer.id]);
  const html = renderBrief(store, verdict.id).split(/<footer/i)[0];
  assert.match(html, /Answered by accepting a suggested default/);
  assert.match(html, /How quick is quick\?/);
  assert.match(html, /Within three business days of approval\./);
  assert.ok(!html.includes(answer.id));
});

// --- the CLI ---

function cli(args: string[], db: string) {
  try {
    return { code: 0, out: execFileSync('node', ['src/server.ts', ...args], { encoding: 'utf8', env: { ...process.env, QA_SPINE_DB: db } }), err: '' };
  } catch (err: any) {
    return { code: err.status, out: err.stdout as string, err: err.stderr as string };
  }
}

function withStore(fn: (db: string, ids: { finding: string }) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-answer-'));
  try {
    const db = join(dir, 'trace.db');
    const store = new TraceStore(db);
    const { finding } = seed(store);
    store.close();
    fn(db, { finding: finding.id });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('qa-spine answer records a named human answer and unblocks the gate', () => withStore((db, { finding }) => {
  assert.equal(cli(['gate', '--changed', 'PROJ-42'], db).code, 1);
  const { code, out } = cli(['answer', finding, 'Two business days.', '--by', 'a.rivera'], db);
  assert.equal(code, 0);
  const answer = new TraceStore(db).get(JSON.parse(out).id)!;
  assert.equal(answer.provenance.producer, 'human');
  assert.equal(answer.content.answeredBy, 'a.rivera');
  assert.equal(cli(['gate', '--changed', 'PROJ-42'], db).code, 0);
}));

test('qa-spine answer --accept-suggestion records the suggestion as an assumption', () => withStore((db, { finding }) => {
  const { out } = cli(['answer', finding, '--accept-suggestion', '--by', 'a.rivera'], db);
  const answer = new TraceStore(db).get(JSON.parse(out).id)!;
  assert.equal(answer.content.text, SUGGESTION);
  assert.equal(answer.content.assumption, true);
}));

test('qa-spine answer without a name, or without text, is refused', () => withStore((db, { finding }) => {
  assert.equal(cli(['answer', finding, 'Two days.'], db).code, 1);
  assert.equal(cli(['answer', finding, '--by', 'a.rivera'], db).code, 1);
  assert.equal(new TraceStore(db).list('answer').length, 0);
}));

test('the blocked gate summary gives the exact commands that unblock it', () => withStore((db, { finding }) => {
  const { out } = cli(['gate', '--changed', 'PROJ-42'], db);
  assert.ok(out.includes(`qa-spine answer ${finding} "<your answer>" --by <your name>`), out);
  assert.ok(out.includes(`qa-spine answer ${finding} --accept-suggestion --by <your name>`), out);
  assert.match(out, /Suggested: Within three business days of approval\./);
  assert.match(out, /--override-reason "<why>" --approved-by <your name>/);
}));
