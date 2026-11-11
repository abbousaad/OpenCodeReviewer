import { simpleGit } from 'simple-git';
import { buildMatcher } from './match.js';

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

    // A single oversized file diff gets its own (truncated) unit.
    if (size > maxBytes) {
      flush();
      units.push({
        label: `${file} (truncated)`,
        diffText: diffText.slice(0, maxBytes),
        files: [file],
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
