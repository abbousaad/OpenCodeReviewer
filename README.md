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
docker run --rm -p 127.0.0.1:3000:3000 \
  -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  -v ocr-data:/data \
  -v "$PWD":/repo:ro \
  opencodereviewer
```

Open http://127.0.0.1:3000 and sign in as `ocr-admin` with the password
`ocr-admin`. The dashboard then asks for a new password of at least 12
characters and allows nothing else until it is set. Until you change it,
anyone who can reach the port can sign in with the default, so keep the port
on `127.0.0.1` until then. The server prints a reminder at startup while the
default password is active.

- **Data:** the password hash is stored in `/data/auth.json` (mode `0600`).
  Keep the `ocr-data` volume to keep the password across restarts. Set
  `DATA_DIR` to use another directory; outside Docker it defaults to `data/`
  in the checkout.
- **Automated setups:** set `REVIEW_PASSWORD` to use that password instead.
  The forced change is skipped, and the password can only be changed in the
  environment.
- **Sessions:** signing in sets an `HttpOnly`, `SameSite=Strict` cookie that
  expires after 12 hours without use. Sessions end when the server restarts.
  After five failed attempts, an IP address is locked out for 15 minutes.
- **API clients:** send Basic auth as `ocr-admin` with the password.
  State-changing requests must use `Content-Type: application/json`.
- **Host names:** the dashboard answers only to IP addresses and `localhost`,
  which blocks DNS rebinding attacks. To use a host name, for example behind a
  reverse proxy, list it in `ALLOWED_HOSTS` (comma-separated).

### Runs, queue and costs

The dashboard lists every run with its status, findings, cost and duration.
Open a run for its results page: the gate result, cost and token use, findings
grouped by file with severity and text filters, failed batches, batch
summaries and the activity log. Reports download as Markdown or JSON.

- **Repositories:** reviews run on saved repositories. See below.
- **Queue:** at most `maxParallelReviews` runs execute at once (default 1);
  others wait in order. Set it in **Settings** or lock it with
  `MAX_PARALLEL_REVIEWS`. Up to `maxParallelReviews × concurrency` model calls
  can be in flight.
- **Timeouts:** each model call stops after `timeoutSeconds` (default 300).
  A batch whose call times out or crashes is retried once before it counts as
  failed. Set it in **Settings** or lock it with `OC_TIMEOUT_MS` (milliseconds).
- **Cancel:** a queued run is dropped at once. A running run starts no new
  batches, stops the model calls in flight and keeps the findings so far.
- **History:** runs are saved in `/data/runs/` (mode `0600`) and survive
  restarts. The newest `runsToKeep` runs are kept (default 50). Runs that were
  active when the server stopped are marked *interrupted*.
- **Spend:** the dashboard shows the estimated USD cost and tokens for all time
  and this month. Totals live in `/data/usage.json` and still count runs that
  were deleted or pruned.

### Repositories

Open **Repositories** to manage what the dashboard can review.

- **Local folder:** a folder inside the review root (`REPO_DIR`). Removing it
  only removes it from the list; the files are never deleted.
- **Upload:** a folder (packed into a ZIP in the browser) or a `.zip`. The
  server extracts it into `/data/repos/<id>/` with owner-only permissions and
  unwraps a single top-level folder. Paths that escape the folder, absolute
  paths, symlinks, encrypted entries and size fields that don't match the data
  are rejected; `.git`, `node_modules` and `__MACOSX` are skipped. Limits:
  `MAX_UPLOAD_MB` (200), `MAX_UPLOAD_FILES` (20000) and `MAX_UPLOAD_FILE_MB`
  (2 per file; larger files are skipped).
- **Git URL:** a shallow clone over `https://` into `/data/repos/<id>/`, with
  hooks, submodules, symlinks and redirects off. Only hosts in
  `GIT_ALLOWED_HOSTS` are allowed (default `github.com,gitlab.com,bitbucket.org`).
  Private github.com repositories use the GitHub token saved in Settings; it is
  passed to Git in the environment and is never put in the URL or saved with
  the repository. **Pull** re-clones and swaps the copy in.
- A repository can't be removed or pulled while a review of it is queued or
  running. Removing an upload or clone deletes its copy; its past runs stay.

### Settings

Open **Settings** to change the model, severity gate, include and exclude
globs, batch sizes, concurrency and `contextFileRequired` for dashboard
reviews. They are saved in `/data/settings.json` and apply to every new run.
A reviewed directory's own `review.config.json` can still change the scope and
batch sizes for that directory, and the dashboard form's model and gate apply
to a single run.

The page also stores the DeepSeek API key and a GitHub token (used for cloning
private repositories in a later release) in `/data/secrets.json` (mode `0600`).
Saved secrets are never sent back to the browser; the page shows only whether
each one is set. The key is passed to OpenCode when `DEEPSEEK_API_KEY` is not
set in the environment.

