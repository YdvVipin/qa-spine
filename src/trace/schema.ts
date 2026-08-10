import { z } from 'zod';

/** What kind of thing an artifact is. Stored as TEXT, so adding a type needs no migration. */
export const ArtifactType = z.enum([
  'requirement',
  'finding',
  'test_case',
  'test_run',
  'defect',
  'verdict',
  /** A human's thumbs up/down on an AI artifact, captured by the Inspector. */
  'review',
  /** A human's reply to a finding's question. Supersedes the finding it answers. */
  'answer',
]);

/**
 * How two artifacts relate. Edge direction is always new -> existing:
 * a finding is `derived_from` a requirement, a test_case `covers` a requirement,
 * a test_run `verifies` a test_case, a verdict `supersedes` an earlier verdict.
 */
export const Relation = z.enum([
  'derived_from',
  'tests',
  'covers',
  'verifies',
  'contradicts',
  'supersedes',
  /** A review judges the artifact it points at. Kept distinct so chain views can hide it. */
  'reviews',
]);

/**
 * Who produced an artifact and, for a machine, exactly what produced it. `model` and
 * `promptVersion` are mandatory for AI output: an AI artifact that cannot say which
 * model and which prompt version made it is not traceable, which defeats the point.
 *
 * `tool` is for deterministic producers — a CI gate, an importer — which have no model
 * and no prompt, and for which `human` would be a lie. It carries the same obligation in
 * its own terms: a tool-produced artifact must name the tool. Recording pipeline output as
 * `human` would corrupt the one field this project treats as load-bearing everywhere else.
 */
export const ProvenanceInput = z.object({
  producer: z.enum(['human', 'ai', 'tool']),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  tool: z.string().optional(),
  toolVersion: z.string().optional(),
  inputDigest: z.string().optional(),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
});

/** The refinement is dropped from `ProvenanceInput` so tool wire schemas stay plain JSON Schema. */
export const Provenance = ProvenanceInput.refine(
  (p) =>
    p.producer === 'human' ||
    (p.producer === 'tool' ? !!p.tool : !!p.model && !!p.promptVersion),
  {
    message:
      'AI-produced artifacts must record model and promptVersion; tool-produced artifacts must record tool',
  },
);

export const Artifact = z.object({
  id: z.string(),
  type: ArtifactType,
  sourceRef: z.string().nullable(),
  content: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  provenance: Provenance,
});

export const Edge = z.object({
  fromArtifactId: z.string(),
  toArtifactId: z.string(),
  relation: Relation,
  createdAt: z.string(),
});

export type ArtifactType = z.infer<typeof ArtifactType>;
export type Relation = z.infer<typeof Relation>;
export type Provenance = z.infer<typeof Provenance>;
export type Artifact = z.infer<typeof Artifact>;
export type Edge = z.infer<typeof Edge>;

/** An artifact plus everything reachable from it in either direction. */
export type Chain = {
  root: Artifact;
  upstream: string[];
  downstream: string[];
  nodes: Artifact[];
  edges: Edge[];
};
