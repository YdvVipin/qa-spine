#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
        'the rubric and quote the requirement verbatim; if any finding fails either check the ' +
        'whole submission is rejected and nothing is written. `promptVersion` is set by the ' +
        'server from the rubric version, not by the caller.',
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
              "the findings it overrode. Throws if given alongside verdict: 'hold'.",
          ),
        provenance: ProvenanceInput.describe('Who decided. AI must give `model` and `promptVersion`.'),
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

if (import.meta.filename === process.argv[1]) {
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });

  switch (process.argv[2]) {
    case 'inspect': {
      const store = new TraceStore(path);
      const { startInspector } = await import('./inspector/server.ts');
      const port = Number(process.argv[3] ?? process.env.QA_SPINE_PORT ?? 4700);
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
    default: {
      const store = new TraceStore(path);
      await createServer(store).connect(new StdioServerTransport());
    }
  }
}
