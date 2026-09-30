# Requirement versions and suspect requirements

**Status:** implemented on `requirement-versions`
**Date:** 2026-09-29
**Repo:** qa-spine only. Branch `requirement-versions`, cut from `main` @ `14149d0`.

## Problem

Tickets get edited. Today re-importing an edited ticket (or QAAE re-recording one) writes a
second `requirement` with the same `sourceRef` and no link to the first. Questions, answers
and tests stay attached to the old wording, and nothing says the audit is now out of date.
Jama and similar tools call this a *suspect link*; this phase borrows the idea.

## Decisions

### 1. Recording a requirement that already exists

`recordRequirement(store, input)` in `src/trace/store.ts` is what the raw write paths
(`trace_record`, CLI `record`) use for `type: 'requirement'` with a `sourceRef`. The Jira
importer uses it too.

- The **current** versions of a `sourceRef` are its requirements that no other requirement
  supersedes.
- Same content as the newest current version (compared as canonical JSON, keys sorted) →
  nothing is written; the existing artifact is returned. Re-running an import is idempotent.
- Different content → the new requirement is recorded with a `supersedes` link to **every**
  current version. That also folds the duplicates older imports left behind into one line.
- No `sourceRef` → recorded as before; there is nothing to compare against.

### 2. Suspect

A requirement on a changed area is **suspect** when it supersedes an earlier version and has
not been audited since it was recorded: nothing `derived_from` it is a `finding` or an `audit`.

- `assessReleaseRisk` returns `suspect: [{ requirementId, sourceRef, previousIds }]`.
- The gate lists them: *"PROJ-42 changed since it was last audited."* It is a **warning**:
  exit codes are unchanged (decision of 2026-09-29).
- `--block-on-suspect` makes the gate exit 1 while any is present. An override does not
  clear it; re-auditing does. The error says so. An override is a person accepting a known
  risk, and a suspect requirement is one nobody has looked at yet.
- Verdicts record `suspect` (the sourceRefs) when non-empty, and the brief lists them under
  *"Requirements that changed after they were last checked"*.

Findings and tests on superseded versions are untouched: an open question on old wording
still blocks until someone answers it (answering "fixed in the new wording" is a legitimate
answer), and a failing test covering an old version still counts, because changed-area
matching is by `sourceRef` and finds every version.

### 3. An audit that finds nothing is recorded

`audit_submit` (MCP and CLI) accepts an empty `findings` list and records one `audit`
artifact: `{ rubricVersion, findings: 0 }`, `derived_from` the requirement, provenance stamped
with the rubric version exactly as findings are. That is what clears *suspect* for a
requirement that is now clean, and it gives the later rubric-measurement work its true
negatives.

- `audit` is a new artifact type (stored as TEXT; no migration).
- The raw write paths refuse `audit` like the other gated types.
- A submission with findings still records only the findings; they already show it was audited.
- The findings of one submission are now written in one transaction.

## Not in this phase

- Inspector colouring for suspect items. The gate, brief and `assess_release_risk` carry it.
- Diffing old and new wording. The brief names the requirement; the ticket history has the diff.

## Testing

Revert-and-fail round trip for each guard.

- Same content twice → one artifact. Different content → supersedes; two legacy duplicates →
  both superseded. Key order does not make content "different".
- Suspect: edited requirement → suspect; after an audit with findings → not; after an empty
  audit → not; an unedited requirement never is.
- Gate: suspect listed, exit 0; `--block-on-suspect` → exit 1; with an override still 1.
- Verdict records `suspect`; brief renders it with no ids.
- Empty `audit_submit` records one `audit`; raw record of `audit` refused.
