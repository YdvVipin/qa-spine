# Audit Before Generating — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit every newly-planned Jira ticket against qa-spine's published ambiguity rubric, automatically and on a cheap model, so the questions land in the audit queue before tests are generated from the requirement.

**Architecture:** qa-spine exposes `audit_requirement` and `audit_submit` as CLI subcommands beside `record`. QAAE gains a cheap `audit` model purpose, an auditor agent following the `RecordingPlanGenerator` pattern, two client methods, and one call inside `start_from_ticket` that fires only when a requirement is newly recorded.

**Tech Stack:** TypeScript / Node >= 22.5 / `node:test` (qa-spine); Python 3.12 / pytest / `anthropic` + `openai` SDKs already installed (QAAE). No new dependencies in either repo.

## Global Constraints

- **No new dependencies.** qa-spine: only `@modelcontextprotocol/sdk` and `zod`. QAAE: only what is already installed.
- **The audit is advisory.** It never blocks planning, never changes a job's stage, and never changes a return value on failure. Gating is part 2 and out of scope here.
- **Non-fatal everywhere.** Spine unreachable, LLM down, unparseable response, findings rejected — all log a WARNING and let planning proceed.
- **Findings reach the store only through `audit_submit`.** Never through `record`. `audit_submit` rejects an unknown rule id and a non-verbatim quote, all-or-nothing; that validation is the anti-hallucination guarantee.
- **`audit-submit` validates provenance with `ProvenanceInput`, not `Provenance`.** The refined schema demands `promptVersion` for AI artifacts, but `submitFindings` stamps it from the rubric version — applying the refinement at the CLI boundary would reject a correct payload before the server could fill the field.
- **The audit fires once per requirement**, never on the resume path. A resumed job records no new requirement, and re-auditing appends duplicate findings — `submitFindings` has no dedup.
- **qa-spine's real store is off limits.** `.qa-spine/trace.db` holds exactly 8 artifacts. Every command sets `QA_SPINE_DB` to a path under `/tmp`, as an environment variable before the command, never as a trailing argument.
- **QAAE's working tree carries the user's uncommitted work.** Every `git add` names exact paths. Never `git add -A`, `git add .`, `git add -u`, `git commit -a`, `git stash`, `git reset --hard`, or `git clean`.
- Deliberate shortcuts get a `ponytail:` comment naming the ceiling and the upgrade path.
- Spec: `docs/superpowers/specs/2026-08-04-audit-before-generating-design.md`

## File Structure

| Repo | File | Responsibility |
| --- | --- | --- |
| qa-spine | `src/server.ts` (modify) | Two subcommands in the CLI switch. |
| qa-spine | `tests/audit-cli.test.ts` (create) | Subprocess tests for both. |
| qa-spine | `README.md` (modify) | A paragraph on the audit subcommands. |
| QAAE | `core/ai/providers.py` (modify) | The `audit` purpose. |
| QAAE | `core/agents/ambiguity_auditor.py` (create) | Prompt, model call, parsing. Never raises. |
| QAAE | `tests/test_ambiguity_auditor.py` (create) | Auditor tests, model call mocked. |
| QAAE | `core/trace/spine_client.py` (modify) | `_run` extraction plus two audit methods. |
| QAAE | `core/orchestration/loop_a.py` (modify) | `_audit_requirement` helper and the `start_from_ticket` call. |
| QAAE | `tests/test_spine_client.py`, `tests/test_spine_instrumentation.py` (modify) | Client and wiring tests. |

---

### Task 1: qa-spine CLI subcommands

**Files:**
- Modify: `src/server.ts` (import near line 17; two cases in the CLI switch)
- Create: `tests/audit-cli.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: existing `auditRequirement(store, requirementId)` and `submitFindings(store, input)` from `./audit.ts`; existing `ProvenanceInput` from `./trace/schema.ts`.
- Produces: two CLI contracts Task 3 depends on —
  - `node dist/server.js audit-requirement <id>` → prints `{requirement, rubric, instructions}`, exit 0
  - `node dist/server.js audit-submit` → reads `{requirementId, findings, provenance}` on stdin, prints `{recorded: [ids]}`, exit 0
  - Both print `{"error": "..."}` on **stdout** and exit 1 on any failure.

- [ ] **Step 1: Write the failing tests**

Create `tests/audit-cli.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore } from '../src/trace/store.ts';

