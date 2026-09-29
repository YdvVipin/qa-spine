import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJunit, ingestJunit } from '../src/junit.ts';
import { TraceStore } from '../src/trace/store.ts';

const KEY = '[A-Z][A-Z0-9]+-\\d+';

test('reads testcases under a <testsuites> root, with each status', () => {
  const cases = parseJunit(
    `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="refunds">
    <testcase classname="refunds" name="passes" time="0.12"/>
    <testcase classname="refunds" name="fails"><failure message="expected 200">stack</failure></testcase>
    <testcase classname="refunds" name="errors"><error>boom</error></testcase>
    <testcase classname="refunds" name="skips"><skipped/></testcase>
  </testsuite>
</testsuites>`,
    KEY,
  );
  assert.deepEqual(
    cases.map((c) => [c.name, c.status]),
    [['passes', 'passed'], ['fails', 'failed'], ['errors', 'error'], ['skips', 'skipped']],
  );
  assert.equal(cases[0].time, '0.12');
  assert.equal(cases[1].message, 'expected 200');
  assert.equal(cases[2].message, 'boom');
});

test('reads a bare <testsuite> root and nested suites', () => {
  const bare = parseJunit('<testsuite><testcase classname="a" name="one"/></testsuite>', KEY);
  const nested = parseJunit(
    '<testsuites><testsuite><testsuite><testcase classname="b" name="two"/></testsuite></testsuite></testsuites>',
    KEY,
  );
  assert.deepEqual(bare.map((c) => c.name), ['one']);
  assert.deepEqual(nested.map((c) => c.name), ['two']);
});

test('finds ticket keys in the name, the classname and a requirement property', () => {
  const [c] = parseJunit(
    `<testsuite><testcase classname="PROJ-1 refunds" name="PROJ-2 refund emails">
       <properties><property name="requirement" value="PROJ-3"/><property name="owner" value="PROJ-9"/></properties>
     </testcase></testsuite>`,
    KEY,
  );
  assert.deepEqual([...c.keys].sort(), ['PROJ-1', 'PROJ-2', 'PROJ-3']);
});

test('decodes entities, numeric references and CDATA', () => {
  const [c] = parseJunit(
    `<testsuite><!-- a comment --><testcase classname="a" name="x &amp; y &lt;&#65;&#x42;&gt;">
       <failure><![CDATA[got <nothing> & more]]></failure></testcase></testsuite>`,
    KEY,
  );
  assert.equal(c.name, 'x & y <AB>');
  assert.equal(c.message, 'got <nothing> & more');
});

test('caps the message at 1000 characters', () => {
  const [c] = parseJunit(
    `<testsuite><testcase classname="a" name="b"><failure>${'x'.repeat(5000)}</failure></testcase></testsuite>`,
    KEY,
  );
  assert.equal(c.message?.length, 1000);
});

test('rejects malformed input rather than skipping what it cannot read', () => {
  for (const bad of [
    '<testsuite><testcase classname="a" name="b"></testsuite>', // mismatched close
    '<testsuite><testcase classname="a" name="b"/>', // unclosed root
    '<testsuite><testcase name="a & b"/></testsuite>', // bare ampersand
    '<!DOCTYPE x><testsuite/>', // DTD
    '<testsuite/><testsuite/>', // two roots
    'not xml at all',
    '<testsuite><testcase classname="a"/></testsuite>', // testcase without a name
  ]) {
    assert.throws(() => parseJunit(bad, KEY), undefined, bad);
  }
});

const human = { producer: 'human' as const };
const report = (cases: string) => `<testsuite>${cases}</testsuite>`;

function withRequirement(ref = 'PROJ-42') {
  const store = new TraceStore(':memory:');
  const req = store.record({ type: 'requirement', sourceRef: ref, content: { text: 'r' }, provenance: human });
  return { store, req };
}

