import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { loadConfig } from './config.js';
import { buildBatches } from './batcher.js';
import { readContextFile } from './contextFile.js';
import { reviewBatch, runUnits } from './reviewer.js';
import { buildReport } from './report.js';

/**
 * In-memory registry of standalone review jobs. Each job streams progress
 * events to subscribers (SSE) and holds the final report when complete.
 */
const jobs = new Map();

export function getJob(id) {
  return jobs.get(id);
}

export function listJobs() {
  return [...jobs.values()].map(publicView);
}

function publicView(job) {
  return {
    id: job.id,
    repoRoot: job.repoRoot,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    report: job.report,
    error: job.error,
  };
}

/** Create and start a standalone review job for `repoRoot`. */
export function startReview({ repoRoot, overrides = {} }) {
  const id = randomUUID();
  const config = { ...loadConfig(), ...overrides };
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  const job = {
    id,
    repoRoot,
    config,
    status: 'pending',
    progress: { total: 0, done: 0, current: null },
    createdAt: new Date().toISOString(),
    report: null,
    error: null,
    emitter,
    log: [],
  };
  jobs.set(id, job);

  // Run asynchronously; the caller gets the id immediately.
  run(job).catch((err) => {
    job.status = 'error';
    job.error = err?.message || String(err);
    emit(job, { type: 'error', error: job.error });
  });

  return publicView(job);
}

function emit(job, event) {
  const payload = { ...event, at: Date.now() };
  job.log.push(payload);
  job.emitter.emit('event', payload);
}

async function run(job) {
  job.status = 'running';
  emit(job, { type: 'status', status: 'running' });

  const { files, batches } = await buildBatches(job.repoRoot, job.config);
  job.progress.total = batches.length;
  emit(job, { type: 'plan', files: files.length, batches: batches.length });

  const context = readContextFile(job.repoRoot, job.config);
  if (!context.found) {
    emit(job, { type: 'warning', message: context.warning });
  }
  for (const file of context.paths) emit(job, { type: 'context', path: file });

  const runnable = batches.map((b) => ({
    label: b.label,
    run: () => reviewBatch(b, { config: job.config, contextText: context.text }),
  }));

  const results = await runUnits(runnable, {
    onProgress: (p) => {
      if (p.phase === 'start') {
        job.progress.current = p.label;
        emit(job, { type: 'batch-start', index: p.index, total: p.total, label: p.label });
      } else {
        job.progress.done = p.index + 1;
        emit(job, {
          type: 'batch-done',
          index: p.index,
          total: p.total,
          label: p.label,
          findingCount: p.findingCount,
          error: p.error,
        });
      }
    },
  });

  job.report = buildReport({
    mode: 'standalone',
    meta: { description: `Full review of ${job.repoRoot}`, reviewedFiles: files },
    results,
    contextWarning: context.warning,
    config: job.config,
  });
  job.status = 'completed';
  emit(job, { type: 'complete', report: job.report });
}

export { publicView };
