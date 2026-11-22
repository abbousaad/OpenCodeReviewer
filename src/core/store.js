import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

/** State that survives restarts: the password hash now, settings and runs later. */
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

/** Parse a JSON file in DATA_DIR, or return null when it does not exist. */
export function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Write through a temporary file so a crash never leaves a partial file. */
export function writeJson(name, value, mode = 0o600) {
  const file = path.join(DATA_DIR, name);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode });
  fs.renameSync(temp, file);
}
