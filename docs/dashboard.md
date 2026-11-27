# Dashboard

The dashboard reviews a whole codebase: it splits the source into batches,
reviews each one, streams progress live and keeps the results.

← [Back to README](../README.md)

## Start

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

## Runs, queue and costs

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

## Repositories

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

## Settings

Open **Settings** to change the model, severity gate, include and exclude
globs, batch sizes, concurrency and `contextFileRequired` for dashboard
reviews. They are saved in `/data/settings.json` and apply to every new run.
A reviewed directory's own `review.config.json` can still change the scope and
batch sizes for that directory, and the dashboard form's model and gate apply
to a single run.

The page also stores the DeepSeek API key and a GitHub token (used to clone
private github.com repositories) in `/data/secrets.json` (mode `0600`).
Saved secrets are never sent back to the browser; the page shows only whether
each one is set. The key is passed to OpenCode when `DEEPSEEK_API_KEY` is not
set in the environment.

Environment variables take precedence: when `OC_MODEL`, `SEVERITY_GATE`,
`MAX_PARALLEL_REVIEWS`, `OC_TIMEOUT_MS` or `DEEPSEEK_API_KEY` is set, the
matching field is read-only. With a key saved in
Settings, the `-e DEEPSEEK_API_KEY` option above can be left out.

## Tips

- Start with a small repository to check the model, key and cost.
- `REPO_DIR` (`/repo` in Docker) is only where **Local folder** looks;
  uploads and clones live in `/data/repos/`.
- See [How it works](how-it-works.md#batches-and-large-files) for how large
  files are split.

