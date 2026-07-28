import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Artifact, Edge, Provenance, type Chain, type Relation } from './schema.ts';

/**
 * Append-only trace store. Enforcement lives in SQLite triggers rather than in this
 * module, so history survives anyone poking the file with the `sqlite3` CLI. To retract
 * an artifact, append a replacement and link it with a `supersedes` edge.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  source_ref TEXT,
  content    TEXT NOT NULL,
  provenance TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
  from_id    TEXT NOT NULL REFERENCES artifacts(id),
  to_id      TEXT NOT NULL REFERENCES artifacts(id),
  relation   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
);
CREATE INDEX IF NOT EXISTS edges_to ON edges(to_id);
CREATE TRIGGER IF NOT EXISTS artifacts_no_update BEFORE UPDATE ON artifacts
  BEGIN SELECT RAISE(ABORT, 'trace store is append-only'); END;
CREATE TRIGGER IF NOT EXISTS artifacts_no_delete BEFORE DELETE ON artifacts
  BEGIN SELECT RAISE(ABORT, 'trace store is append-only'); END;
CREATE TRIGGER IF NOT EXISTS edges_no_update BEFORE UPDATE ON edges
  BEGIN SELECT RAISE(ABORT, 'trace store is append-only'); END;
CREATE TRIGGER IF NOT EXISTS edges_no_delete BEFORE DELETE ON edges
  BEGIN SELECT RAISE(ABORT, 'trace store is append-only'); END;
`;

type Row = {
  id: string;
  type: string;
  source_ref: string | null;
  content: string;
  provenance: string;
  created_at: string;
};

const toArtifact = (r: Row): Artifact =>
  Artifact.parse({
    id: r.id,
    type: r.type,
    sourceRef: r.source_ref,
    content: JSON.parse(r.content),
    provenance: JSON.parse(r.provenance),
    createdAt: r.created_at,
  });

export class TraceStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  /**
   * Append an artifact and, atomically, its outgoing edges. Edges are written in the
   * same transaction so an artifact can never land without the links that give it meaning.
   */
  record(input: {
    type: Artifact['type'];
    sourceRef?: string | null;
    content: Record<string, unknown>;
    provenance: Provenance;
    links?: { to: string; relation: Relation }[];
  }): Artifact {
    const artifact: Artifact = Artifact.parse({
      id: `${input.type}_${randomUUID().slice(0, 8)}`,
      type: input.type,
      sourceRef: input.sourceRef ?? null,
      content: input.content,
      provenance: input.provenance,
      createdAt: new Date().toISOString(),
    });

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          artifact.id,
          artifact.type,
          artifact.sourceRef,
          JSON.stringify(artifact.content),
          JSON.stringify(artifact.provenance),
          artifact.createdAt,
        );
      for (const link of input.links ?? []) this.link(artifact.id, link.to, link.relation);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return artifact;
  }

  link(from: string, to: string, relation: Relation): Edge {
    const edge: Edge = Edge.parse({
      fromArtifactId: from,
      toArtifactId: to,
      relation,
      createdAt: new Date().toISOString(),
    });
    try {
      this.db
        .prepare('INSERT INTO edges VALUES (?, ?, ?, ?)')
        .run(from, to, relation, edge.createdAt);
    } catch (err) {
      // The FK constraint is the only realistic failure and its native message is opaque.
      if (!this.get(from) || !this.get(to)) {
        throw new Error(`cannot link ${from} -> ${to}: artifact does not exist`);
      }
      throw err;
    }
    return edge;
  }

  get(id: string): Artifact | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Row | undefined;
    return row && toArtifact(row);
  }

  list(type?: Artifact['type'], limit = 100): Artifact[] {
    const rows = type
      ? this.db
          .prepare('SELECT * FROM artifacts WHERE type = ? ORDER BY created_at DESC LIMIT ?')
          .all(type, limit)
      : this.db.prepare('SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?').all(limit);
    return (rows as Row[]).map(toArtifact);
  }

  edgesFrom(id: string): Edge[] {
    const rows = this.db.prepare('SELECT * FROM edges WHERE from_id = ?').all(id) as {
      from_id: string;
      to_id: string;
      relation: string;
      created_at: string;
    }[];
    return rows.map((e) =>
      Edge.parse({
        fromArtifactId: e.from_id,
        toArtifactId: e.to_id,
        relation: e.relation,
        createdAt: e.created_at,
      }),
    );
  }

  /**
   * The whole point of the store: from any artifact, walk edges transitively in both
   * directions and return the connected subgraph. Upstream = what this came from,
   * downstream = what came from this.
   */
  chain(id: string): Chain | undefined {
    const root = this.get(id);
    if (!root) return undefined;

    const walk = (sql: string) =>
      (this.db.prepare(sql).all(id) as { id: string }[]).map((r) => r.id).filter((x) => x !== id);

    const upstream = walk(`
      WITH RECURSIVE up(id) AS (
        SELECT ?
        UNION
        SELECT e.to_id FROM edges e JOIN up ON e.from_id = up.id
      ) SELECT id FROM up`);
    const downstream = walk(`
      WITH RECURSIVE down(id) AS (
        SELECT ?
        UNION
        SELECT e.from_id FROM edges e JOIN down ON e.to_id = down.id
      ) SELECT id FROM down`);

    const ids = [id, ...upstream, ...downstream];
    const holes = ids.map(() => '?').join(',');
    const nodes = (
      this.db
        .prepare(`SELECT * FROM artifacts WHERE id IN (${holes}) ORDER BY created_at`)
        .all(...ids) as Row[]
    ).map(toArtifact);
    const edges = (
      this.db
        .prepare(
          `SELECT * FROM edges WHERE from_id IN (${holes}) AND to_id IN (${holes}) ORDER BY created_at`,
        )
        .all(...ids, ...ids) as {
        from_id: string;
        to_id: string;
        relation: string;
        created_at: string;
      }[]
    ).map((e) =>
      Edge.parse({
        fromArtifactId: e.from_id,
        toArtifactId: e.to_id,
        relation: e.relation,
        createdAt: e.created_at,
      }),
    );

    return { root, upstream, downstream, nodes, edges };
  }
}
