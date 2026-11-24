import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { loadConfig } from './config.js';
import { readSettings } from './settings.js';
import { buildBatches } from './batcher.js';
import { readContextFile } from './contextFile.js';
import { reviewBatch, runUnits } from './reviewer.js';
import { buildReport, truncationWarning } from './report.js';
import { deleteRun, isRunId, loadAllRuns, loadRun, readUsage, recordUsage, saveRun } from './runs.js';

/**
 * Standalone review runs. Active runs (queued, running, cancelling) live in
 * memory with an event emitter for SSE subscribers. Every run is also saved
 * to disk, so finished runs survive restarts. At most `maxParallelReviews`
 * runs execute at once; the rest wait in a FIFO queue.
 */
const active = new Map();
const index = new Map();
const queue = [];
let running = 0;

const ACTIVE_STATUSES = ['queued', 'running', 'cancelling'];
const TERMINAL_EVENTS = ['complete', 'error', 'cancelled'];

export { TERMINAL_EVENTS };

/** Load saved runs. Runs that were active when the server stopped cannot resume. */
export function initRuns() {
  for (const run of loadAllRuns()) {
    if (ACTIVE_STATUSES.includes(run.status) || run.status === 'pending') {
      run.status = 'interrupted';
      run.error = 'The server stopped before this run finished.';
      run.finishedAt ??= new Date().toISOString();
      run.log = [...(run.log ?? []), { type: 'error', error: run.error, at: Date.now() }];
      saveRun(run);
    }
    index.set(run.id, summarize(run));
  }
  prune();
}

function limits() {
  try {
    const { maxParallelReviews, runsToKeep } = loadConfig({ settings: readSettings() });
    return { maxParallelReviews, runsToKeep };
  } catch {
    return { maxParallelReviews: 1, runsToKeep: 50 };
  }
}

/** A live run, or a saved one read from disk. */
export function getJob(id) {
  if (active.has(id)) return active.get(id);
  return isRunId(id) && index.has(id) ? loadRun(id) : null;
}

