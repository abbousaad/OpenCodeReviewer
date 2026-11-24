import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SETTINGS_KEYS, configErrors, loadConfig } from './config.js';
import { readJson, writeJson } from './store.js';

const SETTINGS_FILE = 'settings.json';
const SECRETS_FILE = 'secrets.json';

// Write-only values. `env` names the variable that supplies each one instead.
export const SECRETS = {
  deepseekApiKey: { env: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key' },
  githubToken: { env: null, label: 'GitHub token' },
};

// Settings that an environment variable fixes; the page shows them read-only.
const LOCKED_BY = { model: 'OC_MODEL', severityGate: 'SEVERITY_GATE', maxParallelReviews: 'MAX_PARALLEL_REVIEWS',
  timeoutSeconds: 'OC_TIMEOUT_MS' };

export function readSettings() {
  return readJson(SETTINGS_FILE) ?? {};
}

function readSecrets() {
  return readJson(SECRETS_FILE) ?? {};
}

/** One saved secret, for server-side use only. */
export function readSecret(key) {
  return readSecrets()[key] || null;
}

export function lockedSettings() {
  return Object.fromEntries(Object.entries(LOCKED_BY).filter(([, name]) => process.env[name] !== undefined));
}

/** The settings page view: effective values, locks and secret status, never secret values. */
export function settingsView() {
  const config = loadConfig({ settings: readSettings() });
  const secrets = readSecrets();
  return {
    settings: Object.fromEntries(SETTINGS_KEYS.map((key) => [key, config[key]])),
    locked: lockedSettings(),
    secrets: Object.fromEntries(Object.entries(SECRETS).map(([key, { env, label }]) => [key, {
      label,
      set: Boolean(secrets[key]) || Boolean(env && process.env[env]),
      fromEnv: Boolean(env && process.env[env]),
    }])),
    models: availableModels(),
  };
}

/**
 * Save settings and secrets. In `settings`, null resets a key to its default.
 * In `secrets`, a string sets a value and null clears it.
 * Returns { fields } with a message per invalid key, or null on success.
 */
export function saveSettings({ settings = {}, secrets = {} } = {}) {
  const fields = {};
  if (!isPlainObject(settings) || !isPlainObject(secrets)) return { fields: { '': 'Send settings and secrets as objects.' } };

  const next = { ...readSettings() };
  for (const [key, value] of Object.entries(settings)) {
    if (!SETTINGS_KEYS.includes(key)) fields[key] = 'is not a setting';
    else if (LOCKED_BY[key] && process.env[LOCKED_BY[key]] !== undefined) fields[key] = `is set by ${LOCKED_BY[key]}`;
    else if (value === null) delete next[key];
    else next[key] = value;
  }
  for (const { key, message } of configErrors(next)) fields[key] ??= message;

  const nextSecrets = { ...readSecrets() };
  for (const [key, value] of Object.entries(secrets)) {
    const secret = SECRETS[key];
    if (!secret) fields[`secrets.${key}`] = 'is not a secret';
    else if (secret.env && process.env[secret.env]) fields[`secrets.${key}`] = `is set by ${secret.env}`;
    else if (value === null) delete nextSecrets[key];
    else if (typeof value !== 'string' || !/^\S{1,1024}$/.test(value)) {
      fields[`secrets.${key}`] = 'must be 1 to 1024 characters with no spaces';
    } else nextSecrets[key] = value;
  }

  if (Object.keys(fields).length) return { fields };
  writeJson(SETTINGS_FILE, next);
  writeJson(SECRETS_FILE, nextSecrets);
  return null;
}

/** Saved secrets for the OpenCode subprocess, for variables the environment leaves unset. */
export function providerEnv() {
  const secrets = readSecrets();
  const env = {};
  for (const [key, { env: name }] of Object.entries(SECRETS)) {
    if (name && secrets[key] && !process.env[name]) env[name] = secrets[key];
  }
  return env;
}

/** provider/model ids configured in opencode.json. */
function availableModels() {
  try {
    const file = process.env.OPENCODE_CONFIG || path.join(ROOT, 'opencode.json');
    const { provider = {} } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.entries(provider).flatMap(([id, p]) => Object.entries(p.models ?? {})
      .map(([model, m]) => ({ id: `${id}/${model}`, name: m.name || model })));
  } catch {
    return [];
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
