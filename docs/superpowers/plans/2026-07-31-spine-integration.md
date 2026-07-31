# Spine Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record QAAutomationAIEnabler's Loop A into qa-spine's append-only ledger, so every AI-produced plan, test and heal survives with the model and prompt version that made it.

**Architecture:** qa-spine grows a `record` subcommand that reads a JSON payload on stdin and appends through the existing `store.record()`. QAAE grows `core/trace/spine_client.py`, which shells out to it, and four instrumentation calls at `loop_a.py`'s existing `attach` seams. Recording is opt-in via `QA_SPINE_DIR` and can never raise.

**Tech Stack:** qa-spine — TypeScript, Node >= 22.5, `node:sqlite`, `node:test`. QAAE — Python 3.12, pytest, `subprocess`.

## Global Constraints

- **Two repos.** qa-spine at `/home/vipin-yadav/Desktop/MLProjects/qa-spine`; QAAE at `/home/vipin-yadav/Desktop/MLProjects/QAAutomationAIEnabler`. Never commit across both in one command.
- **QAAE's working tree is dirty and it is NOT yours.** 28 modified + 15 untracked files of the user's in-progress work. **Every `git add` must name exact file paths.** Never `git add -A`, `git add .`, `git add -u`, or `git commit -a`. Committing the user's uncommitted work is the worst outcome available in this plan.
- **Work on a branch in both repos.** Never commit to `main` (qa-spine) or `master` (QAAE).
- **No new dependencies in either repo.** qa-spine: only `@modelcontextprotocol/sdk` and `zod`. QAAE: standard library only for the new module.
- **Recording never raises and never changes QA behaviour.** Every failure degrades to `None` + a WARNING log. No instrumentation may alter a job's stage, fail a job, or change a return value.
- **Recording is opt-in.** `QA_SPINE_DIR` unset → every call is a no-op. QAAE must stay runnable with no Node installed.
- **The store is append-only.** Never `UPDATE` or `DELETE`.
- **AI provenance is mandatory.** `producer: "ai"` without `model` and `promptVersion` is rejected by the store. A deterministic (non-AI) heal must be recorded as `human`.
- Deliberate shortcuts get a `ponytail:` comment naming the ceiling and the upgrade path.
- Spec: `docs/superpowers/specs/2026-07-31-spine-integration-design.md` (in qa-spine).

## File Structure

| Repo | File | Responsibility |
| --- | --- | --- |
| qa-spine | `src/server.ts` (modify) | Add `record` to the CLI switch. |
| qa-spine | `tests/record-cli.test.ts` (create) | Subprocess tests for the subcommand. |
| QAAE | `core/trace/__init__.py` (create) | Package marker. |
| QAAE | `core/trace/spine_client.py` (create) | Subprocess client + provenance helpers. |
| QAAE | `tests/test_spine_client.py` (create) | Client tests, subprocess mocked. |
| QAAE | `core/orchestration/loop_a.py` (modify) | Four instrumentation calls. |
| QAAE | `tests/test_spine_instrumentation.py` (create) | The four call sites, `record` mocked. |
| QAAE | `scripts/spine_demo.py` (create) | End-to-end demo, no Jira/browser/LLM. |
| QAAE | `docs/superpowers/specs/2026-07-31-spine-integration-design.md` (create) | Pointer to the real spec. |

---

### Task 1: qa-spine `record` subcommand

**Files:**
- Modify: `src/server.ts` (the CLI switch, around lines 216-231)
- Test: `tests/record-cli.test.ts` (create)

**Interfaces:**
- Consumes: existing `TraceStore.record(input)` and `dbPath()`.
- Produces: CLI contract `node src/server.ts record` — reads a JSON object on stdin; on success prints the created artifact as JSON and exits 0; on any failure prints `{"error": "..."}` and exits 1. Task 2 depends on exactly this contract.

- [ ] **Step 1: Confirm the branch**

The `spine-integration` branch already exists in qa-spine — the plan itself was committed on it.

```bash
cd /home/vipin-yadav/Desktop/MLProjects/qa-spine
git branch --show-current   # must print: spine-integration
```

If it prints anything else, run `git checkout spine-integration`. Do not create it again.

- [ ] **Step 2: Write the failing tests**

Create `tests/record-cli.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs the subcommand against a throwaway DB. Returns exit code and parsed stdout. */
function runRecord(payload: unknown, db: string): { code: number; out: Record<string, any> } {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  try {
    const stdout = execFileSync('node', ['src/server.ts', 'record'], {
      input,
      encoding: 'utf8',
      env: { ...process.env, QA_SPINE_DB: db },
    });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (err: any) {
    return { code: err.status ?? 1, out: JSON.parse(err.stdout || '{}') };
  }
}

function withDb(fn: (db: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-spine-cli-'));
  try {
    fn(join(dir, 'trace.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('record appends a human artifact and prints it', () => {
  withDb((db) => {
    const { code, out } = runRecord(
      {
        type: 'requirement',
        sourceRef: 'SCRUM-42',
        content: { text: 'Refunds must be processed quickly.' },
        provenance: { producer: 'human' },
      },
      db,
    );
    assert.equal(code, 0);
    assert.ok(String(out.id).startsWith('requirement_'), `unexpected id: ${out.id}`);
    assert.equal(out.sourceRef, 'SCRUM-42');
  });
});

test('record rejects an AI artifact with no model and writes nothing', () => {
  withDb((db) => {
    const { code, out } = runRecord(
      {
        type: 'test_case',
        content: { name: 'login works' },
        provenance: { producer: 'ai' },
      },
      db,
    );
    assert.equal(code, 1);
    assert.match(String(out.error), /model and promptVersion/);
  });
});

test('record rejects malformed JSON with a readable error', () => {
  withDb((db) => {
    const { code, out } = runRecord('{not json', db);
    assert.equal(code, 1);
    assert.ok(out.error, 'expected an error field');
    assert.doesNotMatch(String(out.error), /\n\s+at /, 'error should not be a raw stack trace');
  });
});

test('record rejects a link to an artifact that does not exist', () => {
  withDb((db) => {
    const { code, out } = runRecord(
      {
        type: 'test_case',
        content: { name: 'orphan' },
        provenance: { producer: 'human' },
        links: [{ to: 'requirement_deadbeef', relation: 'covers' }],
      },
      db,
    );
    assert.equal(code, 1);
    assert.match(String(out.error), /does not exist/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/record-cli.test.ts`