/** Lightweight summaries, newest first. */
export function listJobs() {
  for (const job of active.values()) index.set(job.id, summarize(job));
  return [...index.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function summarize(run) {
  const report = run.report;
  const position = run.status === 'queued' ? queue.indexOf(run.id) + 1 || null : null;
  return {
    id: run.id,
    repoRoot: run.repoRoot,
    repoId: run.repoId ?? null,
    repoName: run.repoName || path.basename(run.repoRoot),
    model: run.model,
    severityGate: run.severityGate,
    status: run.status,
    position,
    progress: run.progress,
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    error: run.error ?? null,
    files: run.files ?? null,
    counts: report?.counts ?? null,
    totalFindings: report?.totalFindings ?? null,
    gateFailed: report ? report.gateFailed : null,
    reportStatus: report?.status ?? null,
    usage: report?.usage ?? null,
  };
}

/** Full view of one run for the results page. */
export function publicView(run) {
  return { ...summarize(run), report: run.report ?? null, log: run.log ?? [] };
}

/** The serializable part of a run. */
function record(job) {
  const { emitter, controller, config, ...run } = job;
  return run;
}

function persist(job) {
  saveRun(record(job));
  index.set(job.id, summarize(job));
}

/** Queue a standalone review of `repoRoot` and start it when a slot is free. */
export function startReview({ repoRoot, overrides = {}, repoId = null, repoName = null }) {
  const id = randomUUID();
  const config = loadConfig({ repoRoot, settings: readSettings(), overrides });
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  const job = {
    id,
    repoRoot,
    repoId,
    repoName,
    model: config.model,
    severityGate: config.severityGate,
    status: 'queued',
    progress: { total: 0, done: 0, current: null },
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    files: null,
    report: null,
    error: null,
    log: [],
    config,
    emitter,
    controller: new AbortController(),
  };
  active.set(id, job);
  queue.push(id);
  persist(job);
  emit(job, { type: 'status', status: 'queued', position: queue.length });
  pump();
  return publicView(job);
}

function pump() {
  const { maxParallelReviews } = limits();
  while (running < maxParallelReviews && queue.length) {
    const job = active.get(queue.shift());
    running++;
    execute(job).finally(() => {
      running--;
      pump();
    });
  }
  queue.forEach((id, i) => {
    const job = active.get(id);
    emit(job, { type: 'status', status: 'queued', position: i + 1 });
  });
}

async function execute(job) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  persist(job);
  emit(job, { type: 'status', status: 'running' });
  try {
    await run(job);
  } catch (err) {
    job.status = 'error';
    job.error = err?.message || String(err);
    emit(job, { type: 'error', error: job.error });
  }
  finish(job);
}

function finish(job) {
  job.finishedAt = new Date().toISOString();
  job.progress.current = null;
  if (job.report) recordUsage(job.report.usage, job.finishedAt, job.repoId);
  persist(job);
  active.delete(job.id);
  job.emitter.removeAllListeners();
  prune();
}

/** The event log is saved without the report, which the run already holds. */
function emit(job, event) {
  const payload = { ...event, at: Date.now() };
  job.log.push(payload.report ? { ...payload, report: undefined } : payload);
  job.emitter.emit('event', payload);
}

/** Replay a run's saved events, putting the report back on the final one. */
export function replay(run) {
  return (run.log ?? []).map((ev) => (TERMINAL_EVENTS.includes(ev.type) && run.report ? { ...ev, report: run.report } : ev));
}

async function run(job) {
  const { signal } = job.controller;
  const { files, batches, truncated } = await buildBatches(job.repoRoot, job.config);
  job.files = files.length;
  job.progress.total = batches.length;
  emit(job, { type: 'plan', files: files.length, batches: batches.length });
  for (const message of job.config.warnings) emit(job, { type: 'warning', message });
  if (truncated.length) emit(job, { type: 'warning', message: truncationWarning(truncated) });

  const context = readContextFile(job.repoRoot, job.config);
  if (!context.found) {
    emit(job, { type: 'warning', message: context.warning });
  }
  for (const file of context.paths) emit(job, { type: 'context', path: file });

  const runnable = batches.map((b) => ({
    label: b.label,
    run: () => reviewBatch(b, { config: job.config, contextText: context.text, signal }),
  }));

  const results = await runUnits(runnable, {
    concurrency: job.config.concurrency,
    signal,
    onProgress: (p) => {
      if (p.phase === 'start') {
        job.progress.current = p.label;
        emit(job, { type: 'batch-start', index: p.index, total: p.total, label: p.label });
      } else {
        job.progress.done = p.completed;
        emit(job, {
          type: 'batch-done',
          index: p.index,
          completed: p.completed,
          total: p.total,
          label: p.label,
          findingCount: p.findingCount,
          error: p.error,
        });
      }
    },
  });

  const cancelled = signal.aborted;
  const finished = results.filter(Boolean);
  job.report = buildReport({
    mode: 'standalone',
    meta: {
      description: `Full review of ${job.repoRoot}`,
      reviewedFiles: files,
      truncatedFiles: truncated,
      ...(cancelled && { cancelled: true, skippedBatches: batches.length - finished.length }),
    },
    results: finished,
    contextWarning: context.warning,
    config: job.config,
  });
  job.status = cancelled ? 'cancelled' : 'completed';
  emit(job, { type: cancelled ? 'cancelled' : 'complete', report: job.report });
}

/**
 * Cancel a run. A queued run is dropped at once; a running run starts no new
 * batches, stops the model calls in flight and keeps the findings so far.
 * Returns { status, body } for the HTTP response.
 */
export function cancelJob(id) {
  const job = active.get(id);
  if (!job) {
    return index.has(id)
      ? { status: 409, body: { error: 'This run has already finished.' } }
      : { status: 404, body: { error: 'job not found' } };
  }
  if (job.status === 'queued') {
    queue.splice(queue.indexOf(id), 1);
    job.status = 'cancelled';
    emit(job, { type: 'cancelled' });
    finish(job);
    pump();
  } else if (job.status === 'running') {
    job.status = 'cancelling';
    persist(job);
    emit(job, { type: 'status', status: 'cancelling' });
    job.controller.abort();
  }
  return { status: 202, body: summarize(job) };
}

/** Delete a finished run's saved record. The usage ledger keeps its cost. */
export function deleteJob(id) {
  if (active.has(id)) return { status: 409, body: { error: 'Cancel the run before deleting it.' } };
  if (!isRunId(id) || !index.has(id)) return { status: 404, body: { error: 'job not found' } };
  deleteRun(id);
  index.delete(id);
  return { status: 204 };
}

/** Keep the newest `runsToKeep` finished runs. */
function prune() {
  const { runsToKeep } = limits();
  const finished = [...index.values()]
    .filter((run) => !active.has(run.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const run of finished.slice(runsToKeep)) {
    deleteRun(run.id);
    index.delete(run.id);
  }
}

/** True while a run of this saved repo is queued or running. */
export function hasActiveRun(repoId) {
  return [...active.values()].some((job) => job.repoId === repoId);
}

/** Per-repo totals: spend from the ledger, the latest run from saved runs. */
export function repoActivity() {
  const { repos } = readUsage();
  const latest = {};
  for (const run of listJobs()) {
    if (run.repoId && !latest[run.repoId]) latest[run.repoId] = run;
  }
  return { spend: repos, latest };
}

/** Spend and run counts for the dashboard. */
export function stats() {
  const { allTime, months } = readUsage();
  const month = new Date().toISOString().slice(0, 7);
  const summaries = [...index.values()];
  return {
    allTime: { ...allTime, totalTokens: allTime.inputTokens + allTime.outputTokens },
    thisMonth: { month, ...(months[month] ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, runs: 0, partial: false }) },
    savedRuns: summaries.length,
    running: summaries.filter((r) => r.status === 'running' || r.status === 'cancelling').length,
    queued: queue.length,
    limits: limits(),
  };
}
