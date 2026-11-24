import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import {
  cancelJob, deleteJob, getJob, listJobs, publicView, replay, startReview, stats, TERMINAL_EVENTS,
} from '../core/jobs.js';
import { renderMarkdown } from '../core/report.js';
import { ConfigError, loadConfig, MODEL_PATTERN, SEVERITY_ORDER } from '../core/config.js';
import { resolveWithin } from '../core/match.js';
import { readSettings } from '../core/settings.js';
import { getRepo, repoPath, RepoError } from '../core/repos.js';

const router = express.Router();
const reviewRoot = path.resolve(process.env.REPO_DIR || process.cwd());

/** Current effective config (for the dashboard form defaults). */
router.get('/config', (req, res) => {
  const c = loadConfig({ settings: readSettings() });
  res.json({
    repoRoot: reviewRoot,
    model: c.model,
    severityGate: c.severityGate,
    contextFile: c.contextFile,
    batch: c.batch,
  });
});

/** Spend totals and queue state for the dashboard. */
router.get('/stats', (req, res) => {
  res.json(stats());
});

/** Queue a standalone review of a saved repo (repoId) or a path in the review root (repoRoot). */
router.post('/review', (req, res) => {
  const { repoId, repoRoot, severityGate, model } = req.body || {};
  let repo = null;
  if (repoId !== undefined) {
    repo = getRepo(repoId);
    if (!repo) return res.status(404).json({ error: 'Repository not found.' });
  } else if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) {
    return res.status(400).json({ error: 'repoRoot must be an absolute path' });
  }
  if (severityGate !== undefined && !SEVERITY_ORDER.includes(severityGate)) {
    return res.status(400).json({ error: `Use a severity gate of ${SEVERITY_ORDER.join(', ')}.` });
  }
  if (model !== undefined && (typeof model !== 'string' || !MODEL_PATTERN.test(model))) {
    return res.status(400).json({ error: 'Model must be in provider/model format.' });
  }

  let resolvedRoot;
  if (repo) {
    try {
      resolvedRoot = repoPath(repo);
    } catch (err) {
      if (!(err instanceof RepoError)) throw err;
      return res.status(err.status).json({ error: err.message });
    }
  } else try {
    resolvedRoot = resolveWithin(reviewRoot, repoRoot);
    if (!resolvedRoot) return res.status(403).json({ error: `Choose a directory within ${reviewRoot}.` });
    if (!fs.statSync(resolvedRoot).isDirectory()) return res.status(400).json({ error: 'Choose a directory.' });
  } catch {
    return res.status(400).json({ error: 'Could not open that directory.' });
  }

  const overrides = {};
  if (severityGate) overrides.severityGate = severityGate;
  if (model) overrides.model = model;

  let job;
  try {
    job = startReview({ repoRoot: resolvedRoot, overrides, repoId: repo?.id ?? null, repoName: repo?.name ?? null });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return res.status(400).json({ error: err.message });
  }
  res.status(202).json(job);
});

router.get('/review', (req, res) => {
  res.json(listJobs());
});

router.get('/review/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(publicView(job));
});

router.post('/review/:id/cancel', (req, res) => {
  const { status, body } = cancelJob(req.params.id);
  res.status(status).json(body);
});

router.delete('/review/:id', (req, res) => {
  const { status, body } = deleteJob(req.params.id);
  if (status === 204) return res.status(204).end();
  res.status(status).json(body);
});

/** Download the report of a finished or cancelled run. */
router.get('/review/:id/report.md', (req, res) => {
  const job = getJob(req.params.id);
  if (!job || !job.report) return res.status(404).send('report not ready');
  res.attachment(`review-${job.id.slice(0, 8)}.md`);
  res.type('text/markdown').send(renderMarkdown(job.report));
});

router.get('/review/:id/report.json', (req, res) => {
  const job = getJob(req.params.id);
  if (!job || !job.report) return res.status(404).json({ error: 'report not ready' });
  res.attachment(`review-${job.id.slice(0, 8)}.json`);
  res.json(job.report);
});

/** Server-Sent Events stream of job progress. */
router.get('/review/:id/stream', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  // Replay any events already emitted so late subscribers stay in sync.
  for (const ev of replay(job)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (!job.emitter) return res.end();

  const onEvent = (ev) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (TERMINAL_EVENTS.includes(ev.type)) res.end();
  };
  job.emitter.on('event', onEvent);

  res.on('close', () => job.emitter.off('event', onEvent));
});

export default router;
