import fs from 'node:fs';
import path from 'node:path';
import { resolveWithin } from './match.js';

export const MISSING_CONTEXT_WARNING =
  'No review context file found. Add `BUSINESS_LOGIC.md` for business rules or ' +
  '`REVIEW_CONTEXT.md` for project context. See README for examples.';

const BUSINESS_LOGIC_FILE = 'BUSINESS_LOGIC.md';

/**
 * Read business rules and the first available project context file from `repoRoot`.
 * Returns { found, path, paths, text, warning }.
 */
export function readContextFile(repoRoot, config) {
  const candidates = config.contextFileAliases?.length
    ? config.contextFileAliases
    : [config.contextFile];

  const files = [];
  for (const rel of candidates) {
    const file = readContext(repoRoot, rel);
    if (file) {
      files.push(file);
      break;
    }
  }

  const businessLogic = readContext(repoRoot, BUSINESS_LOGIC_FILE);
  if (businessLogic && !files.some((file) => file.absolutePath === businessLogic.absolutePath)) {
    files.push(businessLogic);
  }
  const paths = files.map((file) => file.path);
  const text = files.length > 1
    ? files.map((file) => `--- CONTEXT FILE: ${file.path} ---\n${file.text}`).join('\n\n')
    : (files[0]?.text ?? '');
  return {
    found: files.length > 0,
    path: paths[0] ?? null,
    paths,
    text,
    warning: files.length ? null : MISSING_CONTEXT_WARNING,
  };
}

function readContext(repoRoot, rel) {
  try {
    const absolutePath = resolveWithin(repoRoot, path.resolve(repoRoot, rel));
    if (absolutePath && fs.statSync(absolutePath).isFile()) {
      return { path: rel, absolutePath, text: fs.readFileSync(absolutePath, 'utf8') };
    }
  } catch {
    // An absent or unreadable file cannot provide context.
  }
  return null;
}
