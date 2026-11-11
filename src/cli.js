#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './core/config.js';
import { detectGitContext } from './core/gitContext.js';
import { computeDiffUnits } from './core/diff.js';
import { computePatchUnits } from './core/patch.js';
import { readContextFile } from './core/contextFile.js';
import { reviewDiffUnit, runUnits } from './core/reviewer.js';
import { buildReport, writeReportFiles, renderMarkdown } from './core/report.js';

async function ciMode(repoRoot, options) {
  const config = loadConfig();
  console.log(`[OpenCodeReviewer] CI review of ${repoRoot}`);
  console.log(`[OpenCodeReviewer] model=${config.model} gate=${config.severityGate}`);

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

  let results = [];
  if (units.length) {
    const runnable = units.map((u) => ({
      label: u.label,
      run: () => reviewDiffUnit(u, { config, contextText: context.text }),
    }));
    results = await runUnits(runnable, {
      onProgress: (p) => {
        if (p.phase === 'done') {
          const tag = p.error ? `error: ${p.error}` : `${p.findingCount} finding(s)`;
          console.log(`[OpenCodeReviewer] [${p.index + 1}/${p.total}] ${p.label} — ${tag}`);
        }
      },
    });
  }

  const report = buildReport({
    mode: 'ci',
    meta: { description: ctx.description, kind: ctx.kind, changedFiles: files },
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

async function main() {
  const usage = 'Usage: opencodereviewer ci [repoPath] [--base <ref> [--head <ref>] [--merge-base] | --diff <file>]';
  let options, cmd, repoPath;
  try {
    const { values, positionals } = parseArgs({
      options: {
        base: { type: 'string' },
        head: { type: 'string' },
        'merge-base': { type: 'boolean' },
        diff: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
    [cmd, repoPath] = positionals;
    options = values;
    if ((cmd && cmd !== 'ci') || positionals.length > 2) {
      throw new Error('Expected the ci command and at most one repository path');
    }
    if ([options.base, options.head, options.diff].includes('')) {
      throw new Error('--base, --head and --diff require nonempty values');
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
  await ciMode(repoRoot, options);
}

main().catch((err) => {
  console.error('[OpenCodeReviewer] fatal:', err?.stack || err);
  process.exit(3);
});
