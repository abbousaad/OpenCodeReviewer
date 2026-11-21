import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const DEFAULTS = {
  model: 'deepseek/deepseek-flash',
  severityGate: 'major',
  contextFile: 'REVIEW_CONTEXT.md',
  contextFileAliases: ['REVIEW_CONTEXT.md', 'ARCHITECTURE.md', 'docs/ARCHITECTURE.md'],
  contextFileRequired: false,
  batch: { maxFiles: 6, maxBytes: 48000 },
  diff: { maxHunkBytesPerCall: 48000 },
  include: ['**/*.{js,jsx,ts,tsx,mjs,cjs,py,go,rb,rs,java,kt,php,c,cc,cpp,h,hpp,cs,swift,scala,sh,sql,vue,svelte}'],
  exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/*.min.*'],
};

let cached = null;

/** Load review.config.json merged over defaults, with env overrides. */
export function loadConfig() {
  if (cached) return cached;
  let fileCfg = {};
  const cfgPath = path.join(ROOT, 'review.config.json');
  try {
    fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const cfg = { ...DEFAULTS, ...fileCfg, batch: { ...DEFAULTS.batch, ...fileCfg.batch }, diff: { ...DEFAULTS.diff, ...fileCfg.diff } };

  // Env overrides
  if (process.env.OC_MODEL) cfg.model = process.env.OC_MODEL;
  if (process.env.SEVERITY_GATE !== undefined) cfg.severityGate = process.env.SEVERITY_GATE;
  if (!SEVERITY_ORDER.includes(cfg.severityGate)) {
    throw new Error(`Invalid severity gate: ${cfg.severityGate}. Use ${SEVERITY_ORDER.join(', ')}.`);
  }

  cached = cfg;
  return cfg;
}

export const SEVERITY_ORDER = ['info', 'minor', 'major', 'critical'];

/** True if `severity` is at or above the configured gate. */
export function meetsGate(severity, gate) {
  const s = SEVERITY_ORDER.indexOf(severity);
  const g = SEVERITY_ORDER.indexOf(gate);
  return s >= 0 && g >= 0 && s >= g;
}

export { ROOT };
