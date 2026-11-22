#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, MAX_CONCURRENCY, MODEL_PATTERN, SEVERITY_ORDER, isConcurrency, loadConfig } from './core/config.js';
import { detectGitContext } from './core/gitContext.js';
import { computeDiffUnits } from './core/diff.js';
import { computePatchUnits } from './core/patch.js';
import { readContextFile } from './core/contextFile.js';
import { reviewDiffUnit, runUnits } from './core/reviewer.js';
import { diffReviewPrompt } from './core/prompts.js';
import { buildReport, writeReportFiles, renderMarkdown, truncationWarning } from './core/report.js';

async function ciMode(repoRoot, options, config) {
  console.log(`[OpenCodeReviewer] CI review of ${repoRoot}`);
  console.log(`[OpenCodeReviewer] config: ${config.sources.join(', ') || 'built-in defaults'}`);
  for (const warning of config.warnings) console.warn(`[OpenCodeReviewer] ⚠️  ${warning}`);
  console.log(`[OpenCodeReviewer] model=${config.model} gate=${config.severityGate} concurrency=${config.concurrency}`);

  const ctx = options.diff
    ? { kind: 'patch', description: `Unified diff ${path.basename(options.diff)}` }
    : await detectGitContext(repoRoot, {
      base: options.base,
      head: options.head,
      mergeBase: options['merge-base'],
    });
  console.log(`[OpenCodeReviewer] scope: ${ctx.description} (${ctx.kind})`);

  const { files, units } = options.diff
    ? await computePatchUnits(path.resolve(options.diff), config)
    : await computeDiffUnits(repoRoot, ctx, config);
  console.log(`[OpenCodeReviewer] ${files.length} changed file(s) to review in ${units.length} batch(es)`);
  const truncatedFiles = [...new Set(units.filter((u) => u.truncated).flatMap((u) => u.files))];
  if (truncatedFiles.length) {
    console.warn(`[OpenCodeReviewer] ⚠️  ${truncationWarning(truncatedFiles)}`);
  }

  const context = readContextFile(repoRoot, config);
  if (!context.found) {
    console.warn(`[OpenCodeReviewer] ⚠️  ${context.warning}`);
    if (config.contextFileRequired) {
      console.error('[OpenCodeReviewer] contextFileRequired=true — failing.');
      process.exit(2);
    }
  } else {
    console.log(`[OpenCodeReviewer] using context: ${context.paths.join(', ')}`);
  }

  if (options['dry-run']) {
    printPlan(units, context.text);
    return;
  }

  let results = [];
  if (units.length) {
    const runnable = units.map((u) => ({
      label: u.label,
      run: () => reviewDiffUnit(u, { config, contextText: context.text }),
    }));
    results = await runUnits(runnable, {
      concurrency: config.concurrency,
      onProgress: (p) => {
        if (p.phase === 'done') {
          const tag = p.error ? `error: ${p.error}` : `${p.findingCount} finding(s)`;
          console.log(`[OpenCodeReviewer] [${p.completed}/${p.total} done] ${p.label} — ${tag}`);
        }
      },
    });
  }

  const report = buildReport({
    mode: 'ci',
    meta: { description: ctx.description, kind: ctx.kind, changedFiles: files, truncatedFiles },
    results,
    contextWarning: context.warning,
    config,
  });

  const outDir = process.env.REPORT_DIR || repoRoot;
  const { jsonPath, mdPath } = writeReportFiles(report, outDir);
  console.log('\n' + renderMarkdown(report));
  console.log(`\n[OpenCodeReviewer] reports written: ${mdPath}, ${jsonPath}`);

  if (report.errors.length) {
    console.error(`[OpenCodeReviewer] Review incomplete: ${report.errors.length} batch(es) failed.`);
    process.exitCode = 3;
    return;
  }
  if (report.gateFailed) {
    console.error(`[OpenCodeReviewer] ❌ gate '${config.severityGate}' failed (max severity: ${report.maxSeverity}).`);
    process.exitCode = 1;
    return;
  }
  console.log('[OpenCodeReviewer] ✅ gate passed.');
}

