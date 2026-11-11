import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

/** Resolve a path and reject symlinks or traversal that escape the root. */
export function resolveWithin(root, candidate) {
  const realRoot = fs.realpathSync(root);
  const resolved = fs.realpathSync(candidate);
  const relative = path.relative(realRoot, resolved);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? null
    : resolved;
}

/**
 * Build a predicate that returns true when a path should be reviewed:
 * matches at least one include pattern and no exclude pattern.
 */
export function buildMatcher({ include = ['**/*'], exclude = [] }) {
  const isIncluded = picomatch(include, { dot: true });
  const isExcluded = exclude.length ? picomatch(exclude, { dot: true }) : () => false;
  return (p) => {
    const norm = p.replace(/\\/g, '/');
    return isIncluded(norm) && !isExcluded(norm);
  };
}
