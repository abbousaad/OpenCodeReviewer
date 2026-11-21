import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { buildMatcher, resolveWithin } from './match.js';
import { splitLines } from './chunk.js';

/**
 * Walk `repoRoot`, select reviewable files via config globs, and split them
 * into size-bounded batches for standalone full-codebase review.
 * Files over the byte limit are split into line ranges. Lines longer than the
 * limit are clipped and listed in `truncated`.
 * Returns { files, batches, truncated } where batch = { label, files: [{ path, content }] }.
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
  const truncated = [];

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

    // Oversized single file: one batch per line range so every line is reviewed.
    if (size > maxBytes) {
      flush();
      const chunks = splitLines(content, maxBytes);
      const totalLines = chunks.at(-1).endLine;
      for (const chunk of chunks) {
        const range = { startLine: chunk.startLine, endLine: chunk.endLine, totalLines };
        batches.push({
          label: `${rel} (lines ${chunk.startLine}-${chunk.endLine} of ${totalLines})`,
          files: [{ path: rel, content: chunk.text, ...range }],
        });
      }
      if (chunks.some((c) => c.truncated)) truncated.push(rel);
      continue;
    }
    if (current.files.length >= maxFiles || current.bytes + size > maxBytes) flush();
    current.files.push({ path: rel, content });
    current.bytes += size;
  }
  flush();

  return { files, batches, truncated };
}
