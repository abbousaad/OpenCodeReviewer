import fs from 'node:fs';
import path from 'node:path';
import { SEVERITY_ORDER, meetsGate } from './config.js';
import { sumUsage } from './opencodeClient.js';

const SEVERITY_EMOJI = { critical: '🟥', major: '🟧', minor: '🟨', info: '🟦' };

/**
 * Aggregate review-unit results into a structured report + markdown.
 * @returns {object} report
 */
export function buildReport({ mode, meta, results, contextWarning, config }) {
  const findings = [];
  const summaries = [];
  const errors = [];

  for (const r of results) {
    for (const f of r.findings || []) findings.push(f);
    if (r.summary) summaries.push({ label: r.label, summary: r.summary });
    if (r.error) errors.push({ label: r.label, error: r.error });
  }

  const counts = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  const maxSeverity = highestSeverity(findings);
  const gateFailed = findings.some((f) => meetsGate(f.severity, config.severityGate));

  return {
    mode,
    generatedAt: new Date().toISOString(),
    model: config.model,
    severityGate: config.severityGate,
    meta,
    contextWarning: contextWarning || null,
    counts,
    maxSeverity,
    gateFailed,
    status: errors.length ? 'incomplete' : 'complete',
    totalFindings: findings.length,
    usage: sumUsage(results.map(result => result.usage)),
    findings: sortFindings(findings),
    summaries,
    errors,
  };
}

function highestSeverity(findings) {
  let max = null;
  for (const f of findings) {
    if (!max || SEVERITY_ORDER.indexOf(f.severity) > SEVERITY_ORDER.indexOf(max)) max = f.severity;
  }
  return max;
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const s = SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity);
    if (s !== 0) return s;
    return String(a.file).localeCompare(String(b.file));
  });
}

/** Warning for files whose over-long lines were clipped before review. */
export function truncationWarning(files) {
  return `Lines over the batch size limit were clipped before review in: ${files.join(', ')}`;
}

/** Render the report as markdown. */
export function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Code Review Report`);
  lines.push('');
  lines.push(`- **Mode:** ${report.mode}`);
  lines.push(`- **Model:** ${report.model}`);
  lines.push(`- **Generated:** ${report.generatedAt}`);
  if (report.meta?.description) lines.push(`- **Scope:** ${report.meta.description}`);
  const gateStatus = report.errors.length ? '⚠️ review incomplete' : report.gateFailed ? '❌ FAILED' : '✅ passed';
  lines.push(`- **Severity gate:** \`${report.severityGate}\` → ${gateStatus}`);
  const { totalTokens, inputTokens, outputTokens, costUsd, partial } = report.usage ?? {};
  const tokens = totalTokens == null
    ? 'Unavailable'
    : `${totalTokens.toLocaleString('en-US')} (${inputTokens.toLocaleString('en-US')} input, ${outputTokens.toLocaleString('en-US')} output)`;
  const cost = costUsd == null ? 'Unavailable' : costUsd.toLocaleString('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 8,
  });
  lines.push(`- **Tokens:** ${tokens}`);
  lines.push(`- **Estimated review cost (USD):** ${cost}`);
  if (partial) lines.push('- Some usage or pricing data was unavailable.');
  lines.push('');

  if (report.contextWarning) {
    lines.push(`> ⚠️ **${report.contextWarning}**`);
    lines.push('');
  }
  if (report.meta?.truncatedFiles?.length) {
    lines.push(`> ⚠️ **${truncationWarning(report.meta.truncatedFiles)}**`);
    lines.push('');
  }

  lines.push(`## Summary`);
  lines.push('');
  if (report.errors.length) {
    lines.push(`**Review incomplete.** Failed batches: ${report.errors.length}.`);
  }
  if (!report.errors.length || report.totalFindings) {
    const scope = report.errors.length ? ' in completed batches' : '';
    lines.push(
      `Found **${report.totalFindings}** finding(s)${scope}. ` +
        `${report.counts.critical} critical, ${report.counts.major} major, ` +
        `${report.counts.minor} minor, ${report.counts.info} info.`
    );
  }
  lines.push('');

  if (report.findings.length) {
    lines.push(`## Findings`);
    lines.push('');
    for (const f of report.findings) {
      const emoji = SEVERITY_EMOJI[f.severity] || '•';
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`### ${emoji} [${f.severity}] ${loc} — ${f.category}`);
      lines.push('');
      lines.push(f.message);
      if (f.suggestion) {
        lines.push('');
        lines.push(`**Suggestion:** ${f.suggestion}`);
      }
      lines.push('');
    }
  } else if (!report.errors.length) {
    lines.push('No issues found. ✅');
    lines.push('');
  }

  if (report.summaries.length) {
    lines.push('## Batch summaries');
    lines.push('');
    for (const { label, summary } of report.summaries) {
      lines.push(`### ${label}`, '', summary, '');
    }
  }

  if (report.errors.length) {
    lines.push(`## Review Errors`);
    lines.push('');
    for (const e of report.errors) lines.push(`- \`${e.label}\`: ${e.error}`);
    lines.push('');
  }

  return lines.join('\n');
}

/** Write report.json and report.md to `outDir`. Returns the file paths. */
export function writeReportFiles(report, outDir = process.cwd()) {
  const jsonPath = path.join(outDir, 'review-report.json');
  const mdPath = path.join(outDir, 'review-report.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(report));
  return { jsonPath, mdPath };
}
