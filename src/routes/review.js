import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { startReview, getJob, listJobs, publicView } from '../core/jobs.js';
import { renderMarkdown } from '../core/report.js';
import { loadConfig, SEVERITY_ORDER } from '../core/config.js';
import { resolveWithin } from '../core/match.js';

const router = express.Router();
const reviewRoot = path.resolve(process.env.REPO_DIR || process.cwd());

/** Current effective config (for the dashboard form defaults). */
router.get('/config', (req, res) => {
  const c = loadConfig();
  res.json({
    repoRoot: reviewRoot,
    model: c.model,
    severityGate: c.severityGate,
    contextFile: c.contextFile,
    batch: c.batch,
  });
});

/** Start a standalone review of a server-accessible repo path. */
router.post('/review', (req, res) => {
  const { repoRoot, severityGate, model } = req.body || {};
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) {
    return res.status(400).json({ error: 'repoRoot must be an absolute path' });
  }
  if (severityGate !== undefined && !SEVERITY_ORDER.includes(severityGate)) {
    return res.status(400).json({ error: `Use a severity gate of ${SEVERITY_ORDER.join(', ')}.` });
  }
  if (model !== undefined && (typeof model !== 'string' || !/^[\w.][\w.-]*\/[^\s\0]+$/.test(model))) {
    return res.status(400).json({ error: 'Model must be in provider/model format.' });
  }

  let resolvedRoot;
  try {
    resolvedRoot = resolveWithin(reviewRoot, repoRoot);
    if (!resolvedRoot) return res.status(403).json({ error: `Choose a directory within ${reviewRoot}.` });
    if (!fs.statSync(resolvedRoot).isDirectory()) return res.status(400).json({ error: 'Choose a directory.' });
  } catch {
    return res.status(400).json({ error: 'Could not open that directory.' });
  }

  const overrides = {};
  if (severityGate) overrides.severityGate = severityGate;
  if (model) overrides.model = model;

  const job = startReview({ repoRoot: resolvedRoot, overrides });
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

/** Download the markdown report for a completed job. */
router.get('/review/:id/report.md', (req, res) => {
  const job = getJob(req.params.id);
  if (!job || !job.report) return res.status(404).send('report not ready');
  res.type('text/markdown').send(renderMarkdown(job.report));
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
  for (const ev of job.log) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (job.status === 'completed' || job.status === 'error') {
    return res.end();
  }

  const onEvent = (ev) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (ev.type === 'complete' || ev.type === 'error') res.end();
  };
  job.emitter.on('event', onEvent);

  res.on('close', () => job.emitter.off('event', onEvent));
});

export default router;
