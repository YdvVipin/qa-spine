import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
CREATE TABLE IF NOT EXISTS chain (
  seq  INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  ref  TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS chain_no_update BEFORE UPDATE ON chain
  BEGIN SELECT RAISE(ABORT, 'trace store is append-only'); END;
CREATE TRIGGER IF NOT EXISTS chain_no_delete BEFORE DELETE ON chain
  BEGIN SELECT RAISE(ABORT, 'trace store is append-only'); END;
`;

/**
 * The hash chain. Every artifact and edge written through this class appends a chain row:
 * `hash = sha256(previous hash + the row exactly as stored)`. The triggers above stop edits;
 * the chain is what shows an edit happened after someone removed them, or a row was added
 * straight into SQLite.
 *
 * The first chain row is a genesis row recording the highest rowid each table had before
 * chaining began: rows at or below it were written by a qa-spine that did not chain, and are
 * reported as legacy rather than as tampering.
 *
 * ponytail: nothing anchors the head outside the file, so someone who understands the scheme
 * can rewrite a row and recompute every hash after it. `verify` prints the head so a team can
 * anchor it somewhere they already trust; a store committed to git is anchored by git.
 * Upgrade: sign the head, or record it in the verdict and publish it with the brief.
 */
const GENESIS_PREV = '0'.repeat(64);
/** `PRAGMA user_version` once a store has started chaining. */
const CHAINED = 1;
const chainHash = (prev: string, payload: string) => createHash('sha256').update(prev).update(payload).digest('hex');
const artifactPayload = (r: Row) =>
  JSON.stringify(['artifact', r.id, r.type, r.source_ref, r.content, r.provenance, r.created_at]);
const edgePayload = (e: { from_id: string; to_id: string; relation: string; created_at: string }) =>
  JSON.stringify(['edge', e.from_id, e.to_id, e.relation, e.created_at]);
const edgeRef = (from: string, to: string, relation: string) => `${from}>${to}:${relation}`;

export type VerifyProblem = { kind: string; ref: string; problem: string };
export type VerifyResult = {
  ok: boolean;
  chained: number;
  legacy: number;
  head: string | null;
  problems: VerifyProblem[];
};

/** Types whose only legitimate writer is a gated recorder, and the recorder to use instead. */
const GATED: Partial<Record<Artifact['type'], string>> = {
  finding: 'audit_submit (it checks the quote is verbatim and the rule exists)',
  answer: 'audit_answer',
  audit: 'audit_submit',
  fixture: 'fixtures_submit (it validates the data against its schema)',
  verdict: 'release_submit (it recomputes what blocks the release)',
};

/**
 * The check the raw write paths (`trace_record`, CLI `record`) run before `store.record`.
 * It cannot live in `record` itself, because the gated recorders are what call `record`.
 * Without it, a raw write could retire an open question with no answer, or record a ship
 * verdict the gate never saw — the two holes this project used to document instead of close.
 *
 * ponytail: code that imports TraceStore directly is not guarded, the same trust boundary as
 * opening the SQLite file. The hash chain is what catches that after the fact.
 */
export function assertRawRecordAllowed(
  store: TraceStore,
  input: { type: Artifact['type']; links?: { to: string; relation: Relation }[] },
): void {
  const gated = GATED[input.type];
  if (gated) throw new Error(`a ${input.type} cannot be recorded directly — use ${gated}`);
  for (const link of input.links ?? []) {
    if (link.relation === 'supersedes' && store.get(link.to)?.type === 'finding') {
      throw new Error(
        `cannot supersede finding ${link.to} directly — answer it with audit_answer, which is what retires a question`,
      );
    }
  }
}

/** JSON with object keys sorted, so `{a, b}` and `{b, a}` compare equal. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/**
 * How the raw write paths record anything, so a requirement is versioned rather than
 * duplicated. For a requirement with a `sourceRef`: the same content as its newest current
 * version writes nothing and returns that version; different content is recorded with a
 * `supersedes` link to every current version — which also folds the duplicates older imports
 * left behind into one line. Anything else goes straight to `store.record`.
 */
export function recordRequirement(store: TraceStore, input: Parameters<TraceStore['record']>[0]): Artifact {
  const sourceRef = input.sourceRef;
  if (input.type !== 'requirement' || !sourceRef) return store.record(input);
  return store.transaction(() => {
    const current = store
      .bySourceRef([sourceRef])
      .filter((a) => a.type === 'requirement' && !store.linkedFrom(a.id, 'supersedes', 'requirement').length);
    const newest = current.at(-1);
    if (newest && canonical(newest.content) === canonical(input.content)) return newest;
    const links = [...(input.links ?? [])];
    for (const version of current) {
      if (!links.some((l) => l.to === version.id && l.relation === 'supersedes')) {
        links.push({ to: version.id, relation: 'supersedes' });
      }
    }
    return store.record({ ...input, links });
  });
}

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
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    // Concurrent writers (multiple CLI `record` invocations) otherwise hit
    // SQLITE_BUSY immediately instead of waiting for the lock to clear.
    this.db.exec('PRAGMA busy_timeout = 5000');
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

    this.insertArtifact(artifact, input.links ?? []);
    return artifact;
  }

  /** Writes an artifact exactly as given — id and time included — with its chain row and links. */
  private insertArtifact(artifact: Artifact, links: { to: string; relation: Relation }[]) {
    // A savepoint, not BEGIN: BEGIN cannot nest, and record() must work both on its own
    // and inside transaction(). Outside one, a savepoint opens and commits its own.
    this.db.exec('SAVEPOINT record');
    try {
      const row: Row = {
        id: artifact.id,
        type: artifact.type,
        source_ref: artifact.sourceRef,
        content: JSON.stringify(artifact.content),
        provenance: JSON.stringify(artifact.provenance),
        created_at: artifact.createdAt,
      };
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.id, row.type, row.source_ref, row.content, row.provenance, row.created_at);
      this.appendChain('artifact', row.id, artifactPayload(row), lastInsertRowid);
      for (const link of links) this.link(artifact.id, link.to, link.relation);
      this.db.exec('RELEASE record');
    } catch (err) {
      this.db.exec('ROLLBACK TO record; RELEASE record');
      throw err;
    }
  }

  /**
   * Brings in every artifact and edge another store has and this one lacks, keeping their ids
   * and times, chained here as they arrive. The other store must verify first, and an id both
   * stores hold with different content refuses the whole merge: append-only means neither copy
   * can be the one that wins. All or nothing, in one transaction.
   *
   * Opened on a copy, because opening a store writes its schema and a merge must not touch
   * its source.
   *
   * ponytail: two stores that each versioned the same requirement independently end up with
   * two current versions. The next recordRequirement for that ref supersedes both, which is
   * the same fold that cleans up old duplicates.
   */
  mergeFrom(otherPath: string): { artifacts: number; edges: number } {
    if (!existsSync(otherPath)) throw new Error(`no trace store at ${otherPath}`);
    const dir = mkdtempSync(join(tmpdir(), 'qa-spine-merge-'));
    const copy = join(dir, 'source.db');
    copyFileSync(otherPath, copy);
    const other = new TraceStore(copy);
    try {
      const check = other.verify();
      if (!check.ok) {
        throw new Error(
          `${otherPath} failed verification, refusing to merge: ` +
            check.problems.map((p) => `${p.ref} ${p.problem}`).join('; '),
        );
      }
      const incoming = other.list(undefined, 1e9).reverse();
      return this.transaction(() => {
        let artifacts = 0;
        let edges = 0;
        for (const a of incoming) {
          const mine = this.get(a.id);
          if (!mine) {
            this.insertArtifact(a, []);
            artifacts++;
          } else if (canonical(mine) !== canonical(a)) {
            throw new Error(`artifact ${a.id} differs between the two stores — refusing to merge`);
          }
        }
        for (const a of incoming) {
          for (const e of other.edgesFrom(a.id)) {
            const have = this.edgesFrom(e.fromArtifactId).some((m) => m.toArtifactId === e.toArtifactId && m.relation === e.relation);
            if (have) continue;
            this.insertEdge(e.fromArtifactId, e.toArtifactId, e.relation, e.createdAt);
            edges++;
          }
        }
        return { artifacts, edges };
      });
    } finally {
      other.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Runs `fn` in one transaction: every record and link inside it lands, or none does.
   * IMMEDIATE takes the write lock up front. A deferred transaction that reads first and
   * then writes cannot wait for another writer — SQLite fails the upgrade at once rather than
   * risk a deadlock, and busy_timeout never applies.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  link(from: string, to: string, relation: Relation): Edge {
    return this.insertEdge(from, to, relation, new Date().toISOString());
  }

  private insertEdge(from: string, to: string, relation: Relation, createdAt: string): Edge {
    const edge: Edge = Edge.parse({ fromArtifactId: from, toArtifactId: to, relation, createdAt });
    // The edge and its chain row land together or not at all.
    this.db.exec('SAVEPOINT link');
    try {
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO edges VALUES (?, ?, ?, ?)')
        .run(from, to, relation, edge.createdAt);
      this.appendChain(
        'edge',
        edgeRef(from, to, relation),
        edgePayload({ from_id: from, to_id: to, relation, created_at: edge.createdAt }),
        lastInsertRowid,
      );
      this.db.exec('RELEASE link');
    } catch (err) {
      this.db.exec('ROLLBACK TO link; RELEASE link');
      // The FK constraint is the only realistic failure and its native message is opaque.
      if (!this.get(from) || !this.get(to)) {
        throw new Error(`cannot link ${from} -> ${to}: artifact does not exist`);
      }
      throw err;
    }
    return edge;
  }

  /**
   * Appends the chain row for a row just inserted. Called after the insert, never before:
   * the insert takes SQLite's write lock, so two writers cannot both read the same head.
   */
  private appendChain(kind: 'artifact' | 'edge', ref: string, payload: string, ownRowid: number | bigint) {
    const insert = this.db.prepare('INSERT INTO chain (kind, ref, hash) VALUES (?, ?, ?)');
    let prev = (this.db.prepare('SELECT hash FROM chain ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined)
      ?.hash;
    if (!prev) {
      // The highest rowid and the row count each table had before this row. Everything at or
      // below the rowid is legacy; the count is what shows a row later slipped in among them.
      const mark = (table: 'artifacts' | 'edges', own: number | bigint) =>
        this.db.prepare(`SELECT coalesce(max(rowid), 0) AS m, count(*) AS n FROM ${table} WHERE rowid <> ?`).get(own) as {
          m: number;
          n: number;
        };
      const a = mark('artifacts', kind === 'artifact' ? ownRowid : -1);
      const e = mark('edges', kind === 'edge' ? ownRowid : -1);
      const watermarks = `${a.m}:${e.m}:${a.n}:${e.n}`;
      prev = chainHash(GENESIS_PREV, JSON.stringify(['genesis', watermarks]));
      insert.run('genesis', watermarks, prev);
      // Marks the file as chained, so a chain wiped later reads as removed, not as a legacy
      // store. Transactional: rolled back with the write that set it.
      // ponytail: a speed bump — someone who knows can reset it too. Same ceiling as the chain.
      this.db.exec(`PRAGMA user_version = ${CHAINED}`);
    }
    insert.run(kind, ref, chainHash(prev, payload));
  }

  /** Recomputes the chain and checks every row against it. Reads only. */
  verify(): VerifyResult {
    const chain = this.db.prepare('SELECT kind, ref, hash FROM chain ORDER BY seq').all() as {
      kind: string;
      ref: string;
      hash: string;
    }[];
    const countAbove = (table: 'artifacts' | 'edges', mark: number, above: boolean) =>
      (this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE rowid ${above ? '>' : '<='} ?`).get(mark) as { n: number }).n;

    if (!chain.length) {
      const all = countAbove('artifacts', -Infinity, true) + countAbove('edges', -Infinity, true);
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version >= CHAINED) {
        return { ok: false, chained: 0, legacy: 0, head: null, problems: [{ kind: 'chain', ref: 'chain', problem: 'the hash chain was removed' }] };
      }
      return { ok: true, chained: 0, legacy: all, head: null, problems: [] };
    }

    const problems: VerifyProblem[] = [];
    const chainedArtifacts = new Set<string>();
    const chainedEdges = new Set<string>();
    let [artifactMark, edgeMark, artifactLegacy, edgeLegacy] = [0, 0, 0, 0];
    let prev = GENESIS_PREV;

    for (const link of chain) {
      let payload: string | undefined;
      if (link.kind === 'genesis') {
        [artifactMark, edgeMark, artifactLegacy, edgeLegacy] = link.ref.split(':').map(Number);
        payload = JSON.stringify(['genesis', link.ref]);
      } else if (link.kind === 'artifact') {
        chainedArtifacts.add(link.ref);
        const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(link.ref) as Row | undefined;
        payload = row && artifactPayload(row);
      } else {
        chainedEdges.add(link.ref);
        const [from, rest] = [link.ref.slice(0, link.ref.indexOf('>')), link.ref.slice(link.ref.indexOf('>') + 1)];
        const [to, relation] = [rest.slice(0, rest.lastIndexOf(':')), rest.slice(rest.lastIndexOf(':') + 1)];
        const row = this.db
          .prepare('SELECT * FROM edges WHERE from_id = ? AND to_id = ? AND relation = ?')
          .get(from, to, relation) as { from_id: string; to_id: string; relation: string; created_at: string } | undefined;
        payload = row && edgePayload(row);
      }
      if (payload === undefined) problems.push({ kind: link.kind, ref: link.ref, problem: 'deleted' });
      else if (chainHash(prev, payload) !== link.hash) {
        problems.push({ kind: link.kind, ref: link.ref, problem: 'changed after it was recorded' });
      }
      // Each row is judged against the hash stored before it, so one edit is one problem,
      // not a cascade down the rest of the chain.
      prev = link.hash;
    }

    const unchained = [
      // SQLite assigns rowids from 1 up, so one below 1 was chosen by whoever inserted it.
      ...(this.db.prepare('SELECT id FROM artifacts WHERE rowid > ? OR rowid < 1').all(artifactMark) as { id: string }[])
        .filter((r) => !chainedArtifacts.has(r.id))
        .map((r) => ({ kind: 'artifact', ref: r.id })),
      ...(this.db.prepare('SELECT from_id, to_id, relation FROM edges WHERE rowid > ? OR rowid < 1').all(edgeMark) as {
        from_id: string;
        to_id: string;
        relation: string;
      }[])
        .map((e) => edgeRef(e.from_id, e.to_id, e.relation))
        .filter((ref) => !chainedEdges.has(ref))
        .map((ref) => ({ kind: 'edge', ref })),
    ];
    for (const u of unchained) problems.push({ ...u, problem: 'not written by qa-spine' });

    const inLegacyRange = (table: 'artifacts' | 'edges', mark: number) =>
      (this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE rowid BETWEEN 1 AND ?`).get(mark) as { n: number }).n;
    const legacyArtifacts = inLegacyRange('artifacts', artifactMark);
    const legacyEdges = inLegacyRange('edges', edgeMark);
    for (const [table, found, expected] of [['artifacts', legacyArtifacts, artifactLegacy], ['edges', legacyEdges, edgeLegacy]] as const) {
      if (found > expected) {
        problems.push({ kind: table, ref: table, problem: `${found - expected} row(s) added among the rows from before the chain` });
      }
    }

    return {
      ok: problems.length === 0,
      chained: chain.length - 1,
      legacy: Math.min(legacyArtifacts, artifactLegacy) + Math.min(legacyEdges, edgeLegacy),
      head: prev,
      problems,
    };
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

  /**
   * Artifacts of `type` with a `relation` edge pointing at `toId`, newest first — e.g. the
   * runs that verify a test case. `rowid` breaks ties: one ingest writes many artifacts
   * inside the same millisecond, and "latest" must still mean the last one written.
   */
  linkedFrom(toId: string, relation: Relation, type: Artifact['type']): Artifact[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM artifacts a JOIN edges e ON e.from_id = a.id
          WHERE e.to_id = ? AND e.relation = ? AND a.type = ?
          ORDER BY a.created_at DESC, a.rowid DESC`,
      )
      .all(toId, relation, type);
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
