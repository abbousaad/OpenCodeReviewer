# OpenCodeReviewer

A containerized AI code reviewer powered by [OpenCode](https://opencode.ai).
Use it with any CI system or locally. It accepts Git revisions from any Git
host, or a unified text diff from another version control system.

1. **CI mode** — review the changed code between two Git revisions or in a
   supplied unified diff. Writes a report and **fails the pipeline** (non-zero
   exit) when findings meet or exceed the severity gate.
2. **Standalone mode** — run the image on its own to review a **whole codebase**. It
   splits the source into small **batches** and reviews each, with a **web dashboard**
   to trigger reviews and browse findings.

Both modes read `BUSINESS_LOGIC.md` from the supplied directory. Use it to
describe rules the code must enforce, including who can
read or change records, valid state transitions, and expected edge cases.
For example, a todo app could specify that only the owner can read a todo and
that requests by other users return HTTP 404. See this repository's
[`BUSINESS_LOGIC.md`](./BUSINESS_LOGIC.md) for a sample structure.

The reviewer also reads the first available project context file, typically
`REVIEW_CONTEXT.md` or `ARCHITECTURE.md`. Each review prompt includes the files
it finds. If neither business rules nor project context are available, the
reviewer emits a warning. See
[`REVIEW_CONTEXT.template.md`](./REVIEW_CONTEXT.template.md) for architecture
and conventions.

Every CI diff and dashboard batch includes the reviewer image's
[OWASP Web Top 10 2025 skill](./skills/owasp-web-review/SKILL.md) and
[OWASP API Security Top 10 2023 skill](./skills/owasp-api-review/SKILL.md).
The reviewer loads them before calling OpenCode. If either skill is missing or
unreadable, the batch fails. The skills ask for evidence tied to the code in
scope and direct the model to record checks it could not verify in the batch
summary.

> **Model:** DeepSeek via OpenCode. Set `DEEPSEEK_API_KEY` at runtime. Reviews
> send the selected source or diff and project context to the configured model
> provider. The provider is
> configured in [`opencode.json`](./opencode.json); defaults live in
> [`review.config.json`](./review.config.json).

---

## Architecture

```
┌─────────────────────────── Docker image ───────────────────────────┐
│  opencode run  ◄────────────────────────  JS wrapper                │
│  (DeepSeek)                               ├── src/cli.js    (CI mode) │
│                                           └── src/server.js (dashboard)│
│                                                                      │
│  core/  Git refs or unified diff → reviewer → report (CI)           │
│         batcher    → jobs → reviewer → report   (standalone, SSE)    │
└──────────────────────────────────────────────────────────────────────┘
```

Each diff unit or source batch invokes `opencode run` with the selected model
and uses `--standalone` when the installed CLI supports it. Reviews return
**structured JSON findings**
(`file, line, severity, category, message, suggestion`) which are aggregated into
`review-report.md` + `review-report.json`.

The dashboard and reports sum input tokens (including cache reads and writes),
output tokens (including reasoning), and the estimated USD cost from OpenCode.
Totals use the usage records OpenCode emits. Missing records or pricing are
marked as unavailable or partial. Provider billing can differ from the estimate.

---

## Build

```bash
docker build -t opencodereviewer .
```

## Standalone mode (dashboard)

```bash
export REVIEW_PASSWORD="$(openssl rand -hex 16)"
docker run --rm -p 127.0.0.1:3000:3000 \
  -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  -e REVIEW_PASSWORD \
  -v "$PWD":/repo:ro \
  opencodereviewer
```

Open http://127.0.0.1:3000 and sign in as `review` using `REVIEW_PASSWORD`.
The dashboard defaults to `/repo` in Docker and accepts directories within that
mount. It streams batch progress and lets you download the report. Start with a
small repo. Files and diffs over the configured size limits are split into
several batches: files by line range, diffs by hunk. Only a single line longer
than the limit, such as minified code, is clipped, and the report lists the
affected files.

## CI mode (one-shot, exit-code gate)

```bash
docker run --rm \
  -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  -v "$PWD":/repo -w /repo \
  opencodereviewer opencodereviewer ci /repo
```

Exits `0` for a completed review that passes the severity gate and `1` when a
finding meets or exceeds the gate (default `major`). Exits `3` for invalid
configuration, other fatal errors, or an incomplete review. CI writes reports
to the repo directory by default, including partial results when a batch fails.
Set `REPORT_DIR` to change the output directory.

### Explicit Git revisions

Use this from any Git host or CI runner with a checkout containing both
revisions and, for `--merge-base`, their common history. Use full commit
SHAs in CI to keep the reviewed range stable.

```bash
opencodereviewer ci /repo --base "$BASE_SHA" --head "$HEAD_SHA" --merge-base
```

Use `--merge-base` for a pull or merge request to review changes since the
common ancestor. Omit it to compare the two revisions directly, for example
before and after a push. `--head` defaults to `HEAD`. For an explicit direct
comparison, callers can also set `REVIEW_BASE_REF` and `REVIEW_HEAD_REF`.
Explicit refs take precedence over CI environment detection. Code is taken
from the selected commits. Project context is read from the supplied directory.

### Unified diff from any version control system

Export a UTF-8 unified text diff with repository-relative paths and pass it
to the same CLI. The supplied directory can be an exported source tree or
a directory containing only your trusted context files.

```bash
opencodereviewer ci /repo --diff /inputs/change.patch
```

This works without Git metadata or a connection to the hosting service.
Binary patches and changes containing only metadata are outside the text
review scope. Generate a text diff with content hunks. The CLI uses the same
filters, report formats and severity gate for both inputs. The caller handles
checkout, publishing reports and posting any comments through its own CI or
hosting service.

### Automatic Git scope

When no explicit input is supplied, the first available trigger wins:

| Trigger | Environment variables | Diff range |
| --- | --- | --- |
| Pull or merge request | `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, `GITHUB_BASE_REF`, `GITEA_BASE_REF`, `BASE_REF` | `base...HEAD` |
| Branch push | `CI_COMMIT_BEFORE_SHA` | `before..HEAD` |
| Single commit | `REVIEW_COMMIT`, `CI_COMMIT_SHA` | `sha^..sha` |
| Fallback | None | Last commit on the checkout |

### GitLab CI (`.gitlab-ci.yml`)

```yaml
ai_code_review:
  stage: test
  image: opencodereviewer:latest
  variables:
    GIT_DEPTH: "0"            # full history so diffs resolve
    SEVERITY_GATE: "major"
  script:
    - opencodereviewer ci "$CI_PROJECT_DIR"
  artifacts:
    when: always
    paths:
      - review-report.md
      - review-report.json
  # DEEPSEEK_API_KEY provided as a masked CI/CD variable
```

### Gitea Actions (`.gitea/workflows/review.yml`)

```yaml
name: AI Code Review
on: [pull_request]
jobs:
  review:
    runs-on: ubuntu-latest
    container:
      image: opencodereviewer:latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: opencodereviewer ci "$GITHUB_WORKSPACE"
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          GITHUB_BASE_REF: ${{ github.base_ref }}
          SEVERITY_GATE: major
```

---

## Configuration (`review.config.json`)

| Key                   | Meaning                                                      |
| --------------------- | ----------------------------------------------------------- |
| `model`               | OpenCode `provider/model` (env `OC_MODEL` overrides)        |
| `severityGate`        | `info`\|`minor`\|`major`\|`critical` (env `SEVERITY_GATE`)  |
| `contextFile(Aliases)`| Project context candidates read alongside `BUSINESS_LOGIC.md` |
| `contextFileRequired` | If `true`, CI fails (exit 2) when neither context file is available |
| `batch.maxFiles/Bytes`| Standalone batch size limits                                |
| `diff.maxHunkBytesPerCall` | CI diff grouping size limit                            |
| `include` / `exclude` | Glob filters for which files are reviewed                   |

## Smoke test

```bash
docker run --rm -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" opencodereviewer node /app/scripts/smoke.js
```

Runs a trivial prompt through OpenCode and checks that the model returns a reply.
Run `npm test` for CI and dashboard checks with a mock OpenCode command. The
mock tests require Git and a local loopback port, and use no model credentials.

## Local dev (without Docker)

Requires Node ≥ 20 and the `opencode` CLI on PATH.

```bash
npm install
REPO_DIR=/absolute/path/to/small-repo DEEPSEEK_API_KEY=... npm start
npm install --global .
DEEPSEEK_API_KEY=... opencodereviewer ci .
```

The local dashboard listens on http://127.0.0.1:3000. It defaults to the
working directory when `REPO_DIR` is unset. A non-loopback `HOST` requires
`REVIEW_PASSWORD`.

## License

[MIT](./LICENSE)
