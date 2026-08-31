#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { TraceStore } from './trace/store.ts';
import { ArtifactType, ProvenanceInput, Relation } from './trace/schema.ts';
import {
  auditRequirement,
  submitFindings,
  AuditFinding,
  openQuestions,
  recordAnswer,
} from './audit.ts';
import { assessReleaseRisk, recordVerdict } from './release.ts';
import { renderBrief } from './brief.ts';

export const VERSION = '0.1.0';

export function dbPath() {
  return resolve(process.env.QA_SPINE_DB ?? '.qa-spine/trace.db');
}

const json = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({ ...json({ error: message }), isError: true });

export function createServer(store: TraceStore) {
  const server = new McpServer({ name: 'qa-spine', version: VERSION });

  server.registerTool(
    'health',
    {
      description: 'Check that the qa-spine server is running and report trace store status.',
      inputSchema: {},
    },
    () => json({ ok: true, version: VERSION, db: dbPath(), artifacts: store.list(undefined, 1e9).length }),
  );

  server.registerTool(
    'trace_record',
    {
      description:
        'Append an artifact to the trace store, optionally linking it to existing artifacts. ' +
        'The store is append-only: to retract something, record a replacement with a `supersedes` link.',
      inputSchema: {
        type: ArtifactType,
        sourceRef: z
          .string()
          .optional()
          .describe('Where this came from, e.g. a JIRA key, file path or commit SHA.'),
        content: z.record(z.string(), z.unknown()).describe('The artifact body.'),
        provenance: ProvenanceInput.describe(
          'Who produced this. AI artifacts must give `model` and `promptVersion`.',
        ),
        links: z
          .array(z.object({ to: z.string(), relation: Relation }))
          .optional()
          .describe('Edges from the new artifact to existing ones.'),
      },
    },
    (args) => {
      try {
        return json(store.record(args));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'trace_query',
    {
      description:
        'Given an artifact ID, return the full upstream and downstream chain with provenance ' +
        'intact — e.g. from a release verdict back to the requirement finding that predicted it. ' +
        'Omit the ID to list recent artifacts.',
      inputSchema: {
        artifactId: z.string().optional(),
        type: ArtifactType.optional().describe('Filter the listing when no artifactId is given.'),
      },
    },
    ({ artifactId, type }) => {
      if (!artifactId) return json({ artifacts: store.list(type) });
      const chain = store.chain(artifactId);
      return chain ? json(chain) : fail(`no artifact with id ${artifactId}`);
    },
  );

  server.registerTool(
    'audit_requirement',
    {
      description:
        'Load a requirement and the published ambiguity rubric. Returns both, plus instructions. ' +
        'This tool makes no model call: reason over what it returns, then record what you find ' +
        'with `audit_submit`. Emit questions for a human, never a rewritten requirement.',
      inputSchema: {
        requirementId: z.string().describe('The artifact id of the requirement to audit.'),
      },
    },
    ({ requirementId }) => {
      try {
        return json(auditRequirement(store, requirementId));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'audit_submit',
    {
      description:
        'Record ambiguity findings against a requirement. Every finding must cite a rule id from ' +
        'the rubric, quote the requirement verbatim, and phrase `question` in plain language with ' +
        'no internal identifiers or system terminology; if any finding fails any check the whole ' +
        'submission is rejected and nothing is written. `promptVersion` is set by the server from ' +
        'the rubric version, not by the caller.',
      inputSchema: {
        requirementId: z.string(),
        findings: z.array(AuditFinding).min(1),
        provenance: ProvenanceInput.describe('Who produced these. AI must give `model`.'),
      },
    },
    (args) => {
      try {
        return json({ recorded: submitFindings(store, args).map((a) => a.id) });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'audit_open',
    {
      description:
        'List ambiguity questions still waiting on an answer. Each carries the rule it came ' +
        'from, the quoted span, and the requirement text needed to answer it, so no second ' +
        'call is required. Omit requirementId for everything outstanding.',
      inputSchema: {
        requirementId: z.string().optional().describe('Limit to one requirement.'),
      },
    },
    ({ requirementId }) => {
      try {
        return json(openQuestions(store, requirementId));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'audit_answer',
    {
      description:
        'Answer an open ambiguity question. The answer supersedes the finding, which retires ' +
        'it. Rejects a blank answer, an id that is not a finding, and a finding something has ' +
        'already resolved. Your provenance is recorded as given and is not rewritten: an ' +
        'answer produced by AI stays visibly an AI answer.',
      inputSchema: {
        findingId: z.string().describe('The finding whose question you are answering.'),
        answer: z.string().describe('The answer, in full. Blank answers are rejected.'),
        provenance: ProvenanceInput.describe(
          'Who is answering. AI must give `model` and `promptVersion`.',
        ),
      },
    },
    (args) => {
      try {
        return json(recordAnswer(store, args));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'assess_release_risk',
    {
      description:
        'Given the areas a release touches, return every unresolved requirement-stage finding ' +
        'on those areas, plus the surrounding artifacts as unscored evidence. Makes no model ' +
        'call: reason over what it returns, then record your brief with `release_submit`. ' +
        'Every signal blocks a ship verdict.',
      inputSchema: {
        changed: z
          .array(z.string())
          .min(1)
          .describe('sourceRefs this release touches — JIRA keys and file paths. Matched exactly.'),
        releaseRef: z
          .string()
          .optional()
          .describe('e.g. release/2026.7.3. Becomes the verdict sourceRef on submit.'),
      },
    },
    (args) => {
      try {
        return json(assessReleaseRisk(store, args));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'release_submit',
    {
      description:
        'Record a release verdict. Signals are recomputed from `changed` and are never taken ' +
        'from the caller, so a `ship` cannot be waved through by omitting a blocker: it is ' +
        'rejected while any signal is live unless `override` gives a reason, which is recorded. ' +
        'Every id in `cites` must exist. Your provenance is recorded as given.',
      inputSchema: {
        releaseRef: z.string().describe('e.g. release/2026.7.3.'),
        verdict: z.enum(['ship', 'hold']),
        reason: z.string().describe('The one-page brief. Blank is rejected.'),
        cites: z
          .array(z.string())
          .describe('Artifact ids the brief refers to. Each becomes a derived_from edge.'),
        changed: z
          .array(z.string())
          .min(1)
          .describe('The same list passed to assess_release_risk. Signals are recomputed from it.'),
        override: z
          .object({
            reason: z.string().describe('Why you are shipping anyway. Blank is rejected.'),
          })
          .optional()
          .describe(
            'Required to ship while a signal is live; recorded on the verdict together with ' +
              "the findings it overrode. Throws if given alongside verdict: 'hold'. When it " +
              'actually overrides a live signal, `provenance.approvedBy` must name who ' +
              'accepted the risk.',
          ),
        provenance: ProvenanceInput.describe(
          'Who decided. AI must give `model` and `promptVersion`; a tool must give `tool`. ' +
            'Set `approvedBy` when overriding a live signal.',
        ),
      },
    },
    (args) => {
      try {
        return json(recordVerdict(store, args));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}

/**
 * Dumps every human review joined to the artifact it judged, one JSON object per line.
 * This is the labelled dataset that makes a rubric change measurable instead of a vibe.
 */
export function reviewExport(store: TraceStore): string {
  return store
    .list('review', 1e9)
    .map((review) => {
      const target = store
        .edgesFrom(review.id)
        .find((e) => e.relation === 'reviews')
        ?.toArtifactId;
      const judged = target ? store.get(target) : undefined;
      return JSON.stringify({
        reviewId: review.id,
        verdict: review.content.verdict,
        note: review.content.note,
        reviewedAt: review.createdAt,
        artifactId: judged?.id ?? null,
        artifactType: judged?.type ?? null,
        sourceRef: judged?.sourceRef ?? null,
        content: judged?.content ?? null,
        model: judged?.provenance.model ?? null,
        promptVersion: judged?.provenance.promptVersion ?? null,
        inputDigest: judged?.provenance.inputDigest ?? null,
      });
    })
    .join('\n');
}

/**
 * The optional port `inspect` and `demo` share. Both used to read it as
 * `Number(process.argv[3] ?? …)`, so anything non-numeric — `--port 5000`, the obvious
 * guess — became NaN and reached `server.listen()` as an unhandled RangeError with a
 * stack trace. `parseArgs` is what `gate` already uses, and it rejects an unknown flag
 * on its own. The bare positional stays supported: before `--port` it was the only way.
 */
export function resolvePort(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    options: { port: { type: 'string' } },
    allowPositionals: true,
  });
  const raw = values.port ?? positionals[0] ?? process.env.QA_SPINE_PORT;
  if (raw === undefined || raw === '') return 4700;
  // Node's own accepted range, checked here so the message names the bad value.
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) {
    throw new Error(`invalid port: ${raw} (expected 0-65535)`);
  }
  return Number(raw);
}

/**
 * npm installs the `bin` as a symlink (`node_modules/.bin/qa-spine`), so argv[1] is the
 * link while import.meta.filename is the resolved target: comparing them raw makes the
 * published CLI a silent no-op. realpath both sides; a non-file argv[1] means not us.
 */
function invokedAsScript(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename;
  } catch {
    return false;
  }
}

const USAGE = `qa-spine ${VERSION} — QA lifecycle tools over an append-only trace spine

usage: qa-spine [subcommand]

  (none)                  run as an MCP server on stdio
  init                    copy the rubric into ./rubrics and gitignore .qa-spine/
  demo [--port N]         seed a throwaway store and open the Inspector
  inspect [--port N]      browse the trace store in the Inspector
  record                  append an artifact (JSON payload on stdin)
  brief <verdictId>       render a release verdict as self-contained HTML
  audit-requirement <id>  load a requirement plus the ambiguity rubric
  audit-submit            record audit findings (JSON payload on stdin)
  gate --changed <ref>    release gate for CI — exit 0 ship, 1 blocked, 2 error
  review-export           dump human review labels as JSONL
  help                    show this screen

environment:
  QA_SPINE_DB    store path (default .qa-spine/trace.db)
  QA_SPINE_PORT  inspector port (default 4700)`;

const SUBCOMMANDS = new Set([
  'init',
  'demo',
  'inspect',
  'record',
  'brief',
  'audit-requirement',
  'audit-submit',
  'gate',
  'review-export',
]);

if (invokedAsScript()) {
  const subcommand = process.argv[2];

  // Resolved before dbPath(): none of these touch a store, so none may create one —
  // and a typo must not fall through to the stdio MCP server below, which just sits
  // there looking hung.
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    console.log(USAGE);
    process.exit(0);
  }
  if (subcommand === 'version' || subcommand === '--version' || subcommand === '-v') {
    console.log(VERSION);
    process.exit(0);
  }
  if (subcommand !== undefined && !SUBCOMMANDS.has(subcommand)) {
    console.error(`unknown subcommand '${subcommand}'\n\n${USAGE}`);
    process.exit(1);
  }

  const path = dbPath();
  // `init` and `demo` never read or write the configured store, so they must not
  // create its directory either — a demo that leaves an empty .qa-spine/ in your
  // working directory has already broken the promise it makes in its own output.
  //
  // ponytail: an exempt list rather than moving this into each case that opens a
  // store. Seven cases need it and two do not; inverting that is more churn than
  // it buys. If a third exempt command appears, move it into the cases instead.
  if (subcommand !== 'init' && subcommand !== 'demo') {
    mkdirSync(dirname(path), { recursive: true });
  }

  switch (process.argv[2]) {
    case 'inspect': {
      let port: number;
      try {
        port = resolvePort(process.argv.slice(3));
      } catch (err) {
        console.error(`qa-spine inspect: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
        break;
      }
      const store = new TraceStore(path);
      const { startInspector } = await import('./inspector/server.ts');
      await startInspector(store, port);
      console.error(`qa-spine inspector → http://127.0.0.1:${port}  (reading ${path})`);
      break;
    }
    case 'review-export': {
      const store = new TraceStore(path);
      const jsonl = reviewExport(store);
      if (jsonl) console.log(jsonl);
      break;
    }
    case 'record': {
      // Payload arrives on stdin, not argv: it carries test bodies and heal diffs,
      // which are fragile to quote and would eventually exceed ARG_MAX. Store
      // construction happens inside this try too — a lock contention error (or
      // any other open failure) must come back as {"error": ...} on stdout, not
      // a raw stack trace on stderr with empty stdout.
      try {
        if (process.stdin.isTTY) {
          console.log(JSON.stringify({ error: 'record reads a JSON payload on stdin; pipe one in' }));
          process.exitCode = 1;
          break;
        }
        // ponytail: caller holding stdin open without closing still hangs indefinitely; upgrade path is read timeout
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        const store = new TraceStore(path);
        console.log(JSON.stringify(store.record(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
      } catch (err) {
        // One JSON object on stdout either way, so the caller never parses stderr.
        console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        process.exitCode = 1;
      }
      break;
    }
    case 'brief': {
      // Unlike `record`, errors go to stderr: this output is a document being
      // redirected to a file, so a failed run must leave an empty file rather
      // than a file containing an error page.
      const id = process.argv[3];
      if (!id) {
        console.error('usage: qa-spine brief <verdictId>');
        process.exitCode = 1;
        break;
      }
      try {
        const store = new TraceStore(path);
        console.log(renderBrief(store, id));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
      break;
    }

    case 'audit-requirement': {
      // Errors go to stdout as JSON, like `record` and unlike `brief`: the caller
      // here is a program parsing one JSON object, not a document being redirected.
      const id = process.argv[3];
      if (!id) {
        console.log(JSON.stringify({ error: 'usage: qa-spine audit-requirement <requirementId>' }));
        process.exitCode = 1;
        break;
      }
      try {
        const store = new TraceStore(path);
        console.log(JSON.stringify(auditRequirement(store, id)));
      } catch (err) {
        console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        process.exitCode = 1;
      }
      break;
    }

    case 'audit-submit': {
      if (process.stdin.isTTY) {
        console.log(JSON.stringify({ error: 'audit-submit reads a JSON payload on stdin; pipe one in' }));
        process.exitCode = 1;
        break;
      }
      // ponytail: a caller that holds stdin open without closing it still hangs.
      // Upgrade path is a read timeout.
      try {
        const store = new TraceStore(path);
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        // ProvenanceInput, not Provenance: submitFindings stamps promptVersion from the
        // rubric version, so the refinement would reject a correct payload here.
        const provenance = ProvenanceInput.parse(input.provenance);
        const recorded = submitFindings(store, {
          requirementId: input.requirementId,
          findings: input.findings,
          provenance,
        });
        console.log(JSON.stringify({ recorded: recorded.map((a) => a.id) }));
      } catch (err) {
        console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        process.exitCode = 1;
      }
      break;
    }

    case 'gate': {
      // A third stream convention, deliberately. `record` puts errors on stdout as JSON
      // because its caller parses one object; `brief` puts them on stderr because its output
      // is a document being redirected. Here the real product is the exit code — stdout
      // carries whichever reader was asked for, and a diagnostic must never be mistaken for
      // either. 0 shippable, 1 blocked, 2 could not tell.
      try {
        const { values } = parseArgs({
          args: process.argv.slice(3),
          options: {
            changed: { type: 'string', multiple: true },
            since: { type: 'string' },
            'release-ref': { type: 'string' },
            record: { type: 'boolean' },
            reason: { type: 'string' },
            'override-reason': { type: 'string' },
            'approved-by': { type: 'string' },
            'ticket-pattern': { type: 'string' },
            brief: { type: 'string' },
            summary: { type: 'string' },
            json: { type: 'boolean' },
          },
          allowPositionals: false,
        });

        // Both spellings, because CI writes one long line and a person writes several.
        const changed = (values.changed ?? []).flatMap((c) => c.split(','));

        if (!!values['override-reason'] !== !!values['approved-by']) {
          throw new Error('--override-reason and --approved-by must be given together');
        }

        const { runGate, renderSummary } = await import('./gate.ts');
        const store = new TraceStore(path);
        const result = runGate(store, {
          changed,
          since: values.since,
          ticketPattern: values['ticket-pattern'],
          releaseRef: values['release-ref'],
          record: values.record,
          reason: values.reason,
          overrideReason: values['override-reason'],
          approvedBy: values['approved-by'],
          briefPath: values.brief,
          toolVersion: VERSION,
        });
        // --summary writes the Markdown while stdout stays JSON. Without it a caller that
        // wants both has to run the gate twice, which with --record would append a second
        // verdict to a ledger that cannot remove either.
        if (values.summary) writeFileSync(values.summary, renderSummary(result));
        console.log(values.json ? JSON.stringify(result, null, 2) : renderSummary(result));
        process.exitCode = result.shippable ? 0 : 1;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 2;
      }
      break;
    }

    case 'init': {
      // Human-readable on stdout, errors on stderr — this is a command a person runs
      // and reads, unlike `record` whose caller parses one JSON object.
      const packageRoot = resolve(import.meta.dirname, '..');
      let failed = false;

      // 1. The rubric. The README calls it "the thing a team argues about in review";
      // that is only true once the team owns the file and can commit it.
      const rubricDest = resolve(process.cwd(), 'rubrics', 'ambiguity.json');
      if (existsSync(rubricDest)) {
        console.log('· rubrics/ambiguity.json already exists — left alone');
      } else {
        try {
          mkdirSync(dirname(rubricDest), { recursive: true });
          copyFileSync(resolve(packageRoot, 'rubrics', 'ambiguity.json'), rubricDest);
          console.log('✓ rubrics/ambiguity.json — yours now, edit and commit it');
        } catch (err) {
          console.error(`could not write rubrics/ambiguity.json: ${err instanceof Error ? err.message : err}`);
          failed = true;
        }
      }

      // 2. .gitignore — a SQLite file in git means a binary merge conflict on every
      // parallel branch.
      const gitignorePath = resolve(process.cwd(), '.gitignore');
      const ENTRY = '.qa-spine/';
      try {
        const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
        if (current.split('\n').some((line) => line.trim() === ENTRY)) {
          console.log(`· .gitignore already ignores ${ENTRY}`);
        } else {
          const separator = current && !current.endsWith('\n') ? '\n' : '';
          writeFileSync(gitignorePath, `${current}${separator}${ENTRY}\n`);
          console.log(`✓ .gitignore += ${ENTRY}`);
        }
      } catch (err) {
        console.error(`could not update .gitignore: ${err instanceof Error ? err.message : err}`);
        failed = true;
      }

      // 3. The MCP line. The path is inside node_modules and differs per install —
      // nobody should have to go and find it.
      console.log('\nRegister with Claude Code:');
      console.log(`  claude mcp add qa-spine -- node ${resolve(packageRoot, 'dist', 'server.js')}`);
      console.log('\nThen: npx qa-spine demo   # see it working — writes only to a temp file');
      console.log('Set QA_SPINE_RUBRICS to use rubrics from somewhere other than ./rubrics.');

      if (failed) process.exitCode = 1;
      break;
    }

    case 'demo': {
      // Resolved before seeding: a bad port should cost nothing, not a seeded store the
      // user never gets shown.
      let port: number;
      try {
        port = resolvePort(process.argv.slice(3));
      } catch (err) {
        console.error(`qa-spine demo: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
        break;
      }

      // QA_SPINE_DB is deliberately ignored: the point of the demo is that it does not
      // write where your data lives. The ledger is append-only, so a demo seeded into a
      // real store would be permanent.
      const demoDb = join(tmpdir(), 'qa-spine-demo.db');
      const briefPath = join(tmpdir(), 'qa-spine-demo-brief.html');

      let demo: { store: InstanceType<typeof TraceStore>; verdictId: string };
      try {
        const { runDemo } = await import('./demo.ts');
        demo = runDemo(demoDb, briefPath);
      } catch (err) {
        // Fail before starting the Inspector — nobody should be shown a half-built store.
        console.error(`demo failed while seeding: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
        break;
      }

      const { startInspector } = await import('./inspector/server.ts');
      await startInspector(demo.store, port);

      console.log(`seeded ${demoDb}`);
      console.log(`brief  ${briefPath}`);
      console.log(`\nqa-spine inspector → http://127.0.0.1:${port}`);
      console.log('\nA throwaway store — your own data is untouched. Ctrl-C to stop.');
      break;
    }

    default: {
      const store = new TraceStore(path);
      await createServer(store).connect(new StdioServerTransport());
    }
  }
}
