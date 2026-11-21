import { simpleGit } from 'simple-git';
import { buildMatcher } from './match.js';
import { clipBytes } from './chunk.js';

// Stable SHA of the empty git tree — used to diff an initial commit.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Compute the changed-file diffs for a git context, filtered by config globs,
 * grouped into byte-bounded units suitable for a single model call.
 * Returns { files, units } where each unit = { label, diffText, files }.
 */
export async function computeDiffUnits(repoRoot, ctx, config) {
  const git = simpleGit({ baseDir: repoRoot });
  const match = buildMatcher({ include: config.include, exclude: config.exclude });

  const range = diffRange(ctx);
  const nameArgs = ['diff', '--name-only', '-z', ...range, '--'];
  const raw = await git.raw(nameArgs);
  const files = raw.split('\0').filter(Boolean).filter(match);
  const diffs = [];
  for (const file of files) {
    const diffText = await git.raw(['diff', ...range, '--', `:(literal)${file}`]);
    diffs.push({ file, diffText });
  }
  return { files, units: batchDiffs(diffs, config.diff.maxHunkBytesPerCall) };
}

export function batchDiffs(diffs, maxBytes) {
  const units = [];
  let current = { files: [], parts: [], bytes: 0 };

  const flush = () => {
    if (!current.files.length) return;
    units.push({
      label: current.files.length === 1 ? current.files[0] : `${current.files.length} files`,
      diffText: current.parts.join('\n'),
      files: current.files.slice(),
    });
    current = { files: [], parts: [], bytes: 0 };
  };

  for (const { file, diffText } of diffs) {
    if (!diffText.trim()) continue;
    const size = Buffer.byteLength(diffText, 'utf8');

    // An oversized file diff is split into parts that each repeat the file header.
    if (size > maxBytes) {
      flush();
      const parts = splitFileDiff(diffText, maxBytes);
      parts.forEach((part, i) => {
        units.push({
          label: `${file} (part ${i + 1}/${parts.length})`,
          diffText: part.text,
          files: [file],
          truncated: part.truncated,
        });
      });
      continue;
    }
    if (current.bytes + size > maxBytes) flush();
    current.files.push(file);
    current.parts.push(diffText);
    current.bytes += size;
  }
  flush();

  return units;
}

/**
 * Split one file's diff into parts of at most `maxBytes`, each starting with the
 * file header. Hunks over the budget become smaller hunks with recomputed line
 * ranges. Only a single line over the budget is clipped (`truncated`).
 */
function splitFileDiff(diffText, maxBytes) {
  const lines = diffText.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const first = lines.findIndex((line) => line.startsWith('@@'));
  if (first < 0) return [{ text: clipBytes(diffText, maxBytes), truncated: true }];

  const header = lines.slice(0, first).map((line) => line + '\n').join('');
  const budget = Math.max(maxBytes - Buffer.byteLength(header, 'utf8'), 1);
  const hunks = [];
  let hunk;
  for (const line of lines.slice(first)) {
    if (line.startsWith('@@')) {
      if (hunk) hunks.push(...splitHunk(hunk, budget));
      hunk = { header: line, body: [] };
    } else {
      hunk.body.push(line);
    }
  }
  hunks.push(...splitHunk(hunk, budget));

  const parts = [];
  let current;
  for (const { text, truncated } of hunks) {
    const size = Buffer.byteLength(text, 'utf8');
    if (current && current.bytes + size > budget) {
      parts.push(current);
      current = undefined;
    }
    current ??= { text: header, bytes: 0, truncated: false };
    current.text += text;
    current.bytes += size;
    current.truncated ||= truncated;
  }
  parts.push(current);
  return parts.map(({ text, truncated }) => ({ text, truncated }));
}

function splitHunk({ header, body }, budget) {
  const text = [header, ...body].map((line) => line + '\n').join('');
  const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(header);
  if (Buffer.byteLength(text, 'utf8') <= budget) return [{ text, truncated: false }];
  if (!range) return [{ text: clipBytes(text, budget), truncated: true }];

  // Track the next old/new line number; a zero-count range names the line before.
  let oldNext = Number(range[1]) + (range[2] === '0' ? 1 : 0);
  let newNext = Number(range[3]) + (range[4] === '0' ? 1 : 0);
  const section = range[5];
  // Reserve room for the rewritten header; later starts can need more digits.
  const lineBudget = Math.max(budget - Buffer.byteLength(header + '\n', 'utf8') - 32, 1);
  const pieces = [];
  let piece;

  const flush = () => {
    if (!piece) return;
    const span = (start, count) => `${count ? start : start - 1},${count}`;
    const head = `@@ -${span(piece.oldStart, piece.oldCount)} +${span(piece.newStart, piece.newCount)} @@${section}\n`;
    pieces.push({ text: head + piece.lines.join(''), truncated: piece.truncated });
    piece = undefined;
  };

  for (let line of body) {
    let size = Buffer.byteLength(line + '\n', 'utf8');
    let truncated = false;
    if (size > lineBudget) {
      line = clipBytes(line, lineBudget - 1);
      size = Buffer.byteLength(line + '\n', 'utf8');
      truncated = true;
    }
    if (piece && piece.bytes + size > lineBudget) flush();
    piece ??= { lines: [], bytes: 0, oldStart: oldNext, newStart: newNext, oldCount: 0, newCount: 0, truncated: false };
    piece.lines.push(line + '\n');
    piece.bytes += size;
    piece.truncated ||= truncated;
    if (line[0] !== '+' && line[0] !== '\\') {
      piece.oldCount++;
      oldNext++;
    }
    if (line[0] !== '-' && line[0] !== '\\') {
      piece.newCount++;
      newNext++;
    }
  }
  flush();
  return pieces;
}

function diffRange(ctx) {
  switch (ctx.kind) {
    case 'pull_request':
      // three-dot: changes on head since the merge-base with base
      return [`${ctx.base}...${ctx.head}`];
    case 'initial':
      return [EMPTY_TREE, ctx.head];
    case 'push':
    case 'range':
    case 'commit':
    default:
      return [`${ctx.base}..${ctx.head}`];
  }
}