Expected: FAIL — the `record` case does not exist, so the server falls through to `default` and starts an MCP stdio server instead of printing JSON.

- [ ] **Step 4: Add the subcommand**

In `src/server.ts`, inside the `switch (process.argv[2])` block, add this case after the existing `review-export` case and before `default`:

```ts
    case 'record': {
      // Payload arrives on stdin, not argv: it carries test bodies and heal diffs,
      // which are fragile to quote and would eventually exceed ARG_MAX.
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      try {
        console.log(JSON.stringify(store.record(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
      } catch (err) {
        // One JSON object on stdout either way, so the caller never parses stderr.
        console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        process.exitCode = 1;
      }
      break;
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/record-cli.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 6: Run the full suite and build**

Run: `npm test && npm run build`
Expected: all tests PASS (75 existing + 4 new = 79), `tsc` clean

- [ ] **Step 7: Commit**

```bash
cd /home/vipin-yadav/Desktop/MLProjects/qa-spine
git add src/server.ts tests/record-cli.test.ts
git commit -m "feat(cli): add a record subcommand so other languages can append"
```

---

### Task 2: QAAE spine client

**Files:**
- Create: `core/trace/__init__.py`, `core/trace/spine_client.py`
- Test: `tests/test_spine_client.py`

**Interfaces:**
- Consumes: the Task 1 CLI contract; `core.ai.providers.resolve(explicit=None, purpose="plan") -> {"provider", "model", ...}`.
- Produces, all used by Tasks 3-5:
  - `record(type: str, *, source_ref: str | None = None, content: dict | None = None, provenance: dict | None = None, links: list[dict] | None = None, timeout: float = 15.0) -> str | None`
  - `human_provenance() -> dict`
  - `ai_provenance(purpose: str, *, model: str | None = None, template_text: str | None = None, template_module: str | None = None, source_text: str | None = None) -> dict`
  - `enabled() -> bool`

- [ ] **Step 1: Create the branch**

```bash
cd /home/vipin-yadav/Desktop/MLProjects/QAAutomationAIEnabler
git checkout -b spine-integration
git status --porcelain | head -5   # the user's dirty files come along; leave them alone
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_spine_client.py`:

```python
"""Spine client: opt-in, non-fatal, and honest about provenance."""
import json
import subprocess

import pytest

import core.trace.spine_client as spine


class _Proc:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _enable(monkeypatch, tmp_path):
    """Make _server_js() resolve without needing a real qa-spine checkout."""
    server = tmp_path / "dist" / "server.js"
    server.parent.mkdir(parents=True, exist_ok=True)
    server.write_text("// stub", encoding="utf-8")
    monkeypatch.setenv("QA_SPINE_DIR", str(tmp_path))
    return server


def test_record_is_a_noop_when_dir_is_unset(monkeypatch):
    monkeypatch.delenv("QA_SPINE_DIR", raising=False)
    called = []
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: called.append(a))
    assert spine.record("requirement", content={"text": "x"},
                        provenance={"producer": "human"}) is None
    assert called == [], "must not spawn a subprocess when disabled"


