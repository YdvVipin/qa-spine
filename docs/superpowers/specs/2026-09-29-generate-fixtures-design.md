# Fixtures: schema-validated test data with locale packs

**Status:** implementing (roadmap X4)
**Date:** 2026-09-29
**Branch:** `fixtures`, cut from `team-features`.

## Stance

Same as the audit: qa-spine makes no model call. The agent generates test data; qa-spine
hands it the locale rules, validates what comes back, and records it with provenance, linked
to the test case or requirement it serves.

## Pieces

- **Locale packs** — `locales/<id>.json`, published and versioned like the rubric:
  `{ id, version, name, currency, formats: { phone, postal-code } }`, each format a regular
  expression. Shipped: `en-US`, `en-GB`, `de-DE`, `en-IN`. `QA_SPINE_LOCALES` points at your own.
- **`fixtures_request`** (MCP; CLI `fixtures-request <locale>`) — returns the locale pack and
  instructions. No model call.
- **`fixtures_submit`** (MCP; CLI `fixtures-submit`, JSON on stdin) —
  `{ schema, locale, fixtures, forId, provenance }`. Validates the schema, then every fixture
  against it, all or nothing, and records one `fixture` artifact:
  `{ locale, schemaDigest, schema, fixtures, count }`, `derived_from` `forId` (a test case or
  requirement), provenance stamped `promptVersion: fixtures/<locale>@<pack version>`.
- **`fixture`** is a new artifact type; the raw write paths refuse it.

## The schema subset

Keywords: `type` (object, array, string, number, integer, boolean, null), `properties`,
`required`, `additionalProperties: false`, `items`, `enum`, `const`, `minimum`, `maximum`,
`minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`, `format`, `description`, `title`.
Formats: `email`, `date`, `date-time`, `uuid`, and from the locale pack `phone` and
`postal-code`.

**Any other keyword refuses the schema.** A validator that ignored `oneOf` would pass data that
breaks it, and "validated" would be a claim nobody checked. Upgrade path: a real JSON Schema
dependency, if a team needs the rest.

## Not in this phase

Generating data server-side, fixture versioning (a new submission is simply a new artifact),
and gating releases on fixtures.
