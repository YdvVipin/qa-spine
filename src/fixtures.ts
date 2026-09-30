import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { canonical, type TraceStore } from './trace/store.ts';
import type { Artifact, Provenance } from './trace/schema.ts';

/**
 * Test data the agent generates and qa-spine checks, the way the audit works: no model call
 * here. A locale pack says what a phone number and a postcode look like where the data is
 * pretending to come from; the caller's JSON Schema says the rest.
 */

const Locale = z.object({
  id: z.string(),
  version: z.string(),
  name: z.string(),
  currency: z.string(),
  formats: z.object({ phone: z.string(), 'postal-code': z.string() }),
});
export type Locale = z.infer<typeof Locale>;

function localesDir(): string {
  return process.env.QA_SPINE_LOCALES
    ? resolve(process.env.QA_SPINE_LOCALES)
    : resolve(import.meta.dirname, '..', 'locales');
}

export function loadLocale(id: string): Locale {
  const available = () =>
    readdirSync(localesDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort().join(', ');
  // The id becomes a file path, so it is held to the shape of a locale tag.
  if (!/^[a-z]{2,3}-[A-Z]{2}$/.test(id)) throw new Error(`no locale pack "${id}" — available: ${available()}`);
  let raw: string;
  try {
    raw = readFileSync(resolve(localesDir(), `${id}.json`), 'utf8');
  } catch {
    throw new Error(`no locale pack "${id}" — available: ${available()}`);
  }
  return Locale.parse(JSON.parse(raw));
}

// ------------------------------------------------------------------ the schema subset

type Schema = Record<string, any>;
const KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum',
  'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'format', 'description', 'title',
]);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const FORMATS = new Set(['email', 'date', 'date-time', 'uuid', 'phone', 'postal-code']);

/**
 * Refuses any schema using something the validator does not check. A validator that
 * skipped `oneOf` would pass data that breaks it, and "validated" would be a claim nobody
 * checked.
 *
 * ponytail: a hand-written subset. Upgrade: a JSON Schema dependency, if a team needs the rest.
 */
export function assertSupportedSchema(schema: unknown, path = '$'): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`schema at ${path} must be an object`);
  const s = schema as Schema;
  for (const key of Object.keys(s)) {
    if (!KEYWORDS.has(key)) throw new Error(`unsupported keyword "${key}" at ${path} — it would not be checked, so it is refused`);
  }
  if (s.type !== undefined && !TYPES.has(s.type)) throw new Error(`unsupported type ${JSON.stringify(s.type)} at ${path}`);
  if (s.format !== undefined && !FORMATS.has(s.format)) throw new Error(`unsupported format "${s.format}" at ${path}`);
  if (s.additionalProperties !== undefined && s.additionalProperties !== false) {
    throw new Error(`additionalProperties at ${path} may only be false`);
  }
  if (s.pattern !== undefined) new RegExp(s.pattern, 'u');
  for (const [name, sub] of Object.entries(s.properties ?? {})) assertSupportedSchema(sub, `${path}.${name}`);
  if (s.items !== undefined) assertSupportedSchema(s.items, `${path}[]`);
}

const isDate = (v: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const FORMAT_CHECKS: Record<string, (v: string, locale: Locale) => boolean> = {
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  date: isDate,
  'date-time': (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v) && isDate(v.slice(0, 10)),
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  phone: (v, l) => new RegExp(l.formats.phone).test(v),
  'postal-code': (v, l) => new RegExp(l.formats['postal-code']).test(v),
};

const typeOf = (v: unknown) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;

/** Every way `value` breaks `schema`, as "path: problem". Empty when it fits. */
export function validateFixture(schema: Schema, value: unknown, locale: Locale, path = '$'): string[] {
  const problems: string[] = [];
  const say = (m: string) => problems.push(`${path}: ${m}`);

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) say(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) {
    say(`must be one of ${schema.enum.map((e: unknown) => JSON.stringify(e)).join(', ')}`);
  }
  if (schema.type) {
    const actual = typeOf(value);
    const fits = actual === schema.type || (schema.type === 'number' && actual === 'integer');
    if (!fits) {
      say(`must be ${schema.type === 'array' || schema.type === 'object' || schema.type === 'integer' ? 'an' : 'a'} ${schema.type}, got ${actual}`);
      return problems;
    }
  }

  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) say(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && length > schema.maxLength) say(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) say(`must match ${schema.pattern}`);
    if (schema.format && !FORMAT_CHECKS[schema.format](value, locale)) say(`is not a valid ${schema.format} for ${locale.id}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) say(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) say(`must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) say(`must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) say(`must have at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => problems.push(...validateFixture(schema.items, v, locale, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (obj[key] === undefined) problems.push(`${path}.${key}: is required`);
    for (const [key, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const sub = schema.properties?.[key];
      if (sub) problems.push(...validateFixture(sub, v, locale, `${path}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${path}.${key}: is not allowed`);
    }
  }
  return problems;
}

// ------------------------------------------------------------------ the tools

const INSTRUCTIONS =
  'Generate test data that satisfies the JSON Schema you were given and this locale: phone ' +
  'numbers and postcodes must match its formats, and amounts are in its currency. Use ' +
  'realistic but invented values — never a real person\'s details. Submit with ' +
  'fixtures_submit, passing the same schema, the locale id, and forId (the test case or ' +
  'requirement the data is for). One fixture that breaks the schema rejects the whole ' +
  'submission, and the error names it. Supported schema keywords: ' + [...KEYWORDS].join(', ') +
  '; formats: ' + [...FORMATS].join(', ') + '. Anything else is refused.';

export function fixturesRequest(locale: string) {
  return { locale: loadLocale(locale), instructions: INSTRUCTIONS };
}

export function submitFixtures(
  store: TraceStore,
  input: { schema: unknown; locale: string; fixtures: unknown[]; forId: string; provenance: Provenance },
): Artifact {
  const target = store.get(input.forId);
  if (target?.type !== 'test_case' && target?.type !== 'requirement') {
    throw new Error(`no test case or requirement with id ${input.forId}`);
  }
  if (!Array.isArray(input.fixtures) || !input.fixtures.length) throw new Error('submit at least one fixture');
  assertSupportedSchema(input.schema);
  const locale = loadLocale(input.locale);

  const problems = input.fixtures.flatMap((f, i) =>
    validateFixture(input.schema as Schema, f, locale).map((p) => `fixture ${i}: ${p}`),
  );
  if (problems.length) throw new Error(`fixtures rejected, nothing recorded — ${problems.join('; ')}`);

  return store.record({
    type: 'fixture',
    sourceRef: target.sourceRef,
    content: {
      locale: locale.id,
      schemaDigest: createHash('sha256').update(canonical(input.schema)).digest('hex'),
      schema: input.schema as Record<string, unknown>,
      fixtures: input.fixtures,
      count: input.fixtures.length,
    },
    // Like the audit's rubric version: the one provenance field qa-spine can honestly author.
    provenance: { ...input.provenance, promptVersion: `fixtures/${locale.id}@${locale.version}` },
    links: [{ to: target.id, relation: 'derived_from' }],
  });
}
