# Roadmap

This roadmap compares the current tool with the Master's final project brief,
*OpenCodeReviewer: A Secure, Multi-Agent AI Platform for Reviewing Large
Codebases and Validating Business Logic Vulnerabilities*, and orders the
remaining work. Section numbers (§) refer to the brief.

Status as of 2026-11-27, on branch `feat/retry-and-pricing` (after #27).

## Tracking

Every task has an ID of the form `P<phase>-<number>`, for example `P3-02`.
The same ID is used everywhere the task appears:

| Where | Format | Example |
| --- | --- | --- |
| Roadmap | `**P3-02**` at the start of the task | `- [ ] **P3-02** Flow-based batches …` |
| Issue title | `[P3-02] <task>` | `[P3-02] Group related files in one batch` |
| Branch | `p3-02-<short-name>` | `p3-02-flow-batches` |
| Commit and PR title | `[P3-02] <change>` | `[P3-02] Group files by imports before batching` |
| PR description | `Closes #<issue>` | `Closes #42` |

Each issue carries the label of its phase (`phase-0` … `phase-10`). When a PR
merges, tick the task here in the same PR. IDs are never reused: a dropped
task keeps its ID and is struck through.

Older issues that predate this scheme are mapped to an ID in the task text.

## Where we are

### Done

**Shared engine, three entry points (§2, WP2, partly)**

- One `src/core/` engine used by both the CLI (`src/cli.js`) and the web
  dashboard (`src/server.js`).
- CLI `ci` command: Git ranges (`--base/--head/--merge-base`), automatic CI
  scope detection (GitLab, GitHub, Gitea), unified diffs from any VCS
  (`--diff`), `--gate`, `--model`, `--config`, `--concurrency`, `--dry-run`.
- Exit codes for pipelines: `0` pass, `1` gate failed, `2` bad config,
  `3` fatal or incomplete review.
- Docker image with a pinned OpenCode CLI, GitLab and Gitea examples, CI on
  Node 22/24/26, Dependabot.

**Web application (§2)**

- Sign-in with a forced change of the default password, lockout after failed
  attempts, host-name allow-list against DNS rebinding.
- Saved repositories: local folder, ZIP/folder upload with a hardened
  extractor, shallow `https://` clone limited to allowed hosts.
- Run queue, live progress over SSE, cancel, run history that survives
  restarts, retry of failed batches.
- Findings grouped by file with filters, Markdown and JSON export.
- Settings page with write-only secrets, model prices, spend totals.

**Large codebases (§3.1, first steps)**

- Files are batched by count and bytes; oversized files are split by line
  range and diffs by hunk instead of being truncated.
- A clipped line (minified code) marks the review incomplete, so CI exits `3`
  instead of passing silently.
- `--dry-run` shows batches and estimated input tokens before paying.
- Token and USD cost tracking per run and in total.

**Hardening (§3.2, first steps)**

- Reviews run as a `review` agent with every OpenCode tool denied.
- A repository's own `review.config.json` cannot change the model, gate,
  context requirement or request rate.
- Config files are validated; unknown keys fail the run.

**Skills (§3.3, first steps)**

- Two always-loaded skills: OWASP Web Top 10 2025 and OWASP API Top 10 2023.

**Business rules**

- `BUSINESS_LOGIC.md` and a project context file are added to every prompt.

### Gaps against the brief

| Brief | Gap today |
| --- | --- |
| §3.1 Coverage | No per-file record of reviewed / skipped (with reason) / failed. Batching is alphabetical, so a route, its middleware and its model can land in different batches. No syntax-aware splitting, no code graph, no entry-point map, no layered passes, no shared memory between batches, no budget stop. |
| §3.1 Written guarantees | No drafting of `BUSINESS_LOGIC.md` when it is missing; rules are free text, not numbered guarantees. |
| §3.2 Threat model | No threat model document. In CI, `BUSINESS_LOGIC.md` is read from the checkout under review, so a pull request can rewrite its own rules. No secret masking before code reaches the model. No "repository text is data" rule tested against prompt-injection samples. Verdicts are not tamper-protected. |
| §3.3 Multi-agent | One prompt per batch. No planner, specialist reviewers, verifier, or skills by surface and family. |
| §3.4 Live validation | None. Every finding is a model opinion; there is no proof test, sandbox, browser or API agent, and no lead / confirmed distinction. |
| §3.5 False positives | Not measured. No AI triage, no per-file verdict cache. |
| §3.6 Single pipeline step | No connectors for Semgrep, SCA, secret scanning or ZAP. No SARIF 2.1.0 / CycloneDX import or SARIF export. A single severity gate instead of a YAML policy. |
| §3.7 Learning | No pattern memory, no anti-patterns, no poisoning defences. |
| §6 Evaluation | No benchmark, no evaluation scripts, no baselines. |
| §7 Deliverables | No PR comments or GitHub Action wrapper; no thesis material in the repository. |

### Lessons from the first full review

Run `aa75d274` (2026-11-24, `deepseek/deepseek-flash`) reviewed the todo lab
app, which has two bugs planted against its `BUSINESS_LOGIC.md`.

- **Both planted bugs were found:** delete without an owner check
  (`todo.repository.js:22`, critical, with the full route → service → SQL
  chain) and rename of a completed todo (`todo.repository.js:17`, major, but
  filed as `logic` rather than a business-rule violation).
- **31 findings in total.** Only 2 of the 5 major or critical findings are
  real: about **40% precision at the level that blocks a merge**.
- **False positive from batching:** `app.js:33` "missing `await`" (major).
  `handleAuthenticated` is synchronous, but `app.js` and `auth.routes.js`
  were in different batches, so the model never saw it. This finding alone
  fails the `major` gate.
- **Other false or speculative findings:** `todo.validation.js:21` claims an
  untrimmed title is stored (the service trims it); `auth.repository.js:4`
  guesses about a "(unseen)" service, which the skill already forbids.
- **Noise:** a duplicate of the critical finding at info level, 6 findings on
  test files, and most of the 26 minor and info findings are style or
  maintainability.
- **Cost:** about 266k input tokens for a ~20-file app; the cost showed as
  unavailable (fixed by the pricing work on the current branch).

These lessons are tracked as P1-01, P2-01 to P2-06 and P3-01.

## Plan

The phases are ordered by dependency. Phase 0 and Phase 1 come first because
every later claim (fewer false positives, better recall, memory helps) has to
be measured on a benchmark, and every later feature needs a structured
finding model and coverage data to build on.

### Phase 0: Finish the current branch and the study (WP1)

- [ ] **P0-01** Merge `feat/retry-and-pricing` (retried calls, model prices,
      partial token flags).
- [ ] **P0-02** State-of-the-art notes: SAST limits, LLM code review,
      multi-agent systems; read Shannon, alibaba/open-code-review,
      spencermarx/open-code-review, OpenReviewer and CybeDefend.
- [ ] **P0-03** Survey BAC-BENCH, BAC-Bench and the OWASP Benchmark: what each
      covers and what is missing (§6).
- [ ] **P0-04** Architecture document for the shared engine (WP2): pipeline
      stages, finding model, storage, how CLI / web / CI call it.
- [ ] **P0-05** Close or re-scope the web app epic (#21) and its phases
      #17, #18 and #19, which #25–#27 delivered; keep #20 as P9-04.

### Phase 1: Benchmark and evaluation harness (WP8, started early)

- [ ] **P1-01** First benchmark case from the todo lab app: the vulnerable
      version, a fixed version, and a ground-truth file listing the two
      planted bugs. Today's baseline is 2 of 2 found, about 40% precision on
      major and critical findings.
- [ ] **P1-02** Benchmark layout: one vulnerable app and its fixed version per
      case, each with `BUSINESS_LOGIC.md` and a ground-truth file (file, line
      range, CWE, class, business rule, difficulty).
- [ ] **P1-03** `scripts/eval/`: precision, recall, F1, paired recall,
      coverage, tokens / cost / time, and stability over N runs.
- [ ] **P1-04** Cover the §6 range from basic to advanced: BOLA/BFLA, mass
      assignment, injection with filter/WAF bypass, SSRF, deserialization,
      prototype pollution, race conditions, auth/JWT flaws, business logic
      abuse, multi-step chains.
- [ ] **P1-05** Each case usable as a whole-repo scan and as a pull request.
- [ ] **P1-06** Baseline numbers for the current single-agent reviewer,
      Semgrep and CodeQL. Every later task that changes results reports its
      delta against this.

### Phase 2: Finding quality and proof-based reporting (§3.4, §3.5, §3.6, contribution 9)

Quick wins from the first full review come first in this phase.

- [ ] **P2-01** Security-focused prompt by default: `src/core/prompts.js`
      asks for correctness, performance, maintainability and style. Keep only
      security and business-rule findings by default, with the other
      categories behind an option.
- [ ] **P2-02** Findings name the business rule they break: number the rules
      in `BUSINESS_LOGIC.md` (R1, R2 …), ask the model for the rule ID, and add
      a `business-rule` category.
- [ ] **P2-03** Test files do not count toward the gate: skip them by default
      (`**/tests/**`, `**/*.test.*`, `**/*.spec.*`) or review them as
      non-blocking.
- [ ] **P2-04** Merge duplicate findings on the same file and nearby lines,
      keeping the highest severity (`src/core/report.js`).
- [ ] **P2-05** Downgrade speculative findings to leads in code: a finding
      that refers to code the model did not see ("unseen", "if the service …")
      cannot block.
- [ ] **P2-06** Checking pass for major and critical findings: a second call
      gets the finding, its code and the files it imports, and answers
      confirmed or not with the line it relied on. Unconfirmed findings become
      leads. First step toward the verifier (P5-03).
- [ ] **P2-07** Extend findings with `id`, `cwe`, `owasp`, `cvss`, `rule`,
      `evidence`, `status` (`lead`, `confirmed`, `not_reproduced`,
      `not_testable`, `dismissed`) and `proof`.
- [ ] **P2-08** Only findings with a proof can fail the gate; everything else
      is a lead.
- [ ] **P2-09** SARIF 2.1.0 export (#11).
- [ ] **P2-10** SARIF 2.1.0 and CycloneDX import.
- [ ] **P2-11** Finding fingerprints, inline suppression comments and a
      baseline file (#14). Suppressions never apply to secrets or critical
      findings without a person's approval.
- [ ] **P2-12** YAML policy file: Block / Warn rules by severity, CVSS, CWE,
      OWASP category, scanner, age, branch; replaces `severityGate` and sets
      the exit code.

### Phase 3: Full coverage of large codebases (§3.1, WP3, contribution 2)

- [ ] **P3-01** Keep related files in one batch: group by folder, then follow
      imports from each entry file, instead of the alphabetical order in
      `src/core/batcher.js`. Fixes the `app.js` / `auth.routes.js` split behind
      the false "missing `await`" finding.
- [ ] **P3-02** Coverage ledger: every in-scope file recorded as reviewed,
      skipped (with reason) or failed. A review cannot report "complete" while
      any file is unreviewed; the report includes a coverage section.
- [ ] **P3-03** Syntax-aware splitting with tree-sitter at function and class
      boundaries, replacing line-range splitting.
- [ ] **P3-04** Code graph (imports, calls, routes) and flow-based batches: the
      files of one feature reviewed together. Builds on P3-01.
- [ ] **P3-05** Entry-point map: routes, consumers, jobs, webhooks; who may
      call, what changes, the enforcing line, and a verdict per row (ok,
      finding, lead, not examined + reason). Saved between runs.
- [ ] **P3-06** Incremental reviews: only changed files and the entry points
      that reach them.
- [ ] **P3-07** Layered review: architecture/risk map pass, per-unit passes,
      cross-cutting pass.
- [ ] **P3-08** Shared memory: summaries (for example "how auth works") passed
      to later batches.
- [ ] **P3-09** Read-only navigation tools (find references, get definition) so
      agents fetch code on demand.
- [ ] **P3-10** Cost control: prompt caching of the shared context, a cost
      estimate in `--dry-run`, and a budget limit that stops the run.
- [ ] **P3-11** Completion check: a fresh agent re-checks coverage until it
      finds nothing new.
- [ ] **P3-12** Headless `scan` command for full-codebase review from the CLI
      (#15).

### Phase 4: Threat model and hardening (§3.2, WP4, contribution 3)

- [ ] **P4-01** Threat model document with STRIDE, OWASP Top 10 for LLM
      Applications and MITRE ATLAS.
- [ ] **P4-02** Read `BUSINESS_LOGIC.md`, context files and review settings
      from the target branch in CI, not from the pull request.
- [ ] **P4-03** Secret masking: detect and redact secrets before any code
      reaches the model; masked reader for `.env` and similar files.
- [ ] **P4-04** System rule in every agent prompt: repository text is data,
      never an instruction. Prompt-injection test corpus in the test suite.
- [ ] **P4-05** Agents keep read-only tools only and never see CI secrets.
- [ ] **P4-06** Tamper-protected verdicts (signed or stored outside the
      reviewed branch) so a pull request cannot dismiss its own findings.
- [ ] **P4-07** One test per critical threat proving its mitigation.

### Phase 5: Multi-agent review and skills (§3.3, WP5, contribution 4)

- [ ] **P5-01** Planner that reads the entry-point map and assigns work.
- [ ] **P5-02** Specialist reviewers: BOLA, BFLA, mass assignment first, then
      the other classes.
- [ ] **P5-03** Verifier that re-checks each finding against the code and
      rules. Replaces the checking pass from P2-06.
- [ ] **P5-04** Skills by surface (identity and sessions, browser, messaging
      and APIs, exports and caches, infrastructure, AI agents), loaded only
      when the repository has that surface.
- [ ] **P5-05** Skills by family (access rights, identity, input trusted too
      early, multi-step flows, money and limits).
- [ ] **P5-06** Review techniques in the skills: sibling-handler comparison,
      every role on every route, variant search after each finding, fail-open
      checks.
- [ ] **P5-07** Draft `BUSINESS_LOGIC.md` as numbered written guarantees from
      code, README and tests when missing; a person confirms it in the web
      app.
- [ ] **P5-08** Ablation: one agent vs several, with and without business
      rules.

### Phase 6: Scanner connectors and AI triage (§3.5, §3.6, contribution 1)

- [ ] **P6-01** Connectors: Semgrep (SAST), an SCA tool (for example
      OSV-Scanner or Trivy), a secret scanner (for example Gitleaks), OWASP
      ZAP (DAST); SaaS connectors through SARIF import (P2-10).
- [ ] **P6-02** Correlation: deduplicate across tools and link related
      findings (for example a SAST finding confirmed by DAST).
- [ ] **P6-03** AI triage of every scanner finding: not exploitable,
      theoretical or proven, with the evidence checked. Unsure stays open;
      secrets are never dismissed.
- [ ] **P6-04** Verdict cache keyed by file hash so the next run re-judges
      only changes.
- [ ] **P6-05** One prioritised report with fixes. Measure false-positive
      reduction per technique.

### Phase 7: Live validation (§3.4, WP6, contribution 5)

- [ ] **P7-01** Proof tests: the agent writes a test in the repository's own
      framework that fails for the claimed reason.
- [ ] **P7-02** Sandbox: start the app under review in an isolated container
      with throwaway data.
- [ ] **P7-03** Safety checks before start: refuse remote databases,
      production addresses, live payment keys; block outbound e-mail and
      payment providers; limit requests per finding.
- [ ] **P7-04** Pentest agent with a Playwright browser and an HTTP client,
      including multi-step flows and second-account tests.
- [ ] **P7-05** Evidence attached to each finding: requests, responses,
      screenshots.
- [ ] **P7-06** Ablation: static review alone vs static + live testing.

### Phase 8: Self-learning memory (§3.7, WP7, contribution 10)

- [ ] **P8-01** Pattern memory written only from confirmed results (proof
      test, live replay, person in triage): type, framework, vulnerable and
      safe shapes, how found, search query, fix. No code stored.
- [ ] **P8-02** Anti-patterns from confirmed false positives.
- [ ] **P8-03** Per-project memory (always on) and shared memory (opt-in,
      anonymised); patterns load by stack and expire when they stop helping.
- [ ] **P8-04** Poisoning defences: suppressing patterns need human approval
      and never apply to secrets or critical findings; provenance on every
      pattern; list / disable / delete in the web app.
- [ ] **P8-05** Release test with and without memory; remove patterns that
      cause misses. Measure the learning effect over successive runs.

### Phase 9: Pipeline and web app polish (§2)

- [ ] **P9-01** GitHub Action and GitLab component wrappers.
- [ ] **P9-02** Pull request comments and status checks for GitHub, GitLab and
      Gitea.
- [ ] **P9-03** Triage in the web app: mark findings confirmed / dismissed,
      feeding Phase 8.
- [ ] **P9-04** Visual results: charts, file tree, code view, run comparison
      (#20).

### Phase 10: Evaluation and release (WP8, WP9, contributions 6–8)

- [ ] **P10-01** Full benchmark runs against Shannon, alibaba/open-code-review,
      spencermarx/open-code-review, OpenReviewer, CybeDefend, Semgrep and
      CodeQL.
- [ ] **P10-02** All ablations: business rules, single vs multi-agent, static
      vs live, memory on vs off.
- [ ] **P10-03** Stability analysis across repeated runs.
- [ ] **P10-04** Publish the tool, the benchmark and the results as open
      source.
- [ ] **P10-05** Thesis report and final presentation.

## Next pull requests

1. **P0-01** Merge the current branch.
2. **P1-01**, **P1-03** First benchmark case and the eval script, with
   baseline numbers.
3. **P3-01** Keep related files in one batch.
4. **P2-06** Checking pass for major and critical findings.
5. **P2-01** to **P2-05** Finding-quality quick wins, each measured on P1-01.
6. **P3-02** Coverage ledger and coverage section in the report.
7. **P4-02**, **P4-03** Business rules from the target branch in CI; secret
   masking.