/** Runs a subcommand against a throwaway DB. Returns exit code and parsed stdout. */
function run(args: string[], db: string, input?: string): { code: number; out: Record<string, any> } {
  try {
    const stdout = execFileSync('node', ['src/server.ts', ...args], {
      input: input ?? '',
      encoding: 'utf8',
      env: { ...process.env, QA_SPINE_DB: db },
    });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (err: any) {
    return { code: err.status ?? 1, out: JSON.parse(err.stdout || '{}') };
  }
}

/** A real file DB, because the subprocess needs a path it can open. */
function withDb(fn: (db: string, seed: () => string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-audit-'));
  const db = join(dir, 'trace.db');
  try {
    fn(db, () => {
      const store = new TraceStore(db);
      const req = store.record({
        type: 'requirement',
        sourceRef: 'PROJ-42',
        content: { text: 'Refunds must be processed quickly and the customer notified.' },
        provenance: { producer: 'human' },
      });
      store.close();
      return req.id;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('audit-requirement hands over the requirement, the rubric and the instructions', () => {
  withDb((db, seed) => {
    const id = seed();
    const { code, out } = run(['audit-requirement', id], db);
    assert.equal(code, 0);
    assert.equal(out.requirement.id, id);
    assert.match(out.requirement.text, /Refunds must be processed quickly/);
    assert.ok(out.rubric.version, 'rubric must carry a version');
    assert.ok(Array.isArray(out.rubric.rules) && out.rubric.rules.length > 0);
    assert.match(out.instructions, /audit_submit/);
  });
});

test('audit-requirement rejects an unknown id', () => {
  withDb((db) => {
    const { code, out } = run(['audit-requirement', 'requirement_deadbeef'], db);
    assert.equal(code, 1);
    assert.match(String(out.error), /no artifact with id requirement_deadbeef/);
  });
});

test('audit-requirement rejects an artifact that is not a requirement', () => {
  withDb((db, seed) => {
    const reqId = seed();
    const store = new TraceStore(db);
    const other = store.record({
      type: 'test_case',
      content: { name: 'x' },
      provenance: { producer: 'human' },
      links: [{ to: reqId, relation: 'covers' }],
    });
    store.close();

    const { code, out } = run(['audit-requirement', other.id], db);
    assert.equal(code, 1);
    assert.match(String(out.error), /is a test_case, not a requirement/);
  });
});

test('audit-requirement with no id prints usage and exits 1', () => {
  withDb((db) => {
    const { code, out } = run(['audit-requirement'], db);
    assert.equal(code, 1);
    assert.ok(out.error, 'expected an error field');
  });
});

test('audit-submit records findings and prints their ids', () => {
  withDb((db, seed) => {
    const id = seed();
    const payload = JSON.stringify({
      requirementId: id,
      findings: [{
        category: 'AMB-VAGUE-QUANT',
        quote: 'processed quickly',
        question: 'What measurable threshold makes this quick?',
        confidence: 'high',
      }],
      provenance: { producer: 'ai', model: 'claude-haiku-4-5' },
    });
    const { code, out } = run(['audit-submit'], db, payload);
    assert.equal(code, 0);
    assert.equal(out.recorded.length, 1);
    assert.match(out.recorded[0], /^finding_/);
  });
});

test('audit-submit accepts provenance with no promptVersion and stamps the rubric version', () => {
  withDb((db, seed) => {
    const id = seed();
    const payload = JSON.stringify({
      requirementId: id,
      findings: [{
        category: 'AMB-VAGUE-QUANT',
        quote: 'processed quickly',
        question: 'How quick?',
        confidence: 'high',
      }],
      // No promptVersion: the server stamps it. Validating with the refined
      // Provenance here would reject this correct payload.
      provenance: { producer: 'ai', model: 'claude-haiku-4-5' },
    });
    const { code, out } = run(['audit-submit'], db, payload);
    assert.equal(code, 0);

    const store = new TraceStore(db);
    const finding = store.get(out.recorded[0]);
    store.close();
    assert.ok(finding, 'finding must exist');
    assert.match(String(finding.provenance.promptVersion), /^ambiguity\//);
  });
});

test('audit-submit rejects an unknown rule id and writes nothing', () => {
  withDb((db, seed) => {
    const id = seed();
    const before = (() => { const s = new TraceStore(db); const n = s.list(undefined, 1e9).length; s.close(); return n; })();

    const { code, out } = run(['audit-submit'], db, JSON.stringify({
      requirementId: id,
      findings: [{ category: 'NOT-A-RULE', quote: 'processed quickly', question: 'q?', confidence: 'high' }],
      provenance: { producer: 'human' },
    }));
    assert.equal(code, 1);
    assert.match(String(out.error), /unknown rule "NOT-A-RULE"/);

    const after = (() => { const s = new TraceStore(db); const n = s.list(undefined, 1e9).length; s.close(); return n; })();
    assert.equal(after, before);
  });
});

test('audit-submit rejects a quote that is not verbatim in the requirement', () => {
  withDb((db, seed) => {
    const id = seed();
    const { code, out } = run(['audit-submit'], db, JSON.stringify({
      requirementId: id,
      findings: [{
        category: 'AMB-VAGUE-QUANT',
        quote: 'a phrase the model invented',
        question: 'q?',
        confidence: 'high',
      }],
      provenance: { producer: 'human' },
    }));
    assert.equal(code, 1);
    assert.match(String(out.error), /quote not found in requirement text/);
  });
});

test('audit-submit rejects malformed JSON with a readable error', () => {
  withDb((db) => {
    const { code, out } = run(['audit-submit'], db, '{not json');
    assert.equal(code, 1);
    assert.ok(out.error);
    assert.doesNotMatch(String(out.error), /\n\s+at /, 'must not be a raw stack trace');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/audit-cli.test.ts`
Expected: FAIL — neither subcommand exists, so the server falls through to `default` and starts an MCP stdio server instead of printing JSON.

- [ ] **Step 3: Add the import**

In `src/server.ts`, the existing `./audit.ts` import already brings in `auditRequirement` and `submitFindings`. Confirm both are in that import list; add whichever is missing.

- [ ] **Step 4: Add the subcommands**

In the `switch (process.argv[2])` block, after the `brief` case and before `default`:

```ts
    case 'audit-requirement': {
      // Errors go to stdout as JSON, like `record` and unlike `brief`: the caller
      // here is a program parsing one JSON object, not a document being redirected.
      const id = process.argv[3];
      if (!id) {
        console.log(JSON.stringify({ error: 'usage: qa-spine audit-requirement <requirementId>' }));
        process.exitCode = 1;
        break;
      }
      try {
        console.log(JSON.stringify(auditRequirement(store, id)));
      } catch (err) {
        console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        process.exitCode = 1;
      }
      break;
    }

    case 'audit-submit': {
      if (process.stdin.isTTY) {
        console.log(JSON.stringify({ error: 'audit-submit reads a JSON payload on stdin; pipe one in' }));
        process.exitCode = 1;
        break;
      }
      // ponytail: a caller that holds stdin open without closing it still hangs.
      // Upgrade path is a read timeout.
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        // ProvenanceInput, not Provenance: submitFindings stamps promptVersion from the
        // rubric version, so the refinement would reject a correct payload here.
        const provenance = ProvenanceInput.parse(input.provenance);
        const recorded = submitFindings(store, {
          requirementId: input.requirementId,
          findings: input.findings,
          provenance,
        });
        console.log(JSON.stringify({ recorded: recorded.map((a) => a.id) }));
      } catch (err) {
        console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        process.exitCode = 1;
      }
      break;
    }
```

`ProvenanceInput` is already imported in `src/server.ts` for the MCP tool schemas — confirm, and add it to that import if not.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/audit-cli.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Full suite and build**

Run: `npm test && npm run build`
Expected: all PASS (124 existing + 9 new = 133), `tsc` clean.

- [ ] **Step 7: Update the README**

Add after the "Rubrics" section:

````markdown
The audit is also reachable from the command line, so a non-JavaScript caller can run it:

```bash
node dist/server.js audit-requirement requirement_9f8e            # → requirement + rubric + instructions
echo '{"requirementId":"…","findings":[…],"provenance":{…}}' \
  | node dist/server.js audit-submit                              # → {"recorded":[ids]}
```

Findings must arrive through `audit-submit` rather than `trace_record`. It rejects a finding
citing an unknown rule id and a quote that is not verbatim in the requirement, all-or-nothing —
that check is what stops a hallucinated quote entering the store, and writing findings any other
way bypasses it.
````

- [ ] **Step 8: Commit**

```bash
cd /home/vipin-yadav/Desktop/MLProjects/qa-spine
git add src/server.ts tests/audit-cli.test.ts README.md
git commit -m "feat(cli): expose audit-requirement and audit-submit"
```

---

### Task 2: The `audit` purpose and the auditor agent

**Files:**
- Modify: `core/ai/providers.py` (`_MODEL_DEFAULTS` around line 29, `_MODEL_OVERRIDE_KEYS` around line 41)
- Create: `core/agents/ambiguity_auditor.py`
- Create: `tests/test_ambiguity_auditor.py`

**Interfaces:**
- Consumes: existing `core.ai.providers.resolve/api_key_for/openai_compat_client`, existing `core.ai.usage.record`.
- Produces, used by Task 4:
  - `audit(requirement_text: str, rubric: dict, instructions: str) -> list[dict]` — findings shaped `{category, quote, question, confidence}`. Returns `[]` on any failure. **Never raises.**

- [ ] **Step 1: Create the branch**

```bash
cd /home/vipin-yadav/Desktop/MLProjects/QAAutomationAIEnabler
git checkout -b audit-before-generating
git status --porcelain | wc -l   # the user's dirty files come along; leave them alone
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_ambiguity_auditor.py`:

```python
"""The auditor turns a requirement plus a rubric into findings, and never raises."""
import core.agents.ambiguity_auditor as auditor
import core.ai.providers as providers

RUBRIC = {
    "version": "ambiguity/1",
    "rules": [
        {"id": "AMB-VAGUE-QUANT", "name": "Unquantified adjective",
         "ask": "What measurable threshold makes this {term}?"},
        {"id": "AMB-MISSING-ACTOR", "name": "Missing actor",
         "ask": "Who performs this — which user role or which service?"},
    ],
}
INSTRUCTIONS = "For each rule that fires, return { category, quote, question, confidence }."
TEXT = "Refunds must be processed quickly and the customer notified."


def test_audit_returns_parsed_findings(monkeypatch):
    monkeypatch.setattr(auditor, "_call_model", lambda prompt, schema: {
        "findings": [{"category": "AMB-VAGUE-QUANT", "quote": "processed quickly",
                      "question": "What counts as quick?", "confidence": "high"}]
    })
    out = auditor.audit(TEXT, RUBRIC, INSTRUCTIONS)
    assert len(out) == 1
    assert out[0]["category"] == "AMB-VAGUE-QUANT"
    assert out[0]["quote"] == "processed quickly"


def test_audit_returns_empty_when_the_model_returns_no_findings(monkeypatch):
    monkeypatch.setattr(auditor, "_call_model", lambda prompt, schema: {"findings": []})
    assert auditor.audit(TEXT, RUBRIC, INSTRUCTIONS) == []


def test_audit_never_raises_on_an_unparseable_response(monkeypatch):
    monkeypatch.setattr(auditor, "_call_model", lambda prompt, schema: "not a dict")
    assert auditor.audit(TEXT, RUBRIC, INSTRUCTIONS) == []


def test_audit_never_raises_when_the_model_call_fails(monkeypatch):
    def boom(prompt, schema):
        raise RuntimeError("no API key configured")

    monkeypatch.setattr(auditor, "_call_model", boom)
    assert auditor.audit(TEXT, RUBRIC, INSTRUCTIONS) == []


def test_audit_drops_findings_missing_required_fields(monkeypatch):
    """A malformed finding would be rejected by audit_submit anyway, and one bad
    finding discards the whole batch there — so drop it here rather than lose the rest."""
    monkeypatch.setattr(auditor, "_call_model", lambda prompt, schema: {
        "findings": [
            {"category": "AMB-VAGUE-QUANT", "quote": "processed quickly",
             "question": "What counts as quick?", "confidence": "high"},
            {"category": "AMB-MISSING-ACTOR"},          # no quote, no question
            {"quote": "notified", "question": "By whom?"},  # no category
        ]
    })
    out = auditor.audit(TEXT, RUBRIC, INSTRUCTIONS)
    assert len(out) == 1
    assert out[0]["category"] == "AMB-VAGUE-QUANT"


def test_prompt_carries_the_requirement_the_rules_and_the_instructions():
    prompt = auditor._build_prompt(TEXT, RUBRIC, INSTRUCTIONS)
    assert TEXT in prompt
    assert "AMB-VAGUE-QUANT" in prompt
    assert "AMB-MISSING-ACTOR" in prompt
    assert INSTRUCTIONS in prompt


def test_audit_purpose_resolves_to_a_model_for_every_provider():
    for provider in ("anthropic", "openai", "xai"):
        assert providers.model_for(provider, "audit")


def test_audit_model_env_override(monkeypatch):
    monkeypatch.setenv("AUDIT_MODEL", "some-cheaper-model")
    assert providers.model_for("anthropic", "audit") == "some-cheaper-model"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_ambiguity_auditor.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'core.agents.ambiguity_auditor'`, and the two provider tests fail with a `KeyError` on the `("…", "audit")` key.

- [ ] **Step 4: Add the `audit` purpose**

In `core/ai/providers.py`, add to `_MODEL_DEFAULTS`:

```python
    ("anthropic", "audit"): "claude-haiku-4-5",
    ("openai", "audit"): "gpt-4o-mini",
    # No cheaper xai model is configured, so this buys nothing today — it is here so the
    # purpose resolves for every provider rather than raising, and so AUDIT_MODEL has
    # somewhere to land.
    ("xai", "audit"): "grok-3",
```

and to `_MODEL_OVERRIDE_KEYS`:

```python
    ("anthropic", "audit"): ("AUDIT_MODEL", "ANTHROPIC_MODEL"),
    ("openai", "audit"): ("AUDIT_MODEL", "OPENAI_PLAN_MODEL"),
    ("xai", "audit"): ("AUDIT_MODEL", "XAI_MODEL"),
```

Also extend the comment above `_MODEL_DEFAULTS` — it currently documents only `plan` and `fix` — to say `"audit"` is constrained extraction against a published rubric, which is why it uses the cheap model.

- [ ] **Step 5: Write the auditor**

Create `core/agents/ambiguity_auditor.py`:

```python
"""Reads a requirement against qa-spine's published ambiguity rubric.

The server never calls a model: `audit_requirement` hands over the requirement, the
rules and the instructions, and this is the half that reasons. Findings go back through
`audit_submit`, which rejects an unknown rule id or a quote that is not verbatim in the
requirement — so anything invented here is refused there rather than stored.

Runs on the cheap `audit` model purpose. This is constrained extraction — match a rule
from a short published list, copy a quote verbatim, ask one question — not the
open-ended reasoning a Recording Plan needs.

Never raises. An audit that can break test planning would be removed within a week.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List

from core.ai import providers as ai_providers

logger = logging.getLogger(__name__)

TOOL_NAME = "emit_ambiguity_findings"

_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "category": {"type": "string",
                                 "description": "A rule id from the rubric, copied exactly."},
                    "quote": {"type": "string",
                              "description": "Copied verbatim from the requirement text."},
                    "question": {"type": "string",
                                 "description": "What a human must answer to remove the ambiguity."},
                    "confidence": {"type": "string",
                                   "enum": ["high", "medium", "low", "unknown"]},
                },
                "required": ["category", "quote", "question", "confidence"],
            },
        }
    },
    "required": ["findings"],
}

_SYSTEM = (
    "You audit software requirements for ambiguity against a published rubric. "
    "You never rewrite the requirement — you only ask what a human must decide. "
    "Every quote you return must be copied character-for-character from the requirement."
)

_REQUIRED_FIELDS = ("category", "quote", "question", "confidence")


def _build_prompt(requirement_text: str, rubric: Dict[str, Any], instructions: str) -> str:
    rules = "\n".join(
        f"- {r.get('id')}: {r.get('name')} — ask: {r.get('ask')}"
        for r in rubric.get("rules", [])
    )
    return (
        f"{instructions}\n\n"
        f"RULES (use these ids exactly for `category`):\n{rules}\n\n"
        f"REQUIREMENT:\n{requirement_text}\n"
    )


def _call_model(prompt: str, schema: Dict[str, Any]) -> Any:
    """One structured call on the cheap audit model. Mocked in tests."""
    resolved = ai_providers.resolve(purpose="audit")
    provider, model = resolved["provider"], resolved["model"]
    if not resolved["api_key"]:
        raise RuntimeError(f"no API key configured for provider '{provider}'")

    if provider == "anthropic":
        import anthropic

        client = anthropic.Anthropic(api_key=ai_providers.api_key_for("anthropic"))
        response = client.messages.create(
            model=model,
            max_tokens=2000,
            system=_SYSTEM,
            tools=[{"name": TOOL_NAME,
                    "description": "Emit ambiguity findings for the requirement.",
                    "input_schema": schema}],
            tool_choice={"type": "tool", "name": TOOL_NAME},
            messages=[{"role": "user", "content": prompt}],
        )
        _record_usage(provider, model, getattr(response, "usage", None),
                      "input_tokens", "output_tokens")
        return next(
            (b.input for b in response.content if getattr(b, "type", None) == "tool_use"),
            None,
        )

    client = ai_providers.openai_compat_client(provider)
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": _SYSTEM},
                  {"role": "user", "content": prompt}],
        tools=[{"type": "function", "function": {
            "name": TOOL_NAME,
            "description": "Emit ambiguity findings for the requirement.",
            "parameters": schema,
        }}],
        tool_choice={"type": "function", "function": {"name": TOOL_NAME}},
    )
    _record_usage(provider, model, getattr(response, "usage", None),
                  "prompt_tokens", "completion_tokens")
    calls = response.choices[0].message.tool_calls or []
    return json.loads(calls[0].function.arguments) if calls else None


def _record_usage(provider: str, model: str, usage: Any, in_attr: str, out_attr: str) -> None:
    """Cost lands under its own purpose, so auditing is a visible line in the summary
    rather than hidden inside a total."""
    try:
        from core.ai.usage import record

        record(provider, model, "audit",
               getattr(usage, in_attr, 0), getattr(usage, out_attr, 0))
    except Exception:
        pass


def audit(requirement_text: str, rubric: Dict[str, Any], instructions: str) -> List[Dict[str, Any]]:
    """Findings for one requirement. Returns [] on any failure and never raises."""
    try:
        payload = _call_model(_build_prompt(requirement_text, rubric, instructions), _SCHEMA)
    except Exception as exc:
        logger.warning("ambiguity audit failed: %s", exc)
        return []

    if not isinstance(payload, dict):
        logger.warning("ambiguity audit returned no usable payload")
        return []

    findings = payload.get("findings")
    if not isinstance(findings, list):
        logger.warning("ambiguity audit returned no findings array")
        return []

    # audit_submit is all-or-nothing: one malformed finding discards the whole batch.
    # Dropping the bad ones here keeps the good ones.
    clean = [
        f for f in findings
        if isinstance(f, dict) and all(str(f.get(k) or "").strip() for k in _REQUIRED_FIELDS)
    ]
    if len(clean) != len(findings):
        logger.warning("ambiguity audit dropped %d malformed finding(s)", len(findings) - len(clean))
    return clean
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_ambiguity_auditor.py -q`
Expected: PASS, 8 tests.

- [ ] **Step 7: Confirm nothing else broke**

Run: `.venv/bin/python -m pytest tests/test_plan_generator.py tests/test_spine_client.py -q`
Expected: PASS — `providers.py` gained keys but changed none. If either was already failing before your change, say so explicitly rather than assuming you broke it.

- [ ] **Step 8: Commit — exact paths only**

```bash
cd /home/vipin-yadav/Desktop/MLProjects/QAAutomationAIEnabler
git add core/ai/providers.py core/agents/ambiguity_auditor.py tests/test_ambiguity_auditor.py
git commit -m "feat(audit): add the audit model purpose and the ambiguity auditor"
```

Verify with `git show --stat HEAD` — exactly three files.

---

### Task 3: The spine client's audit methods

**Files:**
- Modify: `core/trace/spine_client.py`
- Modify: `tests/test_spine_client.py` (append)

**Interfaces:**
- Consumes: the Task 1 CLI contracts.
- Produces, used by Task 4:
  - `audit_requirement(requirement_id: str, *, timeout: float = 15.0) -> dict | None`
  - `audit_submit(requirement_id: str, findings: list[dict], provenance: dict, *, timeout: float = 15.0) -> list[str] | None`
  - Both return `None` on any failure, and never raise.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_spine_client.py`:

```python
def test_audit_requirement_returns_the_payload(monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        return _Proc(0, json.dumps({"requirement": {"id": "requirement_1a", "text": "x"},
                                    "rubric": {"version": "ambiguity/1", "rules": []},
                                    "instructions": "…"}))

    monkeypatch.setattr(subprocess, "run", fake_run)
    got = spine.audit_requirement("requirement_1a")
    assert got["rubric"]["version"] == "ambiguity/1"
    assert seen["cmd"][-2:] == ["audit-requirement", "requirement_1a"]


def test_audit_requirement_returns_none_when_disabled(monkeypatch):
    monkeypatch.delenv("QA_SPINE_DIR", raising=False)
    called = []
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: called.append(a))
    assert spine.audit_requirement("requirement_1a") is None
    assert called == []


def test_audit_requirement_returns_none_on_a_cli_error(monkeypatch, tmp_path, caplog):
    _enable(monkeypatch, tmp_path)
    monkeypatch.setattr(subprocess, "run",
                        lambda *a, **k: _Proc(1, json.dumps({"error": "no artifact with id x"})))
    assert spine.audit_requirement("x") is None
    assert "no artifact with id x" in caplog.text


def test_audit_submit_returns_the_recorded_ids(monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        seen["payload"] = json.loads(kw["input"])
        return _Proc(0, json.dumps({"recorded": ["finding_aaa", "finding_bbb"]}))

    monkeypatch.setattr(subprocess, "run", fake_run)
    got = spine.audit_submit(
        "requirement_1a",
        [{"category": "AMB-VAGUE-QUANT", "quote": "q", "question": "?", "confidence": "high"}],
        {"producer": "ai", "model": "claude-haiku-4-5"},
    )
    assert got == ["finding_aaa", "finding_bbb"]
    assert seen["cmd"][-1] == "audit-submit"
    assert seen["payload"]["requirementId"] == "requirement_1a"
    # promptVersion is the server's to stamp, not ours to send.
    assert "promptVersion" not in seen["payload"]["provenance"]


def test_audit_submit_returns_none_when_findings_are_rejected(monkeypatch, tmp_path, caplog):
    _enable(monkeypatch, tmp_path)
    monkeypatch.setattr(subprocess, "run",
                        lambda *a, **k: _Proc(1, json.dumps({"error": 'unknown rule "NOPE"'})))
    assert spine.audit_submit("requirement_1a", [{"category": "NOPE"}], {"producer": "human"}) is None
    assert "NOPE" in caplog.text


def test_audit_submit_returns_none_on_timeout(monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)

    def blow_up(*a, **k):
        raise subprocess.TimeoutExpired(cmd="node", timeout=15.0)

    monkeypatch.setattr(subprocess, "run", blow_up)
    assert spine.audit_submit("requirement_1a", [], {"producer": "human"}) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_spine_client.py -q`
Expected: FAIL — `module 'core.trace.spine_client' has no attribute 'audit_requirement'`.

- [ ] **Step 3: Extract the shared subprocess runner**

`record()` already contains the subprocess call, the JSON parse, the dict guard and the error branch. Rather than copy that three times, extract it. Replace the body of `record()`'s subprocess section with a call to this new private helper, placed above `record`:

```python
def _run(args: List[str], *, payload: Optional[Dict[str, Any]] = None,
         timeout: float = 15.0) -> Optional[Dict[str, Any]]:
    """One CLI call. Returns the parsed object, or None on any failure.

    Every failure mode — disabled, missing node, non-zero exit, unparseable stdout,
    a JSON value that is not an object, an `error` key — collapses to None plus a
    WARNING. Callers never see an exception.
    """
    server = _server_js()
    if server is None or not _db_configured():
        logger.debug("qa-spine disabled (QA_SPINE_DIR or QA_SPINE_DB unset)")
        return None

    label = args[0] if args else "?"
    try:
        proc = subprocess.run(
            ["node", str(server), *args],
            input=json.dumps(payload) if payload is not None else "",
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout,
        )
        out = json.loads(proc.stdout or "{}")
    except Exception as exc:
        logger.warning("qa-spine %s failed: %s", label, exc)
        return None

    if not isinstance(out, dict):
        logger.warning("qa-spine %s returned a non-object response", label)
        return None
    if proc.returncode != 0 or "error" in out:
        logger.warning("qa-spine %s rejected: %s", label, out.get("error") or proc.stderr.strip())
        return None
    return out
```

Then `record()` becomes a payload builder plus `_run(["record"], payload=payload, timeout=timeout)`, returning `out.get("id")` and logging when a rc-0 response carries no `id` — preserve that existing behaviour exactly.

- [ ] **Step 4: Add the two audit methods**

```python
def audit_requirement(requirement_id: str, *, timeout: float = 15.0) -> Optional[Dict[str, Any]]:
    """The requirement, the published rubric and the instructions — or None."""
    return _run(["audit-requirement", requirement_id], timeout=timeout)


def audit_submit(requirement_id: str, findings: List[Dict[str, Any]],
                 provenance: Dict[str, Any], *, timeout: float = 15.0) -> Optional[List[str]]:
    """Record findings against a requirement. Returns the new ids, or None.

    `promptVersion` is deliberately absent from `provenance`: submitFindings stamps it
    from the rubric version and refuses a caller-supplied one, which is what makes
    "did that rubric edit help?" answerable from the exported review labels.
    """
    out = _run(["audit-submit"],
               payload={"requirementId": requirement_id,
                        "findings": findings,
                        "provenance": provenance},
               timeout=timeout)
    if out is None:
        return None
    recorded = out.get("recorded")
    if not isinstance(recorded, list):
        logger.warning("qa-spine audit-submit returned no recorded ids")
        return None
    return recorded
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_spine_client.py -q`
Expected: PASS — all existing tests plus the 6 new ones. The existing `record` tests must still pass unchanged; they are the proof the `_run` extraction preserved behaviour.

- [ ] **Step 6: Commit — exact paths only**

```bash
cd /home/vipin-yadav/Desktop/MLProjects/QAAutomationAIEnabler
git add core/trace/spine_client.py tests/test_spine_client.py
git commit -m "feat(trace): add audit_requirement and audit_submit to the spine client"
```

---

### Task 4: Wire the audit into `start_from_ticket`

**Files:**
- Modify: `core/orchestration/loop_a.py`
- Modify: `tests/test_spine_instrumentation.py` (append)

**Interfaces:**
- Consumes: `spine.audit_requirement`, `spine.audit_submit`, `spine.ai_provenance` from Task 3; `ambiguity_auditor.audit` from Task 2; the existing `_spine_record` helper and `advance(job, stage, **fields)`.
- Produces: `open_questions` in the `start_from_ticket` response and `spine_open_questions` on the job.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_spine_instrumentation.py`:

```python
def test_audit_helper_records_findings_and_returns_them(monkeypatch):
    """The helper itself: fetch the rubric, reason, submit, hand back the questions."""
    calls = {}
    monkeypatch.setattr(loop_a.spine, "audit_requirement", lambda rid: {
        "requirement": {"id": rid, "text": "Refunds must be processed quickly."},
        "rubric": {"version": "ambiguity/1", "rules": [{"id": "AMB-VAGUE-QUANT"}]},
        "instructions": "…",
    })
    monkeypatch.setattr(loop_a.auditor, "audit", lambda text, rubric, instructions: [
        {"category": "AMB-VAGUE-QUANT", "quote": "processed quickly",
         "question": "What counts as quick?", "confidence": "high"},
    ])
    monkeypatch.setattr(loop_a.spine, "audit_submit",
                        lambda rid, findings, prov: calls.setdefault("submitted", findings) or ["finding_a"])

    questions = loop_a._audit_requirement({"id": "job_1"}, "requirement_1a")
    assert len(questions) == 1
    assert questions[0]["question"] == "What counts as quick?"
    assert calls["submitted"][0]["category"] == "AMB-VAGUE-QUANT"


def test_audit_returns_empty_when_the_rubric_cannot_be_fetched(monkeypatch):
    monkeypatch.setattr(loop_a.spine, "audit_requirement", lambda rid: None)
    called = []
    monkeypatch.setattr(loop_a.auditor, "audit", lambda *a: called.append(a) or [])
    assert loop_a._audit_requirement({"id": "job_1"}, "requirement_1a") == []
    assert called == [], "must not call the model when there is no rubric to audit against"


def test_audit_returns_empty_when_the_model_finds_nothing(monkeypatch):
    monkeypatch.setattr(loop_a.spine, "audit_requirement", lambda rid: {
        "requirement": {"text": "x"}, "rubric": {"rules": []}, "instructions": "…"})
    monkeypatch.setattr(loop_a.auditor, "audit", lambda *a: [])
    submitted = []
    monkeypatch.setattr(loop_a.spine, "audit_submit",
                        lambda *a: submitted.append(a) or [])
    assert loop_a._audit_requirement({"id": "job_1"}, "requirement_1a") == []
    assert submitted == [], "must not submit an empty findings list"


def test_audit_returns_the_questions_even_when_recording_them_fails(monkeypatch):
    """A rejected batch is still worth telling the caller about."""
    monkeypatch.setattr(loop_a.spine, "audit_requirement", lambda rid: {
        "requirement": {"text": "x"}, "rubric": {"rules": []}, "instructions": "…"})
    monkeypatch.setattr(loop_a.auditor, "audit", lambda *a: [
        {"category": "AMB-VAGUE-QUANT", "quote": "q", "question": "?", "confidence": "high"}])
    monkeypatch.setattr(loop_a.spine, "audit_submit", lambda *a: None)

    out = loop_a._audit_requirement({"id": "job_1"}, "requirement_1a")
    assert len(out) == 1


def test_audit_never_raises(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("everything is on fire")

    monkeypatch.setattr(loop_a.spine, "audit_requirement", boom)
    assert loop_a._audit_requirement({"id": "job_1"}, "requirement_1a") == []


# ── the wiring itself, through the real start_from_ticket ─────────────────────
# `_isolate_start_from_ticket` and `_FakeJira` already exist in this file — reuse
# them rather than building a second harness.

def test_start_from_ticket_surfaces_the_questions_and_the_count(monkeypatch, _isolate_start_from_ticket):
    """The caller is told immediately, and the count outlives the terminal."""
    spy = _Spy(ids=["requirement_new"])
    _patch_spine(monkeypatch, spy)
    monkeypatch.setattr(loop_a.spine, "audit_requirement", lambda rid: {
        "requirement": {"id": rid, "text": "As a user I can log in with valid credentials."},
        "rubric": {"version": "ambiguity/1", "rules": [{"id": "AMB-MISSING-ACTOR"}]},
        "instructions": "…",
    })
    monkeypatch.setattr(loop_a.auditor, "audit", lambda text, rubric, instructions: [
        {"category": "AMB-MISSING-ACTOR", "quote": "valid credentials",
         "question": "Which roles count as a user here?", "confidence": "medium"},
    ])
    monkeypatch.setattr(loop_a.spine, "audit_submit", lambda rid, findings, prov: ["finding_a"])

    result = loop_a.start_from_ticket("scrum-42", jira_client=_FakeJira(), resume=False)

    assert result["success"] is True
    assert len(result["open_questions"]) == 1
    assert result["open_questions"][0]["question"] == "Which roles count as a user here?"
    assert "audit_answer" in result["next_step"]
    assert result["job"]["spine_open_questions"] == 1
    assert result["plan"], "the plan must still be generated — the audit is advisory"


def test_start_from_ticket_does_not_audit_when_nothing_was_recorded(monkeypatch, _isolate_start_from_ticket):
    """No requirement id means no requirement to audit — and no wasted model call."""
    monkeypatch.setattr(loop_a.spine, "record", lambda *a, **kw: None)
    monkeypatch.setattr(loop_a.spine, "enabled", lambda: True)
    called = []
    monkeypatch.setattr(loop_a.spine, "audit_requirement", lambda rid: called.append(rid))

    result = loop_a.start_from_ticket("scrum-43", jira_client=_FakeJira(), resume=False)

    assert result["success"] is True
    assert called == []
    assert result["open_questions"] == []
    assert result["job"]["spine_open_questions"] == 0


def test_start_from_ticket_still_returns_a_plan_when_the_audit_explodes(monkeypatch, _isolate_start_from_ticket):
    """The audit is advisory: a failure there must cost nothing already earned."""
    spy = _Spy(ids=["requirement_new"])
    _patch_spine(monkeypatch, spy)

    def boom(*a, **k):
        raise RuntimeError("the auditor is on fire")

    monkeypatch.setattr(loop_a.spine, "audit_requirement", boom)

    result = loop_a.start_from_ticket("scrum-44", jira_client=_FakeJira(), resume=False)

    assert result["success"] is True
    assert result["plan"]
    assert result["open_questions"] == []
    assert result["job"]["spine_requirement_id"] == "requirement_new"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_spine_instrumentation.py -q`
Expected: FAIL — `module 'core.orchestration.loop_a' has no attribute 'auditor'` and no `_audit_requirement`.

- [ ] **Step 3: Add the import and the helper**

In `core/orchestration/loop_a.py`, beside the existing `from core.trace import spine_client as spine`:

```python
from core.agents import ambiguity_auditor as auditor
```

Then add this helper immediately below `_spine_record`:

```python
def _audit_requirement(job: Dict[str, Any], requirement_id: str) -> List[Dict[str, Any]]:
    """Audit a freshly-recorded requirement and record what the model finds.

    Advisory: the questions are surfaced, nothing is blocked. Gating happens at the
    release boundary, where holding is proportionate — most real tickets are ambiguous,
    and a gate people cannot ship through is a gate people switch off.

    ponytail: a requirement is audited exactly once, when it is first recorded. Editing
    the ticket afterwards never re-audits, so the findings keep describing the text as it
    was. Upgrade: re-audit when the ticket's text digest changes — which needs the dedup
    submitFindings currently lacks, or duplicate findings pile up in the queue.
    """
    try:
        handed_over = spine.audit_requirement(requirement_id)
        if not handed_over:
            return []

        findings = auditor.audit(
            str(handed_over.get("requirement", {}).get("text") or ""),
            handed_over.get("rubric") or {},
            str(handed_over.get("instructions") or ""),
        )
        if not findings:
            return []

        # promptVersion is omitted deliberately — submitFindings stamps it from the
        # rubric version and refuses a caller-supplied one.
        recorded = spine.audit_submit(
            requirement_id,
            findings,
            spine.ai_provenance("audit", template_module="core.agents.ambiguity_auditor"),
        )
        if recorded is None:
            # The batch was rejected — most likely a quote the model did not copy
            # verbatim. Worth telling the caller anyway; the questions are still real.
            logger.warning("qa-spine rejected the audit findings for job %s", job.get("id"))
        return findings
    except Exception as exc:
        logger.warning("ambiguity audit failed for job %s: %s", job.get("id"), exc)
        return []
```

`ai_provenance` supplies `producer`, `model` and `promptVersion`; the CLI's `ProvenanceInput` accepts the extra `promptVersion` and `submitFindings` overwrites it with the rubric version, so nothing needs stripping.

- [ ] **Step 4: Call it from `start_from_ticket`**

Replace the `_spine_record(...)` call and the `advance(...)` that follows it with:

```python
    requirement_id = _spine_record(
        job,
        "requirement",
        source_ref=ticket_key,
        content={
            "text": ticket.get("description") or ticket.get("summary") or "",
            "summary": ticket.get("summary"),
            "issue_type": ticket.get("issue_type"),
        },
        provenance=spine.human_provenance(),
    )

    # Only a newly-recorded requirement is audited. The resume path returns long before
    # here, so a resumed job never re-audits and never duplicates its findings.
    open_questions = _audit_requirement(job, requirement_id) if requirement_id else []

    advance(
        job,
        JobStage.AWAITING_RECORDING,
        note="Recording plan ready — open the recorder and perform the steps",
        plan=plan_dict,
        spine_requirement_id=requirement_id,
        spine_open_questions=len(open_questions),
    )
```

Then add the questions to the returned dict, beside the existing keys:

```python
    return {
        "success": True,
        "job": job,
        "plan": plan_dict,
        "comment_id": comment_id,
        "open_questions": open_questions,
        "next_step": (
            "Answer these with audit_answer, or list everything outstanding with audit_open."
            if open_questions else None
        ),
        # … keep every existing key exactly as it is …
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_spine_instrumentation.py -q`
Expected: PASS — the existing instrumentation tests plus the 8 new ones (5 covering the helper,
3 driving the real `start_from_ticket`).

- [ ] **Step 6: Confirm nothing else broke**

Run: `.venv/bin/python -m pytest tests/test_orchestration_loops.py tests/test_loop_a_zephyr.py tests/test_workitem_aggregator.py tests/test_plan_generator.py -q`
Expected: PASS. `start_from_ticket` gained keys in its return dict and one call; no existing behaviour changed. If any of these was already failing, say so rather than assuming you broke it.

- [ ] **Step 7: Commit — exact paths only**

```bash
cd /home/vipin-yadav/Desktop/MLProjects/QAAutomationAIEnabler
git add core/orchestration/loop_a.py tests/test_spine_instrumentation.py
git commit -m "feat(audit): audit a ticket before its tests are generated"
```

Verify with `git show --stat HEAD` — exactly two files.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| `audit-requirement` / `audit-submit` subcommands | 1 |
| Errors on stdout as JSON, exit 1 | 1 |
| `ProvenanceInput` not `Provenance` at the CLI boundary | 1 (test 6) |
| `audit_submit` rejects unknown rule / non-verbatim quote | 1 (tests 7, 8) |
| The `audit` purpose, cheap model per provider | 2 |
| `AUDIT_MODEL` override — the xai escape hatch | 2 (test 8) |
| Auditor follows the RecordingPlanGenerator pattern | 2 |
| Auditor never raises | 2 (tests 3, 4) |
| Usage recorded under its own purpose | 2 |
| Client methods, non-fatal | 3 |
| `promptVersion` not sent by the caller | 3 (test 4) |
| Fires once, never on resume | 4 (comment + the resume path's early return) |
| Never fires when the spine is disabled | 4 (`if requirement_id`) + 3 (disabled test) |
| Non-fatal end to end | 4 (test 5) |
| `open_questions` and `next_step` in the response | 4 |
| `spine_open_questions` on the job | 4 |
| README | 1 |
| 3 `ponytail:` ceilings | 1, 3 (in `_run`'s docstring), 4 |

**Placeholder scan:** none — every step carries runnable code or an exact command.

**Type consistency:** `audit(requirement_text, rubric, instructions) -> list[dict]` is identical in Task 2's definition, Task 2's tests and Task 4's call. `audit_requirement(id) -> dict | None` and `audit_submit(id, findings, provenance) -> list[str] | None` match across Tasks 3 and 4. `_audit_requirement(job, requirement_id) -> list[dict]` is used with that signature in Task 4's tests and its call site.

**Two deliberate deviations from the spec, both flagged:**

1. **The auditor drops malformed findings rather than passing them through.** The spec did not say. `audit_submit` is all-or-nothing, so one finding missing a `quote` would discard an otherwise good batch — dropping it locally keeps the rest. Task 2 test 5 pins it.
2. **`_run` is extracted from `record()` in Task 3.** The spec describes only the two new methods. Copying the subprocess handling three times would be worse, and the existing `record` tests are the guard that the extraction preserved behaviour. If they fail, the extraction is wrong — do not adjust them.

**One risk worth stating:** Task 3 refactors `record()`, which is merged, reviewed, working code that the whole QAAE integration depends on. The existing tests must pass **unchanged**. If they do not, revert the extraction and duplicate the logic rather than editing the tests to fit.