def test_record_returns_the_artifact_id_on_success(monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        seen["payload"] = json.loads(kw["input"])
        return _Proc(0, json.dumps({"id": "requirement_1a2b"}))

    monkeypatch.setattr(subprocess, "run", fake_run)
    got = spine.record("requirement", source_ref="SCRUM-42",
                       content={"text": "x"}, provenance={"producer": "human"})
    assert got == "requirement_1a2b"
    assert seen["cmd"][0] == "node" and seen["cmd"][-1] == "record"
    assert seen["payload"]["sourceRef"] == "SCRUM-42"
    assert seen["payload"]["type"] == "requirement"


def test_record_returns_none_when_the_cli_rejects(monkeypatch, tmp_path, caplog):
    _enable(monkeypatch, tmp_path)
    monkeypatch.setattr(subprocess, "run",
                        lambda *a, **k: _Proc(1, json.dumps({"error": "boom"})))
    assert spine.record("test_case", content={}, provenance={"producer": "human"}) is None
    assert "boom" in caplog.text


def test_record_returns_none_on_timeout(monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)

    def blow_up(*a, **k):
        raise subprocess.TimeoutExpired(cmd="node", timeout=15.0)

    monkeypatch.setattr(subprocess, "run", blow_up)
    assert spine.record("test_run", content={}, provenance={"producer": "human"}) is None


def test_record_returns_none_on_unparseable_stdout(monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Proc(0, "not json"))
    assert spine.record("test_run", content={}, provenance={"producer": "human"}) is None


def test_human_provenance():
    assert spine.human_provenance() == {"producer": "human"}


def test_ai_provenance_carries_model_prompt_and_input(monkeypatch):
    p = spine.ai_provenance("fix", model="anthropic:claude-x",
                            template_text="PROMPT A", source_text="ticket text")
    assert p["producer"] == "ai"
    assert p["model"] == "anthropic:claude-x"
    assert p["promptVersion"].startswith("sha256:")
    assert p["inputDigest"].startswith("sha256:")


def test_ai_provenance_prompt_hash_tracks_the_template():
    same = spine.ai_provenance("fix", model="m", template_text="PROMPT A")
    again = spine.ai_provenance("fix", model="m", template_text="PROMPT A")
    changed = spine.ai_provenance("fix", model="m", template_text="PROMPT B")
    assert same["promptVersion"] == again["promptVersion"]
    assert changed["promptVersion"] != same["promptVersion"]


def test_ai_provenance_resolves_the_model_when_not_given(monkeypatch):
    import core.ai.providers as providers
    monkeypatch.setattr(providers, "resolve",
                        lambda explicit=None, purpose="plan": {"provider": "xai", "model": "grok-9"})
    p = spine.ai_provenance("plan", template_text="T")
    assert p["model"] == "grok-9"


def test_ai_provenance_never_raises_when_the_resolver_blows_up(monkeypatch):
    import core.ai.providers as providers

    def boom(**kw):
        raise RuntimeError("no credentials")

    monkeypatch.setattr(providers, "resolve", boom)
    p = spine.ai_provenance("plan", template_text="T")
    assert p["model"] == "unknown"
    assert p["promptVersion"].startswith("sha256:")
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `python -m pytest tests/test_spine_client.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'core.trace'`

- [ ] **Step 4: Write the implementation**

Create `core/trace/__init__.py` as an empty file.

Create `core/trace/spine_client.py`:

```python
"""Best-effort recorder that appends QA artifacts to the qa-spine trace ledger.

Opt-in through QA_SPINE_DIR and non-fatal by construction: a recording device
that can break the pipeline it records is worse than no recording device, so
every failure degrades to None plus a WARNING.

Named core/trace rather than core/spine because core/workitem/aggregator.py
already calls itself "the spine's Phase 1 read model" — one meaning per word
per package.
"""
from __future__ import annotations

import hashlib
import importlib
import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_UNKNOWN_DIGEST = "sha256:unknown"


def _server_js() -> Optional[Path]:
    """The qa-spine CLI entrypoint, or None when recording is switched off."""
    root = os.getenv("QA_SPINE_DIR")
    if not root:
        return None
    path = Path(root).expanduser() / "dist" / "server.js"
    return path if path.is_file() else None


def enabled() -> bool:
    return _server_js() is not None


def _sha(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:6]


def record(
    type: str,
    *,
    source_ref: Optional[str] = None,
    content: Optional[Dict[str, Any]] = None,
    provenance: Optional[Dict[str, Any]] = None,
    links: Optional[List[Dict[str, str]]] = None,
    timeout: float = 15.0,
) -> Optional[str]:
    """Append one artifact. Returns its id, or None if disabled or the write failed.

    ponytail: one Node process per artifact, ~100ms each, four per job. Irrelevant
    beside a heal cycle measured in minutes. If writes ever become hot, batch them
    or hold a persistent MCP session instead.
    """
    server = _server_js()
    if server is None:
        logger.debug("qa-spine recording disabled (QA_SPINE_DIR unset or dist/server.js missing)")
        return None

    payload: Dict[str, Any] = {
        "type": type,
        "content": content or {},
        "provenance": provenance or {"producer": "human"},
    }
    if source_ref:
        payload["sourceRef"] = source_ref
    if links:
        payload["links"] = links

    try:
        proc = subprocess.run(
            ["node", str(server), "record"],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        out = json.loads(proc.stdout or "{}")
    except Exception as exc:  # timeout, missing node, unparseable stdout — all the same to us
        logger.warning("qa-spine record failed (%s): %s", type, exc)
        return None

    if proc.returncode != 0 or "error" in out:
        logger.warning("qa-spine rejected %s: %s", type, out.get("error") or proc.stderr.strip())
        return None
    return out.get("id")


def human_provenance() -> Dict[str, Any]:
    """Anything not produced by a model. The enum has no 'tool', so a Playwright
    run and a deterministic locator swap both land here — see the spec's note."""
    return {"producer": "human"}


def _module_digest(dotted_name: str) -> str:
    """Hash of a module's source — the coarse fallback when an agent does not
    expose its prompt template.

    ponytail: changes on any edit to the file, comments included, so it produces
    spurious version splits. It errs safe: over-sensitivity costs a duplicate
    bucket, under-sensitivity would claim two different prompts were the same and
    silently corrupt the comparison the field exists for. Upgrade: have each agent
    expose its template and pass template_text.
    """
    try:
        module = importlib.import_module(dotted_name)
        return _sha(Path(module.__file__).read_text(encoding="utf-8"))
    except Exception:
        return _UNKNOWN_DIGEST


def ai_provenance(
    purpose: str,
    *,
    model: Optional[str] = None,
    template_text: Optional[str] = None,
    template_module: Optional[str] = None,
    source_text: Optional[str] = None,
) -> Dict[str, Any]:
    """Provenance for a model-produced artifact.

    `model` wins when given — a value captured at the call that produced the
    artifact beats one resolved afterwards, which is why the heal path passes
    heal["model_used"].

    ponytail: without it, the model is resolved at record time, so a config change
    mid-job records the wrong one. Upgrade: have each agent return the model it
    used, as usage.record_langchain already extracts it from the response.
    """
    if not model:
        try:
            from core.ai import providers
            model = providers.resolve(purpose=purpose)["model"]
        except Exception as exc:
            logger.warning("qa-spine could not resolve the model for %s: %s", purpose, exc)
            model = "unknown"

    if template_text is not None:
        prompt_version = _sha(template_text)
    elif template_module:
        prompt_version = _module_digest(template_module)
    else:
        prompt_version = _UNKNOWN_DIGEST

    provenance: Dict[str, Any] = {
        "producer": "ai",
        "model": str(model),
        "promptVersion": prompt_version,
    }
    if source_text:
        provenance["inputDigest"] = _sha(source_text)
    return provenance
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_spine_client.py -q`
Expected: PASS, 10 tests

- [ ] **Step 6: Commit — exact paths only**

```bash
cd /home/vipin-yadav/Desktop/MLProjects/QAAutomationAIEnabler
git add core/trace/__init__.py core/trace/spine_client.py tests/test_spine_client.py
git commit -m "feat(trace): add a best-effort qa-spine client"
```

Verify you did not sweep the user's work in: `git show --stat HEAD` must list exactly three files.

---

### Task 3: Instrument the two creation seams

**Files:**
- Modify: `core/orchestration/loop_a.py` — imports, `start_from_ticket` (line 38), `attach_bdd_result` (line 182)
- Test: `tests/test_spine_instrumentation.py` (create)

**Interfaces:**
- Consumes: `spine.record`, `spine.human_provenance`, `spine.ai_provenance` from Task 2; existing `advance(job, stage, *, note="", **fields)` which persists arbitrary keys onto the job; existing `_feature_for_job(job) -> str | None`.
- Produces, relied on by Task 4: job keys `spine_requirement_id`, `spine_test_case_id`, `spine_disabled`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_spine_instrumentation.py`:

```python
"""The four Loop A seams append to the trace ledger without changing behaviour."""
import core.orchestration.loop_a as loop_a


class _Spy:
    """Stands in for spine.record, capturing every call."""

    def __init__(self, ids=None):
        self.calls = []
        self._ids = list(ids or [])

    def __call__(self, type, *, source_ref=None, content=None, provenance=None, links=None, **kw):
        self.calls.append({"type": type, "source_ref": source_ref,
                           "content": content, "provenance": provenance, "links": links})
        return self._ids.pop(0) if self._ids else f"{type}_stub"

    def of_type(self, type):
        return [c for c in self.calls if c["type"] == type]


def _patch_spine(monkeypatch, spy):
    monkeypatch.setattr(loop_a.spine, "record", spy)


def test_attach_bdd_result_records_a_test_case_covering_the_requirement(monkeypatch):
    spy = _Spy(ids=["test_case_aaa"])
    _patch_spine(monkeypatch, spy)

    job = {"id": "job_1", "ticket_key": "SCRUM-42", "spine_requirement_id": "requirement_zzz"}
    monkeypatch.setattr(loop_a, "get_job", lambda jid: job)
    monkeypatch.setattr(loop_a, "advance", lambda j, stage, **kw: j.update(kw) or j)
    monkeypatch.setattr(loop_a, "_feature_for_job", lambda j: "features/login.feature")

    loop_a.attach_bdd_result(
        "job_1", scenario_name="user logs in",
        bdd_paths={"feature": "features/login.feature"}, success=True,
    )

    cases = spy.of_type("test_case")
    assert len(cases) == 1
    assert cases[0]["source_ref"] == "features/login.feature"
    assert cases[0]["provenance"]["producer"] == "ai"
    assert {"to": "requirement_zzz", "relation": "covers"} in cases[0]["links"]
    assert job["spine_test_case_id"] == "test_case_aaa"


def test_attach_bdd_result_records_nothing_when_generation_failed(monkeypatch):
    spy = _Spy()
    _patch_spine(monkeypatch, spy)
    job = {"id": "job_1"}
    monkeypatch.setattr(loop_a, "get_job", lambda jid: job)
    monkeypatch.setattr(loop_a, "fail_job", lambda j, err: {"success": False})

    loop_a.attach_bdd_result("job_1", scenario_name="x", bdd_paths={}, success=False, error="nope")
    assert spy.calls == []


def test_a_failed_record_disables_the_job(monkeypatch):
    """A chain missing its middle is worse than no chain."""
    def dead(*a, **kw):
        return None

    monkeypatch.setattr(loop_a.spine, "record", dead)
    job = {"id": "job_1", "spine_requirement_id": "requirement_zzz"}
    monkeypatch.setattr(loop_a, "get_job", lambda jid: job)
    monkeypatch.setattr(loop_a, "advance", lambda j, stage, **kw: j.update(kw) or j)
    monkeypatch.setattr(loop_a, "_feature_for_job", lambda j: "features/x.feature")

    loop_a.attach_bdd_result("job_1", scenario_name="x",
                             bdd_paths={"feature": "features/x.feature"}, success=True)
    assert job.get("spine_disabled") is True


def test_disabled_job_records_nothing_further(monkeypatch):
    spy = _Spy()
    _patch_spine(monkeypatch, spy)
    job = {"id": "job_1", "spine_disabled": True}
    monkeypatch.setattr(loop_a, "get_job", lambda jid: job)
    monkeypatch.setattr(loop_a, "advance", lambda j, stage, **kw: j.update(kw) or j)
    monkeypatch.setattr(loop_a, "_feature_for_job", lambda j: "features/x.feature")

    loop_a.attach_bdd_result("job_1", scenario_name="x",
                             bdd_paths={"feature": "features/x.feature"}, success=True)
    assert spy.calls == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_spine_instrumentation.py -q`
Expected: FAIL — `AttributeError: module 'core.orchestration.loop_a' has no attribute 'spine'`

- [ ] **Step 3: Add the import and the shared guard**

At the top of `core/orchestration/loop_a.py`, with the other `core.` imports:

```python
from core.trace import spine_client as spine
```

Then add this helper immediately above `def attach_bdd_result(` (line 182):

```python
def _spine_record(job: Dict[str, Any], type: str, **kwargs: Any) -> Optional[str]:
    """Append one artifact for this job, and stop recording for the job if it fails.

    A chain missing its middle is worse than no chain: a test_run verifying nothing,
    or a heal superseding an artifact that was never written, reads as a real gap in
    the history rather than as a recording failure.

    ponytail: spine_disabled is per job and never resets, so one transient failure
    stops recording for the rest of that job. Deliberate — a complete chain or none.
    """
    if job.get("spine_disabled"):
        return None
    artifact_id = spine.record(type, **kwargs)
    if artifact_id is None and spine.enabled():
        job["spine_disabled"] = True
    return artifact_id
```

- [ ] **Step 4: Instrument `start_from_ticket`**

In `start_from_ticket`, replace the `advance(...)` call at line 126-131 with:

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

    advance(
        job,
        JobStage.AWAITING_RECORDING,
        note="Recording plan ready — open the recorder and perform the steps",
        plan=plan_dict,
        spine_requirement_id=requirement_id,
    )
```

A ticket with neither description nor summary records an empty `text`. The store accepts it and `audit_requirement` would later reject it, which is the correct signal rather than a silent skip.

- [ ] **Step 5: Instrument `attach_bdd_result`**

Replace the body of `attach_bdd_result` after the `if not success:` guard with:

```python
    feature = _feature_for_job({**job, "bdd_paths": bdd_paths, "scenario_name": scenario_name})
    links = []
    if job.get("spine_requirement_id"):
        links.append({"to": job["spine_requirement_id"], "relation": "covers"})
    test_case_id = _spine_record(
        job,
        "test_case",
        source_ref=feature,
        content={"scenario_name": scenario_name, "paths": bdd_paths},
        provenance=spine.ai_provenance(
            "plan", template_module="core.agents.playwright_generator_agent"
        ),
        links=links,
    )

    advance(
        job,
        JobStage.GENERATED,
        note=f"BDD generated: {scenario_name}",
        scenario_name=scenario_name,
        bdd_paths=bdd_paths,
        spine_test_case_id=test_case_id,
    )
    return {"success": True, "job": job}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `python -m pytest tests/test_spine_instrumentation.py -q`
Expected: PASS, 4 tests

- [ ] **Step 7: Confirm nothing else broke**

Run: `python -m pytest tests/test_orchestration_loops.py tests/test_loop_a_zephyr.py tests/test_workitem_aggregator.py -q`
Expected: PASS — the existing Loop A tests must be unaffected, since no behaviour changed.

- [ ] **Step 8: Commit — exact paths only**

```bash
cd /home/vipin-yadav/Desktop/MLProjects/QAAutomationAIEnabler
git add core/orchestration/loop_a.py tests/test_spine_instrumentation.py
git commit -m "feat(trace): record the requirement and the generated test case"
```

Verify with `git show --stat HEAD` — exactly two files.

---

### Task 4: Instrument the two result seams

**Files:**
- Modify: `core/orchestration/loop_a.py` — `attach_run_result` (line 205), `attach_heal_result` (line 250)
- Test: `tests/test_spine_instrumentation.py` (append)

**Interfaces:**
- Consumes: `_spine_record(job, type, **kwargs)` and the job keys `spine_requirement_id` / `spine_test_case_id` / `spine_disabled` from Task 3; `spine.ai_provenance`, `spine.human_provenance`.
- Produces: nothing new; updates `spine_test_case_id` on a successful heal.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_spine_instrumentation.py`:

```python
def _run_job(monkeypatch, spy, job):
    _patch_spine(monkeypatch, spy)
    monkeypatch.setattr(loop_a, "get_job", lambda jid: job)
    monkeypatch.setattr(loop_a, "advance", lambda j, stage, **kw: j.update(kw) or j)
    monkeypatch.setattr(loop_a, "_feature_for_job", lambda j: "features/login.feature")


def test_attach_run_result_records_a_run_verifying_the_test_case(monkeypatch):
    spy = _Spy()
    job = {"id": "job_1", "spine_test_case_id": "test_case_aaa"}
    _run_job(monkeypatch, spy, job)

    loop_a.attach_run_result("job_1", run_id="ci/run/1", status="completed",
                             summary={"total": 3}, failed=0)

    runs = spy.of_type("test_run")
    assert len(runs) == 1
    assert runs[0]["source_ref"] == "ci/run/1"
    assert runs[0]["provenance"] == {"producer": "human"}
    assert runs[0]["content"]["run_passed"] is True
    assert {"to": "test_case_aaa", "relation": "verifies"} in runs[0]["links"]


def test_attach_run_result_ignores_progress_ticks(monkeypatch):
    """running/queued is a progress tick, not a result — recording it would fill
    the ledger with rows that mean nothing."""
    spy = _Spy()
    job = {"id": "job_1", "spine_test_case_id": "test_case_aaa"}
    _run_job(monkeypatch, spy, job)

    loop_a.attach_run_result("job_1", run_id="ci/run/1", status="running")
    loop_a.attach_run_result("job_1", run_id="ci/run/1", status="queued")
    assert spy.calls == []


def test_attach_heal_result_supersedes_the_previous_test_case(monkeypatch):
    spy = _Spy(ids=["test_case_bbb"])
    job = {"id": "job_1", "spine_requirement_id": "requirement_zzz",
           "spine_test_case_id": "test_case_aaa"}
    _run_job(monkeypatch, spy, job)

    loop_a.attach_heal_result("job_1", {
        "success": True, "verified": True,
        "changed_files": ["tests/login.locators.ts"],
        "summary": "loginBtn: getByText → getByTestId",
        "strategy_used": "data-testid",
        "model_used": "anthropic:claude-x",
    })

    cases = spy.of_type("test_case")
    assert len(cases) == 1
    # sourceRef stays on the feature, NOT changed_files — a supersedes chain whose
    # ref changes between versions does not read as one test's history.
    assert cases[0]["source_ref"] == "features/login.feature"
    assert cases[0]["content"]["changed_files"] == ["tests/login.locators.ts"]
    assert cases[0]["provenance"]["producer"] == "ai"
    assert cases[0]["provenance"]["model"] == "anthropic:claude-x"
    assert {"to": "test_case_aaa", "relation": "supersedes"} in cases[0]["links"]
    assert {"to": "requirement_zzz", "relation": "covers"} in cases[0]["links"]
    assert job["spine_test_case_id"] == "test_case_bbb"


def test_a_deterministic_heal_is_not_recorded_as_ai(monkeypatch):
    """Classes 1 and 2 in heal_failure use no model and carry no model_used.
    Recording them as AI would be false, and the store would reject them anyway."""
    spy = _Spy()
    job = {"id": "job_1", "spine_test_case_id": "test_case_aaa"}
    _run_job(monkeypatch, spy, job)

    loop_a.attach_heal_result("job_1", {
        "success": True, "verified": True,
        "changed_files": ["tests/login.locators.ts"],
        "summary": "removed premature wait",
        "strategy_used": "wait-order",
    })

    cases = spy.of_type("test_case")
    assert len(cases) == 1
    assert cases[0]["provenance"] == {"producer": "human"}


def test_a_failed_heal_records_nothing(monkeypatch):
    spy = _Spy()
    job = {"id": "job_1", "spine_test_case_id": "test_case_aaa"}
    _run_job(monkeypatch, spy, job)

    loop_a.attach_heal_result("job_1", {"success": False, "reason": "app unreachable"})
    assert spy.calls == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_spine_instrumentation.py -q`
Expected: FAIL — the four new tests fail because `attach_run_result` and `attach_heal_result` record nothing yet.

- [ ] **Step 3: Instrument `attach_run_result`**

In `attach_run_result`, insert immediately before the existing `advance(` call:

```python
    # Terminal statuses only. running/queued is a progress tick, not a result.
    if status not in ("running", "queued"):
        links = []
        if job.get("spine_test_case_id"):
            links.append({"to": job["spine_test_case_id"], "relation": "verifies"})
        _spine_record(
            job,
            "test_run",
            source_ref=run_id,
            content={"status": status, "run_passed": run_passed,
                     "summary": summary or {}, "failed": failed},
            provenance=spine.human_provenance(),
            links=links,
        )
```

- [ ] **Step 4: Instrument `attach_heal_result`**

Replace the `if heal.get("success"):` branch of `attach_heal_result` with:

```python
    if heal.get("success"):
        # Only the diagnose_failure path involves a model; the locator swap and the
        # premature-wait removal are deterministic and carry no model_used.
        provenance = (
            spine.ai_provenance("fix", model=heal["model_used"],
                                template_module="core.execution.failure_analyzer",
                                source_text=heal.get("summary"))
            if heal.get("model_used")
            else spine.human_provenance()
        )
        links = []
        if job.get("spine_test_case_id"):
            links.append({"to": job["spine_test_case_id"], "relation": "supersedes"})
        if job.get("spine_requirement_id"):
            links.append({"to": job["spine_requirement_id"], "relation": "covers"})
        healed_id = _spine_record(
            job,
            "test_case",
            # The feature is the canonical artifact; the edited locators/steps file
            # goes in content, so the supersedes chain stays on one ref.
            source_ref=_feature_for_job(job),
            content={"summary": heal.get("summary"),
                     "changed_files": heal.get("changed_files") or [],
                     "strategy_used": heal.get("strategy_used"),
                     "diff": heal.get("diff")},
            provenance=provenance,
            links=links,
        )
        advance(
            job,
            JobStage.GENERATED,
            note=heal.get("summary") or "Heal applied",
            heal_summary=heal,
            spine_test_case_id=healed_id or job.get("spine_test_case_id"),
        )
```

Leave the `else:` branch exactly as it is — a failed heal produced no new test.

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_spine_instrumentation.py -q`
Expected: PASS, 9 tests

- [ ] **Step 6: Confirm nothing else broke**

Run: `python -m pytest tests/test_orchestration_loops.py tests/test_loop_a_zephyr.py tests/test_healing_ladder.py -q`
Expected: PASS

- [ ] **Step 7: Commit — exact paths only**

```bash
cd /home/vipin-yadav/Desktop/MLProjects/QAAutomationAIEnabler
git add core/orchestration/loop_a.py tests/test_spine_instrumentation.py
git commit -m "feat(trace): record runs and heals, superseding the test they replace"
```

---

### Task 5: The demo and the docs pointer

**Files:**
- Create: `scripts/spine_demo.py`
- Create: `docs/superpowers/specs/2026-07-31-spine-integration-design.md`
- Test: `tests/test_spine_instrumentation.py` (append one skipped-by-default test)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: a runnable demo.

- [ ] **Step 1: Write the end-to-end test**

Append to `tests/test_spine_instrumentation.py`:

```python
import json
import os
import subprocess
import pytest


@pytest.mark.skipif(not os.getenv("QA_SPINE_DIR"),
                    reason="needs a built qa-spine checkout at QA_SPINE_DIR")
def test_end_to_end_chain_lands_in_a_real_store(tmp_path, monkeypatch):
    """Shells out for real. Skips rather than fails so the suite stays green on a
    machine with no Node."""
    import core.trace.spine_client as spine

    db = tmp_path / "trace.db"
    monkeypatch.setenv("QA_SPINE_DB", str(db))

    req = spine.record("requirement", source_ref="SCRUM-42",
                       content={"text": "Refunds must be processed quickly."},
                       provenance=spine.human_provenance())
    assert req and req.startswith("requirement_")

    case = spine.record("test_case", source_ref="features/refund.feature",
                        content={"scenario_name": "refund completes"},
                        provenance=spine.ai_provenance("plan", model="grok-9",
                                                       template_text="T"),
                        links=[{"to": req, "relation": "covers"}])
    assert case and case.startswith("test_case_")

    run = spine.record("test_run", source_ref="ci/run/1",
                       content={"status": "failed"},
                       provenance=spine.human_provenance(),
                       links=[{"to": case, "relation": "verifies"}])
    assert run and run.startswith("test_run_")

    server = os.path.join(os.environ["QA_SPINE_DIR"], "dist", "server.js")
    out = subprocess.run(["node", server, "review-export"], capture_output=True,
                         text=True, env={**os.environ, "QA_SPINE_DB": str(db)})
    assert out.returncode == 0
```

- [ ] **Step 2: Run it to confirm it skips cleanly**

Run: `python -m pytest tests/test_spine_instrumentation.py -q`
Expected: 9 passed, 1 skipped (assuming `QA_SPINE_DIR` is unset in your shell)

- [ ] **Step 3: Write the demo script**

Create `scripts/spine_demo.py`:

```python
#!/usr/bin/env python
"""Drive one synthetic Loop A job into the trace ledger — no Jira, no browser, no LLM.

    QA_SPINE_DIR=../qa-spine QA_SPINE_DB=/tmp/demo-spine.db python scripts/spine_demo.py

Then, in the qa-spine checkout:

    QA_SPINE_DB=/tmp/demo-spine.db npm run inspect

The chain view shows requirement -> test_case v1 -> failed run, and test_case v2
superseding v1 with a passing run, with the AI artifacts in the AI colour.
"""
import os
import sys

import core.trace.spine_client as spine


def main() -> int:
    if not spine.enabled():
        print("QA_SPINE_DIR is unset or dist/server.js is missing — nothing to record.",
              file=sys.stderr)
        print("Build qa-spine first:  cd ../qa-spine && npm run build", file=sys.stderr)
        return 1

    print(f"recording into {os.getenv('QA_SPINE_DB', '.qa-spine/trace.db')}")

    requirement = spine.record(
        "requirement",
        source_ref="SCRUM-42",
        content={"text": "Refunds must be processed quickly and the customer notified.",
                 "summary": "Refund flow", "issue_type": "Story"},
        provenance=spine.human_provenance(),
    )
    print(f"  requirement  {requirement}")

    v1 = spine.record(
        "test_case",
        source_ref="features/refund.feature",
        content={"scenario_name": "refund completes and emails the customer"},
        provenance=spine.ai_provenance("plan", model="grok-4", template_text="GENERATOR PROMPT v1"),
        links=[{"to": requirement, "relation": "covers"}],
    )
    print(f"  test_case v1 {v1}")

    run1 = spine.record(
        "test_run",
        source_ref="ci/run/8812",
        content={"status": "failed", "run_passed": False,
                 "summary": {"total": 1, "failed": 1},
                 "message": "timed out waiting for notification"},
        provenance=spine.human_provenance(),
        links=[{"to": v1, "relation": "verifies"}],
    )
    print(f"  test_run     {run1}  FAILED")

    v2 = spine.record(
        "test_case",
        source_ref="features/refund.feature",
        content={"summary": "notifyBanner: getByText → getByTestId",
                 "changed_files": ["tests/refund.locators.ts"],
                 "strategy_used": "data-testid"},
        provenance=spine.ai_provenance("fix", model="anthropic:claude-x",
                                       template_text="HEALER PROMPT v1"),
        links=[{"to": v1, "relation": "supersedes"},
               {"to": requirement, "relation": "covers"}],
    )
    print(f"  test_case v2 {v2}  supersedes v1")

    run2 = spine.record(
        "test_run",
        source_ref="ci/run/8813",
        content={"status": "completed", "run_passed": True, "summary": {"total": 1, "failed": 0}},
        provenance=spine.human_provenance(),
        links=[{"to": v2, "relation": "verifies"}],
    )
    print(f"  test_run     {run2}  PASSED")

    if not all([requirement, v1, run1, v2, run2]):
        print("\nsome writes failed — check the warnings above", file=sys.stderr)
        return 1

    print(f"\nNow run, in the qa-spine checkout:\n"
          f"  QA_SPINE_DB={os.getenv('QA_SPINE_DB', '.qa-spine/trace.db')} npm run inspect")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the demo for real**

```bash
cd /home/vipin-yadav/Desktop/MLProjects/qa-spine && npm run build
cd /home/vipin-yadav/Desktop/MLProjects/QAAutomationAIEnabler
QA_SPINE_DIR=../qa-spine QA_SPINE_DB=/tmp/demo-spine.db python scripts/spine_demo.py
```

Expected: five artifact ids printed, exit 0.

Then confirm the chain is real:

```bash
cd /home/vipin-yadav/Desktop/MLProjects/qa-spine
QA_SPINE_DB=/tmp/demo-spine.db node -e "
const { TraceStore } = await import('./src/trace/store.ts');
const s = new TraceStore('/tmp/demo-spine.db');
console.log(s.list(undefined, 100).map(a => a.type + ' ' + a.id + ' ' + a.provenance.producer).join('\n'));
"
```

Expected: five artifacts, two of them `ai`.

- [ ] **Step 5: Run the e2e test against the real spine**

```bash
cd /home/vipin-yadav/Desktop/MLProjects/QAAutomationAIEnabler
QA_SPINE_DIR=../qa-spine python -m pytest tests/test_spine_instrumentation.py -q
```

Expected: 10 passed, 0 skipped.

- [ ] **Step 6: Write the docs pointer**

Create `docs/superpowers/specs/2026-07-31-spine-integration-design.md` in QAAE:

```markdown
# Spine integration — pointer

The design for recording Loop A into the qa-spine trace ledger lives in the
qa-spine repo, because that is where it was written and where the other half of
the implementation sits:

    ../qa-spine/docs/superpowers/specs/2026-07-31-spine-integration-design.md

Summary: `core/trace/spine_client.py` shells out to qa-spine's `record`
subcommand. Four write points in `core/orchestration/loop_a.py` — at
`start_from_ticket`, `attach_bdd_result`, `attach_run_result` and
`attach_heal_result` — append a requirement, a test case, each run, and each
heal, the last superseding the test case it replaces.

Recording is opt-in through `QA_SPINE_DIR` and can never raise: every failure
degrades to `None` and a WARNING. Nothing in Loop A's behaviour changes.

Demo: `scripts/spine_demo.py`.
```

- [ ] **Step 7: Commit — exact paths only**

```bash
cd /home/vipin-yadav/Desktop/MLProjects/QAAutomationAIEnabler
git add scripts/spine_demo.py tests/test_spine_instrumentation.py \
        docs/superpowers/specs/2026-07-31-spine-integration-design.md
git commit -m "feat(trace): add the spine demo and an end-to-end check"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| `record` subcommand, stdin, one JSON object out, exit 1 on failure | 1 |
| `QA_SPINE_DIR` gate, never raises | 2 |
| `record()` / `human_provenance()` / `ai_provenance()` / `enabled()` | 2 |
| `model` override, resolver fallback, `unknown` on failure | 2 |
| `promptVersion` from template hash, module-source fallback | 2 |
| `inputDigest` | 2 |
| Write point 1 — requirement, `spine_requirement_id` | 3 |
| Write point 2 — test_case, `covers`, `spine_test_case_id` | 3 |
| `spine_disabled` guard | 3 |
| Write point 3 — test_run, `verifies`, terminal statuses only | 4 |
| Write point 4 — healed test_case, `supersedes` + `covers` | 4 |
| Conditional heal provenance on `model_used` | 4 |
| `sourceRef` stays on the feature, not `changed_files` | 4 |
| Failed heal records nothing | 4 |
| Demo path with both env vars | 5 |
| Docs pointer in QAAE | 5 |
| 17 spec tests | 1 (4), 2 (10), 3 (4), 4 (5), 5 (1) = 24 |
| 5 `ponytail:` ceilings | 2 (×3), 3 (×1) |

**Placeholder scan:** none — every step carries runnable code or an exact command.

**Type consistency:** `_spine_record(job, type, **kwargs)` is defined in Task 3 and used in Task 4 with the same signature. `spine.record`'s keyword names (`source_ref`, `content`, `provenance`, `links`) are identical in Task 2's definition, Task 3's and Task 4's call sites, and the `_Spy` stub's signature. Job keys `spine_requirement_id` / `spine_test_case_id` / `spine_disabled` are spelled identically in Tasks 3, 4 and their tests.

**Deviation from the spec, deliberate:** the spec lists 17 tests; this plan has 24. The extras cover `enabled()`, the resolver blowing up, unparseable stdout, progress-tick suppression, and the disabled-job guard — all behaviours the spec describes in prose without naming a test.

**One thing the plan does NOT do:** `ai_provenance` for the generated test case uses `template_module="core.agents.playwright_generator_agent"` rather than the real prompt template, because `attach_bdd_result` does not receive one. That is the module-source fallback the spec sanctions, and its `ponytail:` comment names the upgrade.