test('ingest records a test case and a run, linked to the requirement its key names', () => {
  const { store, req } = withRequirement();
  const result = ingestJunit(store, {
    reports: [{ file: 'out/junit.xml', xml: report('<testcase classname="refunds" name="PROJ-42 emails"><failure message="no email"/></testcase>') }],
    commit: 'abc123',
  });

  assert.equal(result.runs.length, 1);
  const tc = store.get(result.runs[0].testCaseId)!;
  const run = store.get(result.runs[0].testRunId)!;
  assert.equal(tc.type, 'test_case');
  assert.equal(tc.sourceRef, 'junit:refunds::PROJ-42 emails');
  assert.deepEqual(store.edgesFrom(tc.id).map((e) => [e.toArtifactId, e.relation]), [[req.id, 'covers']]);
  assert.equal(run.type, 'test_run');
  assert.equal(run.sourceRef, 'junit:junit.xml');
  assert.equal(run.content.status, 'failed');
  assert.equal(run.content.message, 'no email');
  assert.equal(run.content.commit, 'abc123');
  assert.deepEqual(store.edgesFrom(run.id).map((e) => [e.toArtifactId, e.relation]), [[tc.id, 'verifies']]);
  assert.equal(tc.provenance.producer, 'tool');
  assert.equal(tc.provenance.tool, 'qa-spine ingest-junit');
  assert.equal(run.provenance.tool, 'qa-spine ingest-junit');
});

test('--run-ref becomes the run sourceRef', () => {
  const { store } = withRequirement();
  const result = ingestJunit(store, {
    reports: [{ file: 'junit.xml', xml: report('<testcase classname="a" name="PROJ-42 b"/>') }],
    runRef: 'https://ci.example/runs/7',
  });
  assert.equal(store.get(result.runs[0].testRunId)!.sourceRef, 'https://ci.example/runs/7');
});

test('a key with no requirement is reported uncovered, and a test with no key is still recorded', () => {
  const { store } = withRequirement();
  const result = ingestJunit(store, {
    reports: [{ file: 'j.xml', xml: report('<testcase classname="a" name="PROJ-99 x"/><testcase classname="a" name="no key"/>') }],
  });
  assert.deepEqual(result.uncovered, ['PROJ-99']);
  assert.equal(result.unkeyed, 1);
  assert.equal(result.runs.length, 2);
  for (const r of result.runs) assert.equal(store.edgesFrom(r.testCaseId).length, 0);
});

test('a second ingest reuses the test case and adds only the new covers edge', () => {
  const { store, req } = withRequirement();
  const other = store.record({ type: 'requirement', sourceRef: 'PROJ-43', content: { text: 'o' }, provenance: human });
  const first = ingestJunit(store, { reports: [{ file: 'j.xml', xml: report('<testcase classname="a" name="t"><properties><property name="requirement" value="PROJ-42"/></properties></testcase>') }] });
  const second = ingestJunit(store, { reports: [{ file: 'j.xml', xml: report('<testcase classname="a" name="t"><properties><property name="requirement" value="PROJ-42 PROJ-43"/></properties></testcase>') }] });

  assert.equal(second.runs[0].testCaseId, first.runs[0].testCaseId);
  assert.equal(store.list('test_case').length, 1);
  assert.equal(store.list('test_run').length, 2);
  assert.deepEqual(
    store.edgesFrom(first.runs[0].testCaseId).map((e) => e.toArtifactId).sort(),
    [req.id, other.id].sort(),
  );
});

test('the same test twice in one ingest collapses to its worst status, and pass-plus-fail is flaky', () => {
  const { store } = withRequirement();
  const result = ingestJunit(store, {
    reports: [
      { file: 'a.xml', xml: report('<testcase classname="a" name="PROJ-42 t"><failure/></testcase>') },
      { file: 'b.xml', xml: report('<testcase classname="a" name="PROJ-42 t"/><testcase classname="a" name="PROJ-42 s"><skipped/></testcase><testcase classname="a" name="PROJ-42 s"/>') },
    ],
  });
  const byName = Object.fromEntries(result.runs.map((r) => [r.name, store.get(r.testRunId)!.content]));
  assert.equal(byName['PROJ-42 t'].status, 'failed');
  assert.equal(byName['PROJ-42 t'].flaky, true);
  assert.equal(byName['PROJ-42 s'].status, 'skipped');
  assert.equal(byName['PROJ-42 s'].flaky, undefined);
});

test('a report with no testcases is an error and writes nothing', () => {
  const { store } = withRequirement();
  assert.throws(() => ingestJunit(store, { reports: [{ file: 'j.xml', xml: '<testsuites/>' }] }), /no <testcase>/);
  assert.equal(store.list().length, 1);
});

test('one malformed report means nothing from any report is written', () => {
  const { store } = withRequirement();
  assert.throws(() =>
    ingestJunit(store, {
      reports: [
        { file: 'good.xml', xml: report('<testcase classname="a" name="PROJ-42 ok"/>') },
        { file: 'bad.xml', xml: '<testsuite><testcase' },
      ],
    }),
  /bad\.xml/);
  assert.equal(store.list().length, 1);
});
