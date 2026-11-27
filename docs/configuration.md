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
5. The `OC_MODEL` and `SEVERITY_GATE` environment variables.
6. The `--gate`, `--model` and `--concurrency` flags, or the dashboard form.

Dashboard reviews also apply the settings saved on the Settings page, between
steps 2 and 3. The CLI does not read them.

Every file is validated. An unknown key, a wrong type or invalid JSON stops the
review with exit `2` and names the file and key. In CI, keep `--config` files
outside the reviewed checkout, so a change under review cannot edit them.

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

