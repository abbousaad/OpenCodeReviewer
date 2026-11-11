import fs from 'node:fs/promises';
import path from 'node:path';
import { batchDiffs } from './diff.js';
import { buildMatcher } from './match.js';

export async function computePatchUnits(patchFile, config) {
  const patch = await fs.readFile(patchFile, 'utf8');
  const match = buildMatcher({ include: config.include, exclude: config.exclude });
  const diffs = parseUnifiedDiff(patch).filter(({ file }) => match(file));
  return {
    files: [...new Set(diffs.map(({ file }) => file))],
    units: batchDiffs(diffs, config.diff.maxHunkBytesPerCall),
  };
}

function parseUnifiedDiff(patch) {
  const diffs = [];
  const lines = patch.split(/\r?\n/);
  let gitHeader = false;
  let section;
  let oldLines = 0;
  let newLines = 0;

  const finishSection = () => {
    if (!section) return;
    if (!section.hunks) throw new Error('Unified diff file has no text hunks: ' + section.file);
    diffs.push({ file: section.file, diffText: section.lines.join('\n') + '\n' });
    section = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (oldLines || newLines) {
      if (line === '\\ No newline at end of file') {
        section.lines.push(line);
        continue;
      }
      const prefix = line[0];
      if (![' ', '-', '+'].includes(prefix)) throw new Error('Incomplete unified diff hunk');
      if (prefix !== '+') oldLines--;
      if (prefix !== '-') newLines--;
      if (oldLines < 0 || newLines < 0) throw new Error('Invalid unified diff hunk line count');
      section.lines.push(line);
      continue;
    }

    if (line.startsWith('diff --git ') || line.startsWith('Index: ')) {
      finishSection();
      gitHeader = /^diff --git "?a\/.* "?b\//.test(line);
    } else if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      finishSection();
      const from = readPatchPath(line.slice(4), gitHeader ? 'a/' : '');
      const to = readPatchPath(lines[++i].slice(4), gitHeader ? 'b/' : '');
      const file = to ?? from;
      if (!file) throw new Error('Unified diff has no file path');
      section = {
        file,
        lines: ['--- ' + (from ?? '/dev/null'), '+++ ' + (to ?? '/dev/null')],
        hunks: 0,
      };
      gitHeader = false;
    } else if (line.startsWith('@@')) {
      const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/.exec(line);
      if (!section || !header) throw new Error('Invalid unified diff hunk header');
      oldLines = Number(header[1] ?? 1);
      newLines = Number(header[2] ?? 1);
      section.hunks++;
      section.lines.push(line);
    } else if (line === '\\ No newline at end of file' && section) {
      section.lines.push(line);
    } else if (line === 'GIT binary patch' || /^Binary files .* differ$/.test(line)) {
      throw new Error('Unified diff input supports text changes only');
    }
  }

  if (oldLines || newLines) throw new Error('Incomplete unified diff hunk');
  finishSection();
  if (patch.trim() && !diffs.length) throw new Error('No text hunks found in unified diff');
  return diffs;
}

function readPatchPath(header, prefix) {
  // Conventional unified diffs separate a filename and timestamp with a tab.
  let file = header.split('\t', 1)[0];
  if (file === '/dev/null') return null;
  if (file.startsWith('"') && file.endsWith('"')) {
    // Git can represent UTF-8 path bytes as octal escapes.
    const escaped = file.slice(1, -1).replace(/\\([0-7]{3}|["\\abfnrtv])|([^\x00-\x7f]+)/gu,
      (_, code, unicode) => unicode ? Buffer.from(unicode).toString('latin1') :
        /^[0-7]/.test(code) ? String.fromCharCode(parseInt(code, 8)) :
          ({ a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }[code] ?? code));
    file = Buffer.from(escaped, 'latin1').toString('utf8');
  }
  if (prefix && file.startsWith(prefix)) file = file.slice(prefix.length);
  if (!file || path.posix.isAbsolute(file) || path.win32.isAbsolute(file) ||
      file.split(/[\\/]/).includes('..') || /[\0\r\n]/.test(file)) {
    throw new Error('Unified diff paths must be relative to the repository');
  }
  return file.replace(/^\.\//, '');
}
