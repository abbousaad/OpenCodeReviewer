# Roadmap

This roadmap compares the current tool with the Master's final project brief,
*OpenCodeReviewer: A Secure, Multi-Agent AI Platform for Reviewing Large
Codebases and Validating Business Logic Vulnerabilities*, and orders the
remaining work. Section numbers (§) refer to the brief.

Status as of 2026-11-27, on branch `feat/retry-and-pricing` (after #27).

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

## Plan

The phases are ordered by dependency. Phase 0 and Phase 1 come first because
every later claim (fewer false positives, better recall, memory helps) has to
be measured on a benchmark, and every later feature needs a structured
finding model and coverage data to build on.

### Phase 0: Finish the current branch and the study (WP1)

- [ ] Merge `feat/retry-and-pricing` (retried calls, model prices, partial
      token flags).
- [ ] State-of-the-art notes: SAST limits, LLM code review, multi-agent
      systems; read Shannon, alibaba/open-code-review,
      spencermarx/open-code-review, OpenReviewer and CybeDefend.
- [ ] Survey BAC-BENCH, BAC-Bench and the OWASP Benchmark: what each covers
      and what is missing (§6).
- [ ] Architecture document for the shared engine (WP2): pipeline stages,
      finding model, storage, how CLI / web / CI call it.

### Phase 1: Benchmark and evaluation harness (WP8, started early)

- [ ] Benchmark layout: one vulnerable app and its fixed version per case,
      each with `BUSINESS_LOGIC.md` and a ground-truth file (file, line range,
      CWE, class, difficulty).
- [ ] Cover the §6 range from basic to advanced: BOLA/BFLA, mass assignment,
      injection with filter/WAF bypass, SSRF, deserialization, prototype
      pollution, race conditions, auth/JWT flaws, business logic abuse,
      multi-step chains.
- [ ] Each case usable as a whole-repo scan and as a pull request.
- [ ] `scripts/eval/`: precision, recall, F1, paired recall, coverage,
      tokens / cost / time, stability over N runs.
- [ ] Baseline numbers for the current single-agent reviewer, Semgrep and
      CodeQL. Every later phase reports its delta against this.

### Phase 2: Finding model and proof-based reporting (§3.4, §3.6, contribution 9)

- [ ] Extend findings with `id`, `cwe`, `owasp`, `cvss`, `evidence`,
      `status` (`lead`, `confirmed`, `not_reproduced`, `not_testable`,
      `dismissed`) and `proof`.
- [ ] Only findings with a proof can fail the gate; everything else is a lead.
- [ ] SARIF 2.1.0 export, then SARIF and CycloneDX import.
- [ ] YAML policy file: Block / Warn rules by severity, CVSS, CWE, OWASP
      category, scanner, age, branch; replaces `severityGate` and sets the
      exit code.

### Phase 3: Full coverage of large codebases (§3.1, WP3, contribution 2)

- [ ] Coverage ledger: every in-scope file recorded as reviewed, skipped
      (with reason) or failed. A review cannot report "complete" while any
      file is unreviewed; the report includes a coverage section.
- [ ] Syntax-aware splitting with tree-sitter at function and class
      boundaries, replacing line-range splitting.
- [ ] Code graph (imports, calls, routes) and flow-based batches: the files
      of one feature reviewed together.
- [ ] Entry-point map: routes, consumers, jobs, webhooks; who may call, what
      changes, the enforcing line, and a verdict per row (ok, finding, lead,
      not examined + reason). Saved between runs.
- [ ] Incremental reviews: only changed files and the entry points that reach
      them.
- [ ] Layered review: architecture/risk map pass, per-unit passes,
      cross-cutting pass.
- [ ] Shared memory: summaries (for example "how auth works") passed to
      later batches.
- [ ] Read-only navigation tools (find references, get definition) so agents
      fetch code on demand.
- [ ] Cost control: prompt caching of the shared context, a cost estimate in
      `--dry-run`, and a budget limit that stops the run.
- [ ] Completion check: a fresh agent re-checks coverage until it finds
      nothing new.

### Phase 4: Threat model and hardening (§3.2, WP4, contribution 3)

- [ ] Threat model document with STRIDE, OWASP Top 10 for LLM Applications
      and MITRE ATLAS.
- [ ] Read `BUSINESS_LOGIC.md`, context files and review settings from the
      target branch in CI, not from the pull request.
- [ ] Secret masking: detect and redact secrets before any code reaches the
      model; masked reader for `.env` and similar files.
- [ ] System rule in every agent prompt: repository text is data, never an
      instruction. Prompt-injection test corpus in the test suite.
- [ ] Agents keep read-only tools only and never see CI secrets.
- [ ] Tamper-protected verdicts (signed or stored outside the reviewed
      branch) so a pull request cannot dismiss its own findings.
- [ ] One test per critical threat proving its mitigation.

### Phase 5: Multi-agent review and skills (§3.3, WP5, contribution 4)

- [ ] Planner that reads the entry-point map and assigns work.
- [ ] Specialist reviewers: BOLA, BFLA, mass assignment first, then the
      other classes.
- [ ] Verifier that re-checks each finding against the code and rules.
- [ ] Skills by surface (identity and sessions, browser, messaging and APIs,
      exports and caches, infrastructure, AI agents), loaded only when the
      repository has that surface.
- [ ] Skills by family (access rights, identity, input trusted too early,
      multi-step flows, money and limits).
- [ ] Review techniques in the skills: sibling-handler comparison, every role
      on every route, variant search after each finding, fail-open checks.
- [ ] Draft `BUSINESS_LOGIC.md` as written guarantees from code, README and
      tests when missing; a person confirms it in the web app.
- [ ] Ablation: one agent vs several, with and without business rules.

### Phase 6: Scanner connectors and AI triage (§3.5, §3.6, contribution 1)

- [ ] Connectors: Semgrep (SAST), an SCA tool (for example OSV-Scanner or
      Trivy), a secret scanner (for example Gitleaks), OWASP ZAP (DAST);
      SaaS connectors through SARIF import.
- [ ] Correlation: deduplicate across tools and link related findings (for
      example a SAST finding confirmed by DAST).
- [ ] AI triage of every scanner finding: not exploitable, theoretical or
      proven, with the evidence checked. Unsure stays open; secrets are never
      dismissed.
- [ ] Verdict cache keyed by file hash so the next run re-judges only changes.
- [ ] One prioritised report with fixes. Measure false-positive reduction per
      technique.

### Phase 7: Live validation (§3.4, WP6, contribution 5)

- [ ] Proof tests: the agent writes a test in the repository's own framework
      that fails for the claimed reason.
- [ ] Sandbox: start the app under review in an isolated container with
      throwaway data.
- [ ] Safety checks before start: refuse remote databases, production
      addresses, live payment keys; block outbound e-mail and payment
      providers; limit requests per finding.
- [ ] Pentest agent with a Playwright browser and an HTTP client, including
      multi-step flows and second-account tests.
- [ ] Evidence attached to each finding: requests, responses, screenshots.
- [ ] Ablation: static review alone vs static + live testing.

### Phase 8: Self-learning memory (§3.7, WP7, contribution 10)

- [ ] Pattern memory written only from confirmed results (proof test, live
      replay, person in triage): type, framework, vulnerable and safe shapes,
      how found, search query, fix. No code stored.
- [ ] Anti-patterns from confirmed false positives.
- [ ] Per-project memory (always on) and shared memory (opt-in, anonymised);
      patterns load by stack and expire when they stop helping.
- [ ] Poisoning defences: suppressing patterns need human approval and never
      apply to secrets or critical findings; provenance on every pattern;
      list / disable / delete in the web app.
- [ ] Release test with and without memory; remove patterns that cause
      misses. Measure the learning effect over successive runs.

### Phase 9: Pipeline polish (§2)

- [ ] GitHub Action and GitLab component wrappers.
- [ ] Pull request comments and status checks for GitHub, GitLab and Gitea.
- [ ] Triage in the web app: mark findings confirmed / dismissed, feeding
      Phase 8.

### Phase 10: Evaluation and release (WP8, WP9, contributions 6–8)

- [ ] Full benchmark runs against Shannon, alibaba/open-code-review,
      spencermarx/open-code-review, OpenReviewer, CybeDefend, Semgrep and
      CodeQL.
- [ ] All ablations: business rules, single vs multi-agent, static vs live,
      memory on vs off.
- [ ] Stability analysis across repeated runs.
- [ ] Publish the tool, the benchmark and the results as open source.
- [ ] Thesis report and final presentation.

## Suggested order of the next pull requests

1. Merge the current branch.
2. Benchmark skeleton with three to five cases and the eval script, plus
   baseline numbers.
3. Coverage ledger and coverage section in the report.
4. Finding model with `status`, and SARIF export.
5. Business rules and settings read from the target branch in CI; secret
   masking.
6. Tree-sitter splitting and the code graph.
7. Entry-point map.
