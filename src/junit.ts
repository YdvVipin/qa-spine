/**
 * JUnit XML in, test cases out. Node has no XML parser and this project's runtime
 * dependencies are two, so this reads only what JUnit reports use: elements, quoted
 * attributes, self-closing tags, comments, the `<?xml?>` prolog, CDATA, and the five named
 * entities plus numeric references. Anything else is an error, never a skipped testcase —
 * a report read as "fewer tests" is a report read as "cleaner than it was".
 *
 * ponytail: no DTDs, no namespaces, no processing instructions beyond the prolog. Upgrade
 * path is a real parser dependency if a reporter in the wild needs more.
 */

import { basename } from 'node:path';
import type { TraceStore } from './trace/store.ts';
import { DEFAULT_TICKET_PATTERN } from './gate.ts';
import { INGEST_TOOL } from './release.ts';

type XmlElement = { name: string; attrs: Record<string, string>; children: XmlElement[]; text: string };

const NAME = '[A-Za-z_][\\w.:-]*';
const START_TAG = new RegExp(`<(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>`, 'y');
const ATTR = new RegExp(`(${NAME})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'g');
const END_TAG = new RegExp(`</(${NAME})\\s*>`, 'y');
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));|&/g, (m, hex, dec, named) => {
    if (named) return NAMED[named];
    if (hex || dec) {
      try {
        return String.fromCodePoint(parseInt(hex ?? dec, hex ? 16 : 10));
      } catch {
        throw new Error(`invalid character reference ${m}`);
      }
    }
    throw new Error('unescaped & (write &amp;)');
  });
}

function parseXml(src: string): XmlElement {
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  const fail = (msg: string): never => {
    throw new Error(`invalid XML at offset ${i}: ${msg}`);
  };
  const until = (marker: string, what: string) => {
    const end = src.indexOf(marker, i);
    if (end < 0) fail(`unterminated ${what}`);
    return end;
  };

  while (i < src.length) {
    if (src.startsWith('<?', i)) {
      if (root || !/^<\?xml\s/.test(src.slice(i, i + 6))) fail('only the <?xml?> prolog is supported');
      i = until('?>', 'prolog') + 2;
    } else if (src.startsWith('<!--', i)) {
      i = until('-->', 'comment') + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      const parent = stack.at(-1) ?? fail('CDATA outside an element');
      const end = until(']]>', 'CDATA section');
      parent.text += src.slice(i + 9, end);
      i = end + 3;
    } else if (src.startsWith('<!', i)) {
      fail('DTDs and declarations are not supported');
    } else if (src.startsWith('</', i)) {
      END_TAG.lastIndex = i;
      const m = END_TAG.exec(src) ?? fail('malformed closing tag');
      const open = stack.pop();
      if (open?.name !== m[1]) fail(`</${m[1]}> does not close <${open?.name ?? 'nothing'}>`);
      i = END_TAG.lastIndex;
    } else if (src[i] === '<') {
      START_TAG.lastIndex = i;
      const m = START_TAG.exec(src) ?? fail('malformed tag');
      const attrs: Record<string, string> = {};
      for (const a of m[2].matchAll(ATTR)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const el: XmlElement = { name: m[1], attrs, children: [], text: '' };
      const parent = stack.at(-1);
      if (parent) parent.children.push(el);
      else if (root) fail('more than one root element');
      else root = el;
      if (!m[3]) stack.push(el);
      i = START_TAG.lastIndex;
    } else {
      const next = src.indexOf('<', i);
      const end = next < 0 ? src.length : next;
      const text = src.slice(i, end);
      const parent = stack.at(-1);
      if (parent) parent.text += decode(text);
      else if (text.trim()) fail('text outside the root element');
      i = end;
    }
  }
  if (stack.length) fail(`<${stack.at(-1)!.name}> is never closed`);
  return root ?? fail('no root element');
}

function* descendants(el: XmlElement): Generator<XmlElement> {
  for (const child of el.children) {
    yield child;
    yield* descendants(child);
  }
}

export type TestStatus = 'passed' | 'failed' | 'error' | 'skipped';

/** Worst first. A gate is conservative: the same test reported twice counts as its worst. */
export const SEVERITY: TestStatus[] = ['error', 'failed', 'skipped', 'passed'];

export type JunitCase = {
  classname: string;
  name: string;
  status: TestStatus;
  message?: string;
  time?: string;
  keys: string[];
};

const MESSAGE_CAP = 1000;

export function parseJunit(xml: string, ticketPattern: string): JunitCase[] {
  const root = parseXml(xml);
  const pattern = new RegExp(ticketPattern, 'g');
  const keysIn = (s: string | undefined) => s?.match(pattern) ?? [];

  return [...(root.name === 'testcase' ? [root] : []), ...descendants(root)]
    .filter((el) => el.name === 'testcase')
    .map((tc) => {
      const name = tc.attrs.name;
      if (!name) throw new Error('a <testcase> has no name attribute');
      const classname = tc.attrs.classname ?? '';

      const outcome = SEVERITY.map((s) => ({ s, el: tc.children.find((c) => c.name === (s === 'failed' ? 'failure' : s)) }))
        .find((o) => o.s !== 'passed' && o.el);
      const status: TestStatus = outcome?.s ?? 'passed';
      const rawMessage = (outcome?.el?.attrs.message ?? outcome?.el?.text ?? '').trim();

      const properties = [...descendants(tc)].filter(
        (el) => el.name === 'property' && el.attrs.name === 'requirement',
      );
      const keys = new Set([
        ...keysIn(name),
        ...keysIn(classname),
        ...properties.flatMap((p) => keysIn(p.attrs.value)),
      ]);

      return {
        classname,
        name,
        status,
        ...(rawMessage ? { message: rawMessage.slice(0, MESSAGE_CAP) } : {}),
        ...(tc.attrs.time ? { time: tc.attrs.time } : {}),
        keys: [...keys],
      };
    });
}

export { INGEST_TOOL };

export type IngestResult = {
  runs: { testCaseId: string; testRunId: string; name: string; status: TestStatus; flaky: boolean }[];
  /** Keys a test named that no requirement in the store carries. They link nothing. */
  uncovered: string[];
  /** Tests that named no key at all. Recorded, but they can never block anything. */
  unkeyed: number;
};

/**
 * Records a set of JUnit reports as `test_case` and `test_run` artifacts. Every report is
 * parsed before the first write, and the writes share one transaction: a report that cannot
 * be read means nothing from any of them is recorded.
 *
 * A test case's identity is `junit:<classname>::<name>`, reused across ingests, so the latest
 * run of a test always hangs off the same case. The same test more than once in one ingest
 * (retry plugins, sharded suites) becomes one run with its worst status, and is flagged flaky
 * when it both passed and failed.
 */
export function ingestJunit(
  store: TraceStore,
  input: {
    reports: { file: string; xml: string }[];
    ticketPattern?: string;
    runRef?: string;
    commit?: string;
    toolVersion?: string;
  },
): IngestResult {
  const pattern = input.ticketPattern ?? DEFAULT_TICKET_PATTERN;
  const cases = input.reports.flatMap(({ file, xml }) => {
    try {
      return parseJunit(xml, pattern);
    } catch (err) {
      throw new Error(`${file}: ${err instanceof Error ? err.message : err}`);
    }
  });
  if (!cases.length) {
    throw new Error('no <testcase> in any report — a report of no tests is not a clean run');
  }

  const byIdentity = new Map<string, JunitCase & { statuses: Set<TestStatus> }>();
  for (const c of cases) {
    const id = `junit:${c.classname}::${c.name}`;
    const seen = byIdentity.get(id);
    if (!seen) {
      byIdentity.set(id, { ...c, statuses: new Set([c.status]) });
      continue;
    }
    seen.statuses.add(c.status);
    seen.keys = [...new Set([...seen.keys, ...c.keys])];
    if (SEVERITY.indexOf(c.status) < SEVERITY.indexOf(seen.status)) {
      Object.assign(seen, { status: c.status, message: c.message, time: c.time });
    }
  }

  const provenance = {
    producer: 'tool' as const,
    tool: INGEST_TOOL,
    ...(input.toolVersion ? { toolVersion: input.toolVersion } : {}),
  };
  const runRef = input.runRef?.trim() || `junit:${basename(input.reports[0].file)}`;
  const uncovered = new Set<string>();
  let unkeyed = 0;

  const runs = store.transaction(() =>
    [...byIdentity].map(([identity, c]) => {
      // A retracted case is not reused: its runs would land somewhere every view ignores.
      const testCase =
        store.bySourceRef([identity]).find((a) => a.type === 'test_case' && !store.isRetracted(a.id)) ??
        store.record({
          type: 'test_case',
          sourceRef: identity,
          content: { name: c.name, classname: c.classname },
          provenance,
        });

      if (!c.keys.length) unkeyed++;
      const linked = new Set(store.edgesFrom(testCase.id).filter((e) => e.relation === 'covers').map((e) => e.toArtifactId));
      for (const key of c.keys) {
        const requirements = store.bySourceRef([key]).filter((a) => a.type === 'requirement' && !store.isRetracted(a.id));
        if (!requirements.length) uncovered.add(key);
        for (const req of requirements) {
          if (!linked.has(req.id)) store.link(testCase.id, req.id, 'covers');
        }
      }

      const flaky = c.statuses.has('passed') && (c.statuses.has('failed') || c.statuses.has('error'));
      const run = store.record({
        type: 'test_run',
        sourceRef: runRef,
        content: {
          status: c.status,
          ...(c.message ? { message: c.message } : {}),
          ...(c.time ? { time: c.time } : {}),
          runRef,
          ...(input.commit ? { commit: input.commit } : {}),
          ...(flaky ? { flaky: true } : {}),
        },
        provenance,
        links: [{ to: testCase.id, relation: 'verifies' }],
      });
      return { testCaseId: testCase.id, testRunId: run.id, name: c.name, status: c.status, flaky };
    }),
  );

  return { runs, uncovered: [...uncovered], unkeyed };
}