Environment variables take precedence: when `OC_MODEL`, `SEVERITY_GATE` or
`DEEPSEEK_API_KEY` is set, the matching field is read-only. With a key saved in
Settings, the `-e DEEPSEEK_API_KEY` option above can be left out.

> **Upgrading:** the password-free loopback mode is gone, and the Basic-auth
> username changed from `review` to `ocr-admin`.

The dashboard defaults to `/repo` in Docker and accepts directories within that
mount. It streams batch progress and lets you download the report. Start with a
small repo. Files and diffs over the configured size limits are split into
several batches: files by line range, diffs by hunk. Only a single line longer
than the limit, such as minified code, is clipped. The report lists the
affected files and marks the review incomplete, so CI exits `3`. Exclude
generated or minified files to avoid this.

## CI mode (one-shot, exit-code gate)

```bash
docker run --rm \
  -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  -v "$PWD":/repo -w /repo \
  opencodereviewer opencodereviewer ci /repo
```

Exits `0` for a completed review that passes the severity gate and `1` when a
finding meets or exceeds the gate (default `major`). Exits `2` for invalid
flags or configuration, and `3` for other fatal errors or an incomplete review. CI writes reports
to the repo directory by default, including partial results when a batch fails.
Set `REPORT_DIR` to change the output directory.

| Flag | Meaning |
| --- | --- |
| `--gate <info\|minor\|major\|critical>` | Severity gate for this run. Overrides `SEVERITY_GATE` and config files. |
| `--model <provider/model>` | OpenCode model for this run. Overrides `OC_MODEL` and config files. |
| `--config <file>` | Extra config file, applied over the bundled and repository files. See [Configuration](#configuration-reviewconfigjson). |
| `--concurrency <1-16>` | Batches reviewed at the same time. Overrides `concurrency` in config files. |
| `--dry-run` | Show the batches, their files and estimated input tokens, then exit `0` without calling the model or writing reports. |

```bash
opencodereviewer ci /repo --gate critical --model deepseek/deepseek-v4-pro
```

Use `--dry-run` to check include and exclude rules and the size of a review
before paying for it. It runs the same scope, filter and context steps as a
real review, so it also fails with exit `2` when `contextFileRequired` is set
and no context file is found. Token estimates assume about 4 bytes per token
and cover only the prompts sent, not the output or retries.

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
| `concurrency`         | Batches reviewed at the same time, `1` to `16` (default `3`) |
| `batch.maxFiles/Bytes`| Standalone batch size limits                                |
| `diff.maxHunkBytesPerCall` | CI diff grouping size limit                            |
| `include` / `exclude` | Glob filters for which files are reviewed                   |

Settings are applied in this order, and later sources win:

1. Built-in defaults.
2. The `review.config.json` bundled with the reviewer.
3. A `review.config.json` at the root of the reviewed directory. It can set
   only `contextFile`, `contextFileAliases`, `batch`, `diff`, `include` and
   `exclude`. Other keys are ignored with a warning, because the code under
   review must not choose its own model, gate, context requirement or request
   rate.
4. The file passed with `--config`. It can set every key.

Dashboard reviews also apply the settings saved on the Settings page, between
steps 2 and 3. The CLI does not read them.
5. The `OC_MODEL` and `SEVERITY_GATE` environment variables.
6. The `--gate`, `--model` and `--concurrency` flags, or the dashboard form.

Every file is validated. An unknown key, a wrong type or invalid JSON stops the
review with exit `2` and names the file and key. In CI, keep `--config` files
outside the reviewed checkout, so a change under review cannot edit them.

## Smoke test

```bash
docker run --rm -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" opencodereviewer node /app/scripts/smoke.js
```

Runs a trivial prompt through OpenCode and checks that the model returns a reply.
Run `npm test` for CI and dashboard checks with a mock OpenCode command. The
mock tests require Git and a local loopback port, and use no model credentials.

## Local dev (without Docker)

Requires Node ≥ 22. `npm install` installs the OpenCode CLI version pinned in
`package-lock.json`, and `npm start` uses it. Other commands use the `opencode`
CLI on PATH.

```bash
npm install
REPO_DIR=/absolute/path/to/small-repo DEEPSEEK_API_KEY=... npm start
npm install --global .
DEEPSEEK_API_KEY=... opencodereviewer ci .
```

The local dashboard listens on http://127.0.0.1:3000. It defaults to the
working directory when `REPO_DIR` is unset. Sign in as described in
[Standalone mode](#standalone-mode-dashboard). The password hash is saved in
`data/` unless `DATA_DIR` is set.

## License

[MIT](./LICENSE)
