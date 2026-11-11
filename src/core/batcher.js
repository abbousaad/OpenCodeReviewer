import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { buildMatcher, resolveWithin } from './match.js';

/**
 * Walk `repoRoot`, select reviewable files via config globs, and split them
 * into size-bounded batches for standalone full-codebase review.
 * Returns { files, batches } where batch = { label, files: [{ path, content }] }.
 */
export async function buildBatches(repoRoot, config) {
  const match = buildMatcher({ include: config.include, exclude: config.exclude });

  const all = await fg(config.include, {
    cwd: repoRoot,
    ignore: config.exclude,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  });
  const files = [];

  const { maxFiles, maxBytes } = config.batch;
  const batches = [];
  let current = { files: [], bytes: 0 };

  const flush = () => {
    if (!current.files.length) return;
    const names = current.files.map((f) => f.path);
    batches.push({
      label: names.length === 1 ? names[0] : `${names.length} files (${names[0]} …)`,
      files: current.files,
    });
    current = { files: [], bytes: 0 };
  };

  for (const rel of all.filter(match).sort()) {
    let content;
    try {
      const abs = resolveWithin(repoRoot, path.join(repoRoot, rel));
      if (!abs || !fs.statSync(abs).isFile()) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    files.push(rel);
    const size = Buffer.byteLength(content, 'utf8');

    // Oversized single file: truncate into its own batch.
    if (size > maxBytes) {
      flush();
      batches.push({
        label: `${rel} (truncated)`,
        files: [{ path: rel, content: content.slice(0, maxBytes) }],
      });
      continue;
    }
    if (current.files.length >= maxFiles || current.bytes + size > maxBytes) flush();
    current.files.push({ path: rel, content });
    current.bytes += size;
  }
  flush();

  return { files, batches };
}
