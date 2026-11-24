import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJson, writeJson } from './store.js';

/**
 * Saved review runs: one JSON file per run in DATA_DIR/runs, plus a usage
 * ledger that keeps the all-time spend after old runs are pruned.
 */
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const USAGE_FILE = 'usage.json';
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Run ids become file names, so only random UUIDs are accepted. */
export const isRunId = (id) => typeof id === 'string' && RUN_ID.test(id);

function runFile(id) {
  if (!isRunId(id)) throw new Error('Invalid run id.');
  return path.join(RUNS_DIR, `${id}.json`);
}

export function saveRun(run) {
  fs.mkdirSync(RUNS_DIR, { recursive: true, mode: 0o700 });
  const file = runFile(run.id);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(run) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function loadRun(id) {
  if (!isRunId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(runFile(id), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function deleteRun(id) {
  try {
    fs.unlinkSync(runFile(id));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/** Every readable saved run. Unreadable files are skipped and reported. */
export function loadAllRuns() {
  let names;
  try {
    names = fs.readdirSync(RUNS_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const runs = [];
  for (const name of names) {
    const id = name.replace(/\.json$/, '');
    if (!name.endsWith('.json') || !isRunId(id)) continue;
    try {
      const run = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, name), 'utf8'));
      if (run?.id === id) runs.push(run);
    } catch (err) {
      console.error(`[OpenCodeReviewer] skipped unreadable run ${name}: ${err.message}`);
    }
  }
  return runs;
}

const emptyTotals = () => ({ costUsd: 0, inputTokens: 0, outputTokens: 0, runs: 0, partial: false });

function addTo(totals, usage) {
  totals.runs += 1;
  totals.costUsd += usage?.costUsd ?? 0;
  totals.inputTokens += usage?.inputTokens ?? 0;
  totals.outputTokens += usage?.outputTokens ?? 0;
  totals.partial ||= !usage || usage.partial || usage.costUsd == null;
}

/** Add one finished run's usage to the all-time and monthly totals. */
export function recordUsage(usage, finishedAt = new Date().toISOString(), repoId = null) {
  const ledger = readUsage();
  const month = finishedAt.slice(0, 7);
  addTo(ledger.allTime, usage);
  addTo((ledger.months[month] ??= emptyTotals()), usage);
  if (repoId) addTo((ledger.repos[repoId] ??= emptyTotals()), usage);
  writeJson(USAGE_FILE, ledger);
}

export function readUsage() {
  const saved = readJson(USAGE_FILE);
  return {
    allTime: { ...emptyTotals(), ...saved?.allTime },
    months: saved?.months ?? {},
    repos: saved?.repos ?? {},
  };
}
