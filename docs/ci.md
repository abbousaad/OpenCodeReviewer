# CI mode

One-shot review of a change, with an exit code that can fail the pipeline.

← [Back to README](../README.md)

## Run

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
| `--config <file>` | Extra config file, applied over the bundled and repository files. See [Configuration](configuration.md). |
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

## Explicit Git revisions

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

## Unified diff from any version control system

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

## Automatic Git scope

When no explicit input is supplied, the first available trigger wins:

| Trigger | Environment variables | Diff range |
| --- | --- | --- |
| Pull or merge request | `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, `GITHUB_BASE_REF`, `GITEA_BASE_REF`, `BASE_REF` | `base...HEAD` |
| Branch push | `CI_COMMIT_BEFORE_SHA` | `before..HEAD` |
| Single commit | `REVIEW_COMMIT`, `CI_COMMIT_SHA` | `sha^..sha` |
| Fallback | None | Last commit on the checkout |

## GitLab CI (`.gitlab-ci.yml`)

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

## Gitea Actions (`.gitea/workflows/review.yml`)

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

