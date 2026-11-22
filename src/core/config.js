import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWithin } from './match.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_FILE = 'review.config.json';

export const SEVERITY_ORDER = ['info', 'minor', 'major', 'critical'];
export const MODEL_PATTERN = /^[\w.][\w.-]*\/[^\s\0]+$/;

const DEFAULTS = {
  model: 'deepseek/deepseek-flash',
  severityGate: 'major',
  contextFile: 'REVIEW_CONTEXT.md',
  contextFileAliases: ['REVIEW_CONTEXT.md', 'ARCHITECTURE.md', 'docs/ARCHITECTURE.md'],
  contextFileRequired: false,
  concurrency: 3,
  batch: { maxFiles: 6, maxBytes: 48000 },
  diff: { maxHunkBytesPerCall: 48000 },
  include: ['**/*.{js,jsx,ts,tsx,mjs,cjs,py,go,rb,rs,java,kt,php,c,cc,cpp,h,hpp,cs,swift,scala,sh,sql,vue,svelte}'],
  exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/*.min.*'],
};

// The reviewed code can change these keys in its own review.config.json. The
// model, gate and contextFileRequired decide whether a review passes, and
// concurrency sets the request rate, so only the operator sets them: bundled
// file, --config, environment or flags.
const REPO_KEYS = ['contextFile', 'contextFileAliases', 'batch', 'diff', 'include', 'exclude'];

const isText = (v) => typeof v === 'string' && v.length > 0;
const isTextList = (v) => Array.isArray(v) && v.every(isText);
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
export const MAX_CONCURRENCY = 16;
export const isConcurrency = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_CONCURRENCY;
const RULES = {
  model: [(v) => typeof v === 'string' && MODEL_PATTERN.test(v), 'in provider/model format'],
  severityGate: [(v) => SEVERITY_ORDER.includes(v), `one of ${SEVERITY_ORDER.join(', ')}`],
  contextFile: [isText, 'a nonempty string'],
  contextFileAliases: [isTextList, 'a list of nonempty strings'],
  contextFileRequired: [(v) => typeof v === 'boolean', 'true or false'],
  concurrency: [isConcurrency, `an integer from 1 to ${MAX_CONCURRENCY}`],
  include: [isTextList, 'a list of nonempty strings'],
  exclude: [isTextList, 'a list of nonempty strings'],
  'batch.maxFiles': [isPositiveInt, 'a positive integer'],
  'batch.maxBytes': [isPositiveInt, 'a positive integer'],
  'diff.maxHunkBytesPerCall': [isPositiveInt, 'a positive integer'],
};

/** Invalid configuration: callers report the message and exit 2. */
export class ConfigError extends Error {}

/**
 * Build the effective config. Later layers win: built-in defaults, the bundled
 * review.config.json, the reviewed repo's review.config.json (REPO_KEYS only),
 * the `configPath` file, environment variables, then `overrides`.
 * The result lists the files read in `sources` and ignored repo keys in `warnings`.
 */
export function loadConfig({ repoRoot, configPath, overrides = {} } = {}) {
  const sources = [];
  const warnings = [];
  let cfg = merge(DEFAULTS, {});

  const bundledPath = path.join(ROOT, CONFIG_FILE);
  const bundled = readConfigFile(bundledPath, { optional: true });
  if (bundled) {
    cfg = merge(cfg, bundled);
    sources.push(bundledPath);
  }

  const repoPath = repoRoot && findRepoConfig(repoRoot);
  if (repoPath && repoPath !== (bundled && fs.realpathSync(bundledPath))) {
    const repo = readConfigFile(repoPath);
    const ignored = Object.keys(repo).filter((key) => !REPO_KEYS.includes(key));
    if (ignored.length) {
      warnings.push(`${repoPath}: ignored ${ignored.join(', ')}. Set these with --config, environment variables or flags.`);
    }
    cfg = merge(cfg, Object.fromEntries(Object.entries(repo).filter(([key]) => REPO_KEYS.includes(key))));
    sources.push(repoPath);
  }

  if (configPath) {
    const file = path.resolve(configPath);
    cfg = merge(cfg, readConfigFile(file));
    sources.push(file);
  }

  if (process.env.OC_MODEL) cfg.model = process.env.OC_MODEL;
  if (process.env.SEVERITY_GATE !== undefined) cfg.severityGate = process.env.SEVERITY_GATE;
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) cfg[key] = value;
  }

  if (!SEVERITY_ORDER.includes(cfg.severityGate)) {
    throw new ConfigError(`Invalid severity gate: ${cfg.severityGate}. Use ${SEVERITY_ORDER.join(', ')}.`);
  }
  if (!isConcurrency(cfg.concurrency)) {
    throw new ConfigError(`Invalid concurrency: ${cfg.concurrency}. Use an integer from 1 to ${MAX_CONCURRENCY}.`);
  }
  if (!MODEL_PATTERN.test(cfg.model)) {
    throw new ConfigError(`Invalid model: ${cfg.model}. Use provider/model format.`);
  }
  return { ...cfg, sources, warnings };
}

function merge(cfg, layer) {
  return {
    ...cfg,
    ...layer,
    batch: { ...cfg.batch, ...layer.batch },
    diff: { ...cfg.diff, ...layer.diff },
  };
}

/** The repo's own config file, or null. Symlinks out of the repo are ignored. */
function findRepoConfig(repoRoot) {
  try {
    const file = resolveWithin(repoRoot, path.join(repoRoot, CONFIG_FILE));
    return file && fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function readConfigFile(file, { optional = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (optional && err.code === 'ENOENT') return null;
    throw new ConfigError(`Could not read config file ${file}: ${err.code || err.message}`);
  }
  let layer;
  try {
    layer = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${err.message}`);
  }
  validateLayer(layer, file);
  return layer;
}

function validateLayer(layer, file) {
  if (!isPlainObject(layer)) throw new ConfigError(`${file} must contain a JSON object.`);
  const entries = [];
  for (const [key, value] of Object.entries(layer)) {
    if (key === 'batch' || key === 'diff') {
      if (!isPlainObject(value)) throw new ConfigError(`${file}: ${key} must be an object.`);
      for (const [sub, subValue] of Object.entries(value)) entries.push([`${key}.${sub}`, subValue]);
    } else {
      entries.push([key, value]);
    }
  }
  for (const [key, value] of entries) {
    const rule = RULES[key];
    if (!rule) throw new ConfigError(`${file}: unknown key ${key}.`);
    const [isValid, expected] = rule;
    if (!isValid(value)) throw new ConfigError(`${file}: ${key} must be ${expected}.`);
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True if `severity` is at or above the configured gate. */
export function meetsGate(severity, gate) {
  const s = SEVERITY_ORDER.indexOf(severity);
  const g = SEVERITY_ORDER.indexOf(gate);
  return s >= 0 && g >= 0 && s >= g;
}

export { ROOT };
