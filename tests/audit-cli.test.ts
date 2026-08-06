import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';

/** Runs a subcommand against a throwaway DB. Returns exit code and parsed stdout. */
function run(args: string[], db: string, input?: string): { code: number; out: Record<string, any> } {
  try {
    const stdout = execFileSync('node', ['src/server.ts', ...args], {
      input: input ?? '',
      encoding: 'utf8',
      env: { ...process.env, QA_SPINE_DB: db },
    });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (err: any) {
    return { code: err.status ?? 1, out: JSON.parse(err.stdout || '{}') };
  }
}

/** A real file DB, because the subprocess needs a path it can open. */
function withDb(fn: (db: string, seed: () => string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-audit-'));
  const db = join(dir, 'trace.db');
  try {
    fn(db, () => {
      const store = new TraceStore(db);
      const req = store.record({
        type: 'requirement',
        sourceRef: 'PROJ-42',
        content: { text: 'Refunds must be processed quickly and the customer notified.' },
        provenance: { producer: 'human' },
      });
      store.close();
      return req.id;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('audit-requirement hands over the requirement, the rubric and the instructions', () => {
  withDb((db, seed) => {
    const id = seed();
    const { code, out } = run(['audit-requirement', id], db);
    assert.equal(code, 0);
    assert.equal(out.requirement.id, id);
    assert.match(out.requirement.text, /Refunds must be processed quickly/);
    assert.ok(out.rubric.version, 'rubric must carry a version');
    assert.ok(Array.isArray(out.rubric.rules) && out.rubric.rules.length > 0);
    assert.match(out.instructions, /audit_submit/);
  });
});

test('audit-requirement rejects an unknown id', () => {
  withDb((db) => {
    const { code, out } = run(['audit-requirement', 'requirement_deadbeef'], db);
    assert.equal(code, 1);
    assert.match(String(out.error), /no artifact with id requirement_deadbeef/);
  });
});

test('audit-requirement rejects an artifact that is not a requirement', () => {
  withDb((db, seed) => {
    const reqId = seed();
    const store = new TraceStore(db);
    const other = store.record({
      type: 'test_case',
      content: { name: 'x' },
      provenance: { producer: 'human' },
      links: [{ to: reqId, relation: 'covers' }],
    });
    store.close();

    const { code, out } = run(['audit-requirement', other.id], db);
    assert.equal(code, 1);
    assert.match(String(out.error), /is a test_case, not a requirement/);
  });
});

test('audit-requirement with no id prints usage and exits 1', () => {
  withDb((db) => {
    const { code, out } = run(['audit-requirement'], db);
    assert.equal(code, 1);
    assert.ok(out.error, 'expected an error field');
  });
});

test('audit-submit records findings and prints their ids', () => {
  withDb((db, seed) => {
    const id = seed();
    const payload = JSON.stringify({
      requirementId: id,
      findings: [{
        category: 'AMB-VAGUE-QUANT',
        quote: 'processed quickly',
        question: 'What measurable threshold makes this quick?',
        confidence: 'high',
      }],
      provenance: { producer: 'ai', model: 'claude-haiku-4-5' },
    });
    const { code, out } = run(['audit-submit'], db, payload);
    assert.equal(code, 0);
    assert.equal(out.recorded.length, 1);
    assert.match(out.recorded[0], /^finding_/);
  });
});

test('audit-submit accepts provenance with no promptVersion and stamps the rubric version', () => {
  withDb((db, seed) => {
    const id = seed();
    const payload = JSON.stringify({
      requirementId: id,
      findings: [{
        category: 'AMB-VAGUE-QUANT',
        quote: 'processed quickly',
        question: 'How quick?',
        confidence: 'high',
      }],
      // No promptVersion: the server stamps it. Validating with the refined
      // Provenance here would reject this correct payload.
      provenance: { producer: 'ai', model: 'claude-haiku-4-5' },
    });
    const { code, out } = run(['audit-submit'], db, payload);
    assert.equal(code, 0);

    const store = new TraceStore(db);
    const finding = store.get(out.recorded[0]);
    store.close();
    assert.ok(finding, 'finding must exist');
    assert.match(String(finding.provenance.promptVersion), /^ambiguity\//);
  });
});

test('audit-submit overwrites a caller-supplied promptVersion with the rubric version', () => {
  withDb((db, seed) => {
    const id = seed();
    const payload = JSON.stringify({
      requirementId: id,
      findings: [{
        category: 'AMB-VAGUE-QUANT',
        quote: 'processed quickly',
        question: 'How quick?',
        confidence: 'high',
      }],
      // This is the production path: loop_a always sends a promptVersion (the
      // auditor's module digest) via ai_provenance. The server must overwrite it
      // with the rubric version, not refuse the submission for supplying one.
      provenance: { producer: 'ai', model: 'claude-haiku-4-5', promptVersion: 'sha256:deadbeefcafe' },
    });
    const { code, out } = run(['audit-submit'], db, payload);
    assert.equal(code, 0);

    const store = new TraceStore(db);
    const finding = store.get(out.recorded[0]);
    store.close();
    assert.ok(finding, 'finding must exist');
    assert.notEqual(finding.provenance.promptVersion, 'sha256:deadbeefcafe');
    assert.match(String(finding.provenance.promptVersion), /^ambiguity\//);
  });
});

test('audit-submit rejects an unknown rule id and writes nothing', () => {
  withDb((db, seed) => {
    const id = seed();
    const before = (() => { const s = new TraceStore(db); const n = s.list(undefined, 1e9).length; s.close(); return n; })();

    const { code, out } = run(['audit-submit'], db, JSON.stringify({
      requirementId: id,
      findings: [{ category: 'NOT-A-RULE', quote: 'processed quickly', question: 'q?', confidence: 'high' }],
      provenance: { producer: 'human' },
    }));
    assert.equal(code, 1);
    assert.match(String(out.error), /unknown rule "NOT-A-RULE"/);

    const after = (() => { const s = new TraceStore(db); const n = s.list(undefined, 1e9).length; s.close(); return n; })();
    assert.equal(after, before);
  });
});

test('audit-submit rejects a quote that is not verbatim in the requirement', () => {
  withDb((db, seed) => {
    const id = seed();
    const { code, out } = run(['audit-submit'], db, JSON.stringify({
      requirementId: id,
      findings: [{
        category: 'AMB-VAGUE-QUANT',
        quote: 'a phrase the model invented',
        question: 'q?',
        confidence: 'high',
      }],
      provenance: { producer: 'human' },
    }));
    assert.equal(code, 1);
    assert.match(String(out.error), /quote not found in requirement text/);
  });
});

test('audit-submit rejects malformed JSON with a readable error', () => {
  withDb((db) => {
    const { code, out } = run(['audit-submit'], db, '{not json');
    assert.equal(code, 1);
    assert.ok(out.error);
    assert.doesNotMatch(String(out.error), /\n\s+at /, 'must not be a raw stack trace');
  });
});
