<div align="center">

# OpenCodeReviewer

**AI security review that knows your business rules.**

Finds the bugs scanners miss — like a delete that never checks who owns the record.

[![test](https://github.com/abbousaad/OpenCodeReviewer/actions/workflows/test.yml/badge.svg)](https://github.com/abbousaad/OpenCodeReviewer/actions/workflows/test.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[Quick start](#quick-start) · [How it works](docs/how-it-works.md) · [Docs](#docs) · [Roadmap](ROADMAP.md)

</div>

<br>

Write your rules in plain language in `BUSINESS_LOGIC.md`:

```markdown
- Only the owner of a todo can read, rename or delete it.
- A completed todo's title is locked.
```

OpenCodeReviewer sends your code, those rules and the OWASP Top 10 to an LLM
through [OpenCode](https://opencode.ai), and reports where the code breaks them:

```text
🟥 critical  src/modules/todos/todo.routes.js:25
   API1:2023 BOLA. DELETE /todos/:id never passes the user ID, so any
   signed-in user can delete anyone's todo.
```

## Use it three ways

|  |  |
| --- | --- |
| 🖥️ **Dashboard** | Review a whole repository, watch progress live, browse findings, export reports. |
| ⌨️ **CLI** | Review a branch, a commit range or a diff on your machine. |
| 🚦 **CI/CD** | Review every pull request and fail the pipeline on serious findings. |

## Quick start

```bash
docker build -t opencodereviewer .
```

**Dashboard** — then open <http://127.0.0.1:3000> and sign in as `ocr-admin` / `ocr-admin`
(you'll be asked to change the password).

```bash
docker run --rm -p 127.0.0.1:3000:3000 \
  -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  -v ocr-data:/data -v "$PWD":/repo:ro \
  opencodereviewer
```

**CI** — exits `1` when a finding reaches the severity gate.

```bash
docker run --rm -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  -v "$PWD":/repo -w /repo \
  opencodereviewer opencodereviewer ci /repo --base origin/main --merge-base
```

## Docs

| | |
| --- | --- |
| [How it works](docs/how-it-works.md) | Business rules, security skills, model, batching |
| [Dashboard](docs/dashboard.md) | Sign-in, repositories, runs, settings, costs |
| [CI mode](docs/ci.md) | Flags, exit codes, Git ranges, diffs, GitLab and Gitea examples |
| [Configuration](docs/configuration.md) | `review.config.json`, precedence, local development |
| [Roadmap](ROADMAP.md) | What's next, with task IDs for issues and PRs |

## License

[MIT](./LICENSE)
