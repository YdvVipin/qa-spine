#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TraceStore } from './trace/store.ts';
import { ArtifactType, ProvenanceInput, Relation } from './trace/schema.ts';

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
  const store = new TraceStore(path);

  switch (process.argv[2]) {
    case 'inspect': {
      const { startInspector } = await import('./inspector/server.ts');
      const port = Number(process.argv[3] ?? process.env.QA_SPINE_PORT ?? 4700);
      await startInspector(store, port);
      console.error(`qa-spine inspector → http://127.0.0.1:${port}  (reading ${path})`);
      break;
    }
    case 'review-export': {
      const jsonl = reviewExport(store);
      if (jsonl) console.log(jsonl);
      break;
    }
    default:
      await createServer(store).connect(new StdioServerTransport());
  }
}