// A rough average for source code; real counts depend on the model's tokenizer.
const BYTES_PER_TOKEN = 4;

/** Show what a review would send, without calling the model or writing reports. */
function printPlan(units, contextText) {
  console.log('[OpenCodeReviewer] dry run: no model calls, no report files.');
  let total = 0;
  units.forEach((unit, i) => {
    const prompt = diffReviewPrompt({ diffText: unit.diffText, contextText });
    const tokens = Math.ceil(Buffer.byteLength(prompt, 'utf8') / BYTES_PER_TOKEN);
    const diffKb = (Buffer.byteLength(unit.diffText, 'utf8') / 1024).toFixed(1);
    total += tokens;
    console.log(`[OpenCodeReviewer] batch ${i + 1}/${units.length}: ${unit.label} — ${unit.files.length} file(s), ` +
      `${diffKb} KB diff, ~${tokens.toLocaleString('en-US')} input tokens`);
    for (const file of unit.files) console.log(`    ${file}`);
  });
  console.log(`[OpenCodeReviewer] total: ~${total.toLocaleString('en-US')} estimated input tokens in ${units.length} batch(es) ` +
    `(about ${BYTES_PER_TOKEN} bytes per token; output and retries not included).`);
}

async function main() {
  const usage = `Usage: opencodereviewer ci [repoPath] [--base <ref> [--head <ref>] [--merge-base] | --diff <file>]
                           [--gate <${SEVERITY_ORDER.join('|')}>] [--model <provider/model>] [--config <file>]
                           [--concurrency <1-${MAX_CONCURRENCY}>] [--dry-run]`;
  let options, cmd, repoPath;
  try {
    const { values, positionals } = parseArgs({
      options: {
        base: { type: 'string' },
        head: { type: 'string' },
        'merge-base': { type: 'boolean' },
        diff: { type: 'string' },
        gate: { type: 'string' },
        model: { type: 'string' },
        config: { type: 'string' },
        concurrency: { type: 'string' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
    [cmd, repoPath] = positionals;
    options = values;
    if ((cmd && cmd !== 'ci') || positionals.length > 2) {
      throw new Error('Expected the ci command and at most one repository path');
    }
    if ([options.base, options.head, options.diff, options.gate, options.model, options.config, options.concurrency].includes('')) {
      throw new Error('--base, --head, --diff, --gate, --model, --config and --concurrency require nonempty values');
    }
    if (options.gate !== undefined && !SEVERITY_ORDER.includes(options.gate)) {
      throw new Error(`--gate must be one of ${SEVERITY_ORDER.join(', ')}`);
    }
    if (options.model !== undefined && !MODEL_PATTERN.test(options.model)) {
      throw new Error('--model must be in provider/model format');
    }
    if (options.concurrency !== undefined) {
      const concurrency = Number(options.concurrency);
      if (!/^\d+$/.test(options.concurrency) || !isConcurrency(concurrency)) {
        throw new Error(`--concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`);
      }
      options.concurrency = concurrency;
    }
    if (options.diff && (options.base || options.head || options['merge-base'])) {
      throw new Error('--diff cannot be combined with Git ref flags');
    }
  } catch (err) {
    console.error(`${err.message}\n${usage}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage);
    return;
  }
  const repoRoot = path.resolve(repoPath || process.env.REPO_DIR || process.cwd());
  let config;
  try {
    config = loadConfig({
      repoRoot,
      configPath: options.config,
      overrides: { severityGate: options.gate, model: options.model, concurrency: options.concurrency },
    });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`[OpenCodeReviewer] ${err.message}`);
    process.exitCode = 2;
    return;
  }
  await ciMode(repoRoot, options, config);
}

main().catch((err) => {
  console.error('[OpenCodeReviewer] fatal:', err?.stack || err);
  process.exit(3);
});
