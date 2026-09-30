import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';

const REPO = process.cwd();
const human = { producer: 'human' as const };
const ai = { producer: 'ai' as const, model: 'claude-opus-5', promptVersion: 'ambiguity/1' };

/** One requirement with one answered question and one still open — the smallest store that
 *  can produce both a live signal and a clean pass, depending on which ref is asked about. */
function seed(dbPath: string) {
  const store = new TraceStore(dbPath);
  const req = store.record({
    type: 'requirement',
    sourceRef: 'PROJ-42',
    content: { text: 'Refunds must be processed quickly and the customer notified appropriately.' },
    provenance: human,
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
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
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
    provenance: ai,
    links: [{ to: req.id, relation: 'derived_from' }],
  });
  store.record({
    type: 'answer',
    sourceRef: 'PROJ-42',
    content: { text: 'Within three business days.' },
    provenance: human,
    links: [{ to: answered.id, relation: 'supersedes' }],
  });
  // A second requirement with nothing open, so a clean pass is reachable from real data
  // rather than only from a ref that matches nothing.
  store.record({
    type: 'requirement',
    sourceRef: 'PROJ-7',
    content: { text: 'The refund button is disabled while a refund is in flight.' },
    provenance: human,
  });
  return { store, req, open };
}

function withStore(fn: (ctx: { dir: string; db: string; store: TraceStore; open: string }) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-gate-'));
  try {
    const db = join(dir, 'trace.db');
    const { store, open } = seed(db);
    fn({ dir, db, store, open: open.id });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gate(args: string[], db: string, cwd = REPO): { code: number; out: string; err: string } {
  try {
    const out = execFileSync('node', [resolve(REPO, 'src/server.ts'), 'gate', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, QA_SPINE_DB: db },
    });
    return { code: 0, out, err: '' };
  } catch (err: any) {
    return { code: err.status ?? 1, out: err.stdout ?? '', err: err.stderr ?? '' };
  }
}

function count(db: string): number {
  return new TraceStore(db).list(undefined, 1e9).length;
}

test('a live question blocks and is named in the output', () => {
  withStore(({ db }) => {
    const { code, out } = gate(['--changed', 'PROJ-42'], db);
    assert.equal(code, 1, 'a live signal must fail the check');
    assert.match(out, /release blocked/);
    assert.match(out, /What happens when notification delivery fails\?/);
  });
});

test('a requirement with nothing open passes', () => {
  withStore(({ db }) => {
    const { code, out } = gate(['--changed', 'PROJ-7'], db);
    assert.equal(code, 0);
    assert.match(out, /no blockers/);
  });
});

test('advisory mode writes nothing, even when given a release ref', () => {
  withStore(({ db }) => {
    const before = count(db);
    gate(['--changed', 'PROJ-42'], db);
    gate(['--changed', 'PROJ-7'], db);
    // With --release-ref but no --record. Everything a write needs is present except the
    // flag that asks for one; the realistic regression is treating the ref as consent.
    const { out } = gate(['--changed', 'PROJ-7', '--release-ref', 'v9.9.9', '--json'], db);
    assert.equal(JSON.parse(out).recorded, null);
    assert.equal(count(db), before, 'the default mode must never append to the ledger');
  });
});

test('--json emits one object and no prose', () => {
  withStore(({ db, open }) => {
    const { out } = gate(['--changed', 'PROJ-42', '--json'], db);
    const parsed = JSON.parse(out);
    assert.equal(parsed.shippable, false);
    assert.equal(parsed.signals.length, 1);
    assert.equal(parsed.signals[0].findingId, open);
    assert.equal(parsed.recorded, null);
  });
});

test('unmatched refs are counted in full but sampled to five', () => {
  withStore(({ db }) => {
    const refs = Array.from({ length: 9 }, (_, i) => `src/file-${i}.ts`);
    const { out } = gate(['--changed', ['PROJ-7', ...refs].join(','), '--json'], db);
    const parsed = JSON.parse(out);
    assert.equal(parsed.unmatched.count, 9, 'every unmatched ref must be counted');
    assert.equal(parsed.unmatched.sample.length, 5, 'only five are shown');
  });
});

test('nothing to assess is an error, not a pass', () => {
  withStore(({ db }) => {
    const { code, err } = gate([], db);
    assert.equal(code, 2);
    assert.match(err, /nothing to assess/);
  });
});

test('an empty store is an error, not a clean release', () => {
  withStore(({ dir }) => {
    const empty = join(dir, 'empty.db');
    const { code, err } = gate(['--changed', 'PROJ-42'], empty);
    assert.equal(code, 2, 'an empty store must never report a green check');
    assert.match(err, /empty/);
  });
});

// --- deriving refs from git -------------------------------------------------

function scratchRepo(dir: string): string {
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  execFileSync('sh', ['-c', 'echo one > first.txt'], { cwd: dir });
  run('add', 'first.txt');
  run('commit', '-qm', 'chore: base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  execFileSync('sh', ['-c', 'echo two > refund.ts'], { cwd: dir });
  run('add', 'refund.ts');
  run('commit', '-qm', 'fix(PROJ-42): handle a failed notification');
  return base;
}

test('--since derives both changed paths and ticket keys from git', () => {
  withStore(({ db }) => {
    const repo = mkdtempSync(join(tmpdir(), 'qa-spine-git-'));
    try {
      const base = scratchRepo(repo);
      const { code, out } = gate(['--since', base, '--json'], db, repo);
      const parsed = JSON.parse(out);
      assert.ok(parsed.changed.includes('refund.ts'), 'the changed path must be derived');
      assert.ok(parsed.changed.includes('PROJ-42'), 'the ticket key must be read from the message');
      assert.equal(code, 1, 'PROJ-42 has a live question, so this must block');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

test('--since against an unknown ref fails rather than reporting no changes', () => {
  withStore(({ db }) => {
    const repo = mkdtempSync(join(tmpdir(), 'qa-spine-git-'));
    try {
      scratchRepo(repo);
      const { code, err } = gate(['--since', 'no-such-ref', '--json'], db, repo);
      assert.equal(code, 2, 'a git failure must not degrade to a clean release');
      // Specifically the git invocation, not merely the word "git": swallowing the git
      // error leaves zero refs, which trips the nothing-to-assess guard whose message also
      // says "git" — so a looser pattern here passes whether or not this guard exists.
      assert.match(err, /git .* failed/);
      assert.doesNotMatch(err, /nothing to assess/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// --- recording --------------------------------------------------------------

test('--record with no live question records a ship, produced by the tool', () => {
  withStore(({ db }) => {
    const { code, out } = gate(
      ['--changed', 'PROJ-7', '--record', '--release-ref', 'v1.0.0', '--json'],
      db,
    );
    assert.equal(code, 0);
    const verdictId = JSON.parse(out).recorded.verdictId;

    const verdict = new TraceStore(db).get(verdictId)!;
    assert.equal(verdict.content.verdict, 'ship');
    assert.equal(verdict.provenance.producer, 'tool');
    assert.equal(verdict.provenance.tool, 'qa-spine gate');
    assert.ok(verdict.provenance.toolVersion, 'the gate must record which version decided');
  });
});

test('--record with a live question records a hold and still fails the check', () => {
  withStore(({ db, open }) => {
    const { code, out } = gate(
      ['--changed', 'PROJ-42', '--record', '--release-ref', 'v1.0.1', '--json'],
      db,
    );
    assert.equal(code, 1, 'recording a hold must not turn the check green');
    const parsed = JSON.parse(out);
    assert.equal(parsed.recorded.verdict, 'hold');

    const verdict = new TraceStore(db).get(parsed.recorded.verdictId)!;
    assert.deepEqual(verdict.content.liveFindings, [open]);
    assert.equal(verdict.content.override, null);
  });
});

test('an override with nobody named is refused and records nothing', () => {
  withStore(({ db }) => {
    const before = count(db);
    const { code, err } = gate(
      ['--changed', 'PROJ-42', '--record', '--release-ref', 'v1.0.2', '--override-reason', 'hotfix'],
      db,
    );
    assert.equal(code, 2);
    assert.match(err, /--approved-by/);
    assert.equal(count(db), before, 'a refused override must not append to the ledger');
  });
});

test('a named override ships and records who accepted the risk', () => {
  withStore(({ db, open }) => {
    const { code, out } = gate(
      [
        '--changed', 'PROJ-42',
        '--record', '--release-ref', 'v1.0.3',
        '--override-reason', 'Hotfix for a payment outage; the open question is tracked separately.',
        '--approved-by', 'r.mehta',
        '--json',
      ],
      db,
    );
    assert.equal(code, 0, 'a named override must let the release through');
    const verdict = new TraceStore(db).get(JSON.parse(out).recorded.verdictId)!;

    assert.equal(verdict.content.verdict, 'ship');
    assert.equal(verdict.provenance.approvedBy, 'r.mehta');
    assert.ok(verdict.provenance.approvedAt, 'when it was approved is recorded too');
    assert.deepEqual((verdict.content.override as any).findings, [open], 'what it overrode is recorded');
  });
});

test('--summary writes Markdown while stdout stays JSON, in one run', () => {
  withStore(({ dir, db }) => {
    const summary = join(dir, 'gate.md');
    const before = count(db);

    const { out } = gate(
      ['--changed', 'PROJ-7', '--record', '--release-ref', 'v2', '--json', '--summary', summary],
      db,
    );

    JSON.parse(out); // stdout must stay machine-readable
    assert.match(readFileSync(summary, 'utf8'), /## qa-spine/);
    // The reason --summary exists: a caller wanting both formats must not have to run the
    // gate twice, because under --record that appends a second verdict nothing can remove.
    assert.equal(count(db), before + 1, 'exactly one verdict for one run');
  });
});

test('--brief writes a readable page for the verdict it just recorded', () => {
  withStore(({ dir, db }) => {
    const briefPath = join(dir, 'brief.html');
    gate(
      ['--changed', 'PROJ-42', '--record', '--release-ref', 'v1.0.4', '--brief', briefPath],
      db,
    );
    assert.ok(existsSync(briefPath));
    const html = readFileSync(briefPath, 'utf8');
    assert.match(html, /Not ready to ship/);
    assert.match(html, /What happens when notification delivery fails\?/);
    assert.match(html, /Recorded automatically by qa-spine gate/);
  });
});

/** A test covering PROJ-7 (which has no open questions), with runs recorded oldest first. */
function addTest(store: TraceStore, runs: { status: string; commit?: string; message?: string }[]) {
  const req = store.bySourceRef(['PROJ-7']).find((a) => a.type === 'requirement')!;
  const tool = { producer: 'tool' as const, tool: 'qa-spine ingest-junit' };
  const tc = store.record({
    type: 'test_case',
    sourceRef: 'junit:refunds::button disables',
    content: { name: 'button disables', classname: 'refunds' },
    provenance: tool,
    links: [{ to: req.id, relation: 'covers' }],
  });
  return runs.map((content) =>
    store.record({ type: 'test_run', sourceRef: 'ci/9', content, provenance: tool, links: [{ to: tc.id, relation: 'verifies' }] }).id,
  );
}

test('a failing test on a changed requirement blocks and is named', () => {
  withStore(({ db, store }) => {
    addTest(store, [{ status: 'failed', message: 'button stayed enabled' }]);
    const { code, out } = gate(['--changed', 'PROJ-7'], db);
    assert.equal(code, 1);
    assert.match(out, /release blocked/);
    assert.match(out, /1 failing test on areas this change touches/);
    assert.match(out, /button disables/);
    assert.match(out, /button stayed enabled/);
  });
});

test('--json keeps signals to questions and lists failing tests separately', () => {
  withStore(({ db, store }) => {
    const [run] = addTest(store, [{ status: 'error' }]);
    const r = JSON.parse(gate(['--changed', 'PROJ-7', '--json'], db).out);
    assert.equal(r.shippable, false);
    assert.deepEqual(r.signals, []);
    assert.equal(r.failingTests.length, 1);
    assert.equal(r.failingTests[0].testRunId, run);
    assert.equal(r.failingTests[0].status, 'error');
  });
});

test('a flaky failing test still blocks, and says it is flaky', () => {
  withStore(({ db, store }) => {
    addTest(store, [{ status: 'passed', commit: 'c1' }, { status: 'failed', commit: 'c1' }]);
    const { code, out } = gate(['--changed', 'PROJ-7'], db);
    assert.equal(code, 1, 'flaky is reported, never excused');
    assert.match(out, /button disables.*flaky/);
  });
});

test('a flaky test whose latest run passed does not block but is listed', () => {
  withStore(({ db, store }) => {
    addTest(store, [{ status: 'failed', commit: 'c1' }, { status: 'passed', commit: 'c1' }]);
    const { code, out } = gate(['--changed', 'PROJ-7'], db);
    assert.equal(code, 0);
    assert.match(out, /no blockers/);
    assert.match(out, /1 flaky test/);
    const r = JSON.parse(gate(['--changed', 'PROJ-7', '--json'], db).out);
    assert.deepEqual(r.flakyTests.map((t: any) => t.name), ['button disables']);
  });
});

test('--record over a failing test records a hold naming the run, in plain words', () => {
  withStore(({ db, store }) => {
    const [run] = addTest(store, [{ status: 'failed' }]);
    const { code, out } = gate(['--changed', 'PROJ-7', '--record', '--release-ref', 'v3', '--json'], db);
    assert.equal(code, 1);
    const verdict = new TraceStore(db).get(JSON.parse(out).recorded.verdictId)!;
    assert.equal(verdict.content.verdict, 'hold');
    assert.deepEqual(verdict.content.liveTestRuns, [run]);
    assert.match(String(verdict.content.reason), /tests? .*failing/i);
  });
});

test('a named override ships over a failing test and records the run it overrode', () => {
  withStore(({ db, store }) => {
    const [run] = addTest(store, [{ status: 'failed' }]);
    const { code, out } = gate(
      ['--changed', 'PROJ-7', '--record', '--release-ref', 'v4', '--override-reason', 'Stubbed email provider is down.', '--approved-by', 'a.rivera', '--json'],
      db,
    );
    assert.equal(code, 0);
    const verdict = new TraceStore(db).get(JSON.parse(out).recorded.verdictId)!;
    assert.equal(verdict.content.verdict, 'ship');
    assert.deepEqual((verdict.content.override as any).testRuns, [run]);
  });
});

test('one failing test covering two changed requirements is one failing test', () => {
  withStore(({ db, store }) => {
    const second = store.record({ type: 'requirement', sourceRef: 'PROJ-8', content: { text: 'r8' }, provenance: human });
    const [run] = addTest(store, [{ status: 'failed' }]);
    const tc = store.edgesFrom(run).find((e) => e.relation === 'verifies')!.toArtifactId;
    store.link(tc, second.id, 'covers');
    const { out } = gate(['--changed', 'PROJ-7,PROJ-8'], db);
    assert.match(out, /\*\*1 failing test on areas/);
    assert.equal(JSON.parse(gate(['--changed', 'PROJ-7,PROJ-8', '--json'], db).out).failingTests.length, 1);
  });
});
