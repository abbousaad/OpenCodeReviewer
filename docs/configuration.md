# Configuration

← [Back to README](../README.md)

Settings live in `review.config.json`.

## Keys

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
| `timeoutSeconds`      | Model call timeout, `30` to `3600` (default `300`; env `OC_TIMEOUT_MS` in ms) |
| `maxParallelReviews`  | Dashboard runs executed at once, `1` to `8` (default `1`; env `MAX_PARALLEL_REVIEWS`) |
| `runsToKeep`          | Dashboard runs kept in history, `1` to `500` (default `50`) |

## Precedence

Settings are applied in this order, and later sources win:

1. Built-in defaults.
2. The `review.config.json` bundled with the reviewer.
3. A `review.config.json` at the root of the reviewed directory. It can set
   only `contextFile`, `contextFileAliases`, `batch`, `diff`, `include` and
   `exclude`. Other keys are ignored with a warning, because the code under
   review must not choose its own model, gate, context requirement or request
   rate.
4. The file passed with `--config`. It can set every key.
5. The `OC_MODEL`, `SEVERITY_GATE`, `MAX_PARALLEL_REVIEWS` and `OC_TIMEOUT_MS`
   environment variables.
6. The `--gate`, `--model` and `--concurrency` flags, or the dashboard form.

Dashboard reviews also apply the settings saved on the Settings page, between
steps 2 and 3. The CLI does not read them.

Every file is validated. An unknown key, a wrong type or invalid JSON stops the
review with exit `2` and names the file and key. In CI, keep `--config` files
outside the reviewed checkout, so a change under review cannot edit them.

## Environment variables

| Variable | Meaning | Default |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | Model provider key; overrides the key saved in Settings | — |
| `OC_MODEL`, `SEVERITY_GATE` | Model and gate; lock the Settings fields | — |
| `MAX_PARALLEL_REVIEWS`, `OC_TIMEOUT_MS` | Parallel runs and call timeout (ms); lock the Settings fields | — |
| `REPORT_DIR` | Where CI writes its reports | the reviewed directory |
| `HOST`, `PORT` | Dashboard address | `127.0.0.1`, `3000` (`0.0.0.0` in Docker) |
| `DATA_DIR` | Password, settings, secrets, runs and uploads | `data/` (`/data` in Docker) |
| `REPO_DIR` | Root for **Local folder** repositories | working directory (`/repo` in Docker) |
| `REVIEW_PASSWORD` | Fixed dashboard password; skips the forced change | — |
| `ALLOWED_HOSTS` | Extra host names the dashboard answers to | — |
| `GIT_ALLOWED_HOSTS` | Hosts allowed for Git URL repositories | `github.com,gitlab.com,bitbucket.org` |
| `MAX_UPLOAD_MB`, `MAX_UPLOAD_FILES`, `MAX_UPLOAD_FILE_MB` | Upload limits | `200`, `20000`, `2` |
| `OPENCODE_CONFIG` | OpenCode config file | `opencode.json` in the reviewer |

## Development

### Smoke test

```bash
docker run --rm -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" opencodereviewer node /app/scripts/smoke.js
```

Runs a trivial prompt through OpenCode and checks that the model returns a reply.
Run `npm test` for CI and dashboard checks with a mock OpenCode command. The
mock tests require Git and a local loopback port, and use no model credentials.

### Local dev (without Docker)

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
[Dashboard](dashboard.md). The password hash is saved in
`data/` unless `DATA_DIR` is set.

