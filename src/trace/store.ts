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

  /**
   * Artifacts whose sourceRef is one of `refs` — the join between "what this release
   * changed" and what the spine knows, since every artifact already carries the ref it
   * came from. Matching is exact equality.
   *
   * ponytail: exact match only, no prefix or glob. A caller must pass both file paths and
   * ticket keys. If path-shaped refs ever need to reach their requirement on their own,
   * add prefix matching or a published path->requirement map.
   */
  bySourceRef(refs: string[]): Artifact[] {
    // `IN ()` is a syntax error in SQLite, not an empty result set.
    if (!refs.length) return [];
    const holes = refs.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM artifacts WHERE source_ref IN (${holes}) ORDER BY created_at`)
      .all(...refs);
    return (rows as Row[]).map(toArtifact);
  }

  /**
   * Findings nothing has superseded — the audit queue's worklist. Asked in SQL rather than
   * by listing every finding and filtering in JS, which would be right only at today's size.
   *
   * `requirementId`, when given, filters in the same query rather than after it: filtering
   * a capped, recency-ordered result in JS could drop a genuinely-open finding on the
   * requested requirement just because enough newer findings on *other* requirements filled
   * the window first.
   *
   * ponytail: `limit` is the only paging. A queue a human works down does not need more;
   * if one ever holds more open findings than this, it needs real paging, not a bigger number.
   */
  openFindings(limit = 500, requirementId?: string): Artifact[] {
    const requirementFilter = requirementId
      ? `AND EXISTS (
            SELECT 1 FROM edges d WHERE d.from_id = a.id AND d.relation = 'derived_from' AND d.to_id = ?
          )`
      : '';
    const params = requirementId ? [requirementId, limit] : [limit];
    const rows = this.db
      .prepare(
        `SELECT * FROM artifacts a
          WHERE a.type = 'finding'
            AND NOT EXISTS (
              SELECT 1 FROM edges e WHERE e.to_id = a.id AND e.relation = 'supersedes'
            )
            ${requirementFilter}
          ORDER BY a.created_at DESC
          LIMIT ?`,
      )
      .all(...params);
    return (rows as Row[]).map(toArtifact);
  }

  /** Shared by edgesFrom/edgesTo. `column` is a closed union, never caller input. */
  private edgesBy(column: 'from_id' | 'to_id', id: string): Edge[] {
    const rows = this.db.prepare(`SELECT * FROM edges WHERE ${column} = ?`).all(id) as {
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

  edgesFrom(id: string): Edge[] {
    return this.edgesBy('from_id', id);
  }

  /** Incoming edges. What resolves a finding points AT it, so edgesFrom cannot find it. */
  edgesTo(id: string): Edge[] {
    return this.edgesBy('to_id', id);
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
