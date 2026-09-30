# Publishing qa-spine 0.2.0

**Date:** 2026-09-30. `main` holds the whole roadmap plus release prep; 339/339 tests pass.

## Already done and verified

- `package.json` is at `0.2.0`, with repository links; the CLI reads its version from it.
- `CHANGELOG.md`, checked against the published 0.1.0 tarball (which had no gate, `init`,
  `demo` or Action — those are new in 0.2.0).
- The tarball `npm pack` produces was installed into an empty directory and exercised:
  `record`, `ingest-junit`, `gate` (blocked, exit 1), `verify`, `rubric-report`,
  `fixtures-request`, and an MCP client over stdio (11 tools, the rubric resource, the
  `audit-ticket` prompt, version 0.2.0).
- npm: `qa-spine` is yours (0.1.0 published 2026-08-06), and this machine is logged in as `ydvvipin`.

## Blockers found

- **No git remote**, and `gh` is not logged in. `github.com/YdvVipin/qa-spine` returns 404:
  missing, or private.
- **Order matters.** The Action runs `npx qa-spine@latest verify` first. npm's `latest` is
  0.1.0, which has no `verify`, so pushing the `v1` tag before publishing 0.2.0 breaks every
  workflow using the Action. **npm first, then the tag.**

## Steps

Steps 1, 2 and 4 need you: a login, publishing code, and an OTP.

1. **Log in to GitHub**
   ```bash
   gh auth login
   ```

2. **Create the repository and push `main`.** It must be public for other repositories to
   use the Action.
   ```bash
   gh repo create YdvVipin/qa-spine --public --source . --remote origin --push \
     --description "QA-lifecycle MCP server over a traceability spine"
   ```
   If it already exists privately: `git remote add origin git@github.com:YdvVipin/qa-spine.git`,
   make it public in its settings, then `git push -u origin main`.

3. **Check the tree is clean and green** (`prepublishOnly` also runs tests and the build).
   ```bash
   git status --short && npm test && npm pack --dry-run
   ```

4. **Publish to npm** — with the one-time password from your authenticator:
   ```bash
   npm publish --otp=<code>
   npm view qa-spine version          # expect 0.2.0
   npx --yes qa-spine@latest --version
   ```

5. **Tag the release and the Action's major version, then push both**
   ```bash
   git tag -a v0.2.0 -m "qa-spine 0.2.0"
   git tag v1                          # the Action's major tag; move it for later 0.x releases
   git push origin v0.2.0 v1
   ```

6. **GitHub release** from the changelog section
   ```bash
   awk '/^## 0.2.0/{f=1;next}/^## /{f=0}f' CHANGELOG.md > /tmp/notes.md
   gh release create v0.2.0 --title "qa-spine 0.2.0" --notes-file /tmp/notes.md
   ```

7. **Smoke-test the Action** in a scratch repository: copy `examples/github-workflow.yml`,
   commit a store made with `npx qa-spine demo`'s shape (a requirement for `PROJ-42` with an
   open question), open a pull request titled `PROJ-42 …`, and expect a red check with a
   comment listing the question and the `qa-spine answer` command.

## Recommended, not blocking

- **Pin the Action's default npm version.** `action.yml` defaults `version` to `latest`, so a
  future 0.3.0 with a behaviour change would reach every `@v1` workflow unannounced. Defaulting
  to `^0.2.0` would keep `v1` on 0.2.x until the tag is moved deliberately.
- **npm provenance.** Publishing from a GitHub Actions workflow with `npm publish --provenance`
  links the package to the commit that built it — in keeping with what qa-spine is for.
- **Tell QAAE users** (and update QAAE) that an audit which finds nothing should now call
  `audit-submit` with an empty list, or edited tickets stay suspect.
- Delete the merged local branches once the release is out: `delivery-integration`,
  `junit-results`, `ledger-integrity`, `requirement-versions`, `faster-answers`,
  `rubric-measurement`, `coverage-reports`, `team-features`, `fixtures`, `phase-2-5-audit-queue`.
