import { createServer as createHttpServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TraceStore } from '../trace/store.ts';
import { ArtifactType } from '../trace/schema.ts';
import { openQuestions, recordAnswer } from '../audit.ts';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * Read-only lens on the trace store, with two human-authored writes: a thumbs up/down on
 * an AI artifact, and a human's answer to an open audit question. It renders the store; it
 * never triggers an agent or edits an artifact — both writes only ever append a new one.
 * Bound to loopback only — there is no auth because there is no remote access.
 */
export function createInspector(store: TraceStore): Server {
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method === 'GET' && url.pathname === '/api/artifacts') {
        const raw = url.searchParams.get('type');
        const type = raw ? ArtifactType.safeParse(raw) : undefined;
        if (type && !type.success) return send(400, { error: `unknown artifact type: ${raw}` });
        return send(200, { artifacts: store.list(type?.data, 500) });
      }

      // Powers both the detail and chain views: one artifact plus everything around it.
      if (req.method === 'GET' && url.pathname.startsWith('/api/chain/')) {
        const chain = store.chain(decodeURIComponent(url.pathname.slice('/api/chain/'.length)));
        return chain ? send(200, chain) : send(404, { error: 'no such artifact' });
      }

      if (req.method === 'POST' && url.pathname === '/api/review') {
        let body: Record<string, unknown>;
        try {
          body = await jsonBody(req);
        } catch (err) {
          return send(400, { error: err instanceof Error ? err.message : String(err) });
        }
        if (body.verdict !== 'good' && body.verdict !== 'bad') {
          return send(400, { error: "verdict must be 'good' or 'bad'" });
        }
        const artifactId = String(body.artifactId ?? '');
        if (!store.get(artifactId)) return send(404, { error: 'no such artifact' });
        const review = store.record({
          type: 'review',
          content: { verdict: body.verdict, note: String(body.note ?? '') },
          provenance: { producer: 'human' },
          links: [{ to: artifactId, relation: 'reviews' }],
        });
        return send(200, review);
      }

      if (req.method === 'GET' && url.pathname === '/api/open') {
        return send(200, openQuestions(store));
      }

      if (req.method === 'POST' && url.pathname === '/api/answer') {
        try {
          const body = await jsonBody(req);
          // Provenance is hardcoded, not read from the body: everything the Inspector writes
          // is a human act. An agent that wants to answer uses the audit_answer MCP tool,
          // where its own provenance is recorded and stays visible.
          return send(
            200,
            recordAnswer(store, {
              findingId: String(body.findingId ?? ''),
              answer: String(body.answer ?? ''),
              provenance: { producer: 'human' },
            }),
          );
        } catch (err) {
          return send(400, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (req.method === 'GET') {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        // Serve only the three known UI files; anything else cannot escape the directory.
        if (!Object.hasOwn(MIME, extname(name)) || name.includes('/')) {
          return send(404, { error: 'not found' });
        }
        const file = await readFile(join(UI_DIR, name));
        res.writeHead(200, { 'content-type': MIME[extname(name)] });
        return res.end(file);
      }

      send(404, { error: 'not found' });
    } catch (err) {
      send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

async function text(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parses a request body as a JSON object, with a message a human can act on rather than a
 * raw V8 parse error or a TypeError from indexing into `null`. Used by every POST route so
 * a truncated or malformed body is a 400, not a 500 from the outer catch.
 */
async function jsonBody(
  req: import('node:http').IncomingMessage,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await text(req));
  } catch {
    throw new Error('request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function startInspector(store: TraceStore, port = 4700): Promise<Server> {
  const server = createInspector(store);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
