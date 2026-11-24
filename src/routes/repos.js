import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { hasActiveRun, repoActivity } from '../core/jobs.js';
import { resolveWithin } from '../core/match.js';
import {
  addGit, addLocal, addUpload, getRepo, gitAllowedHosts, LIMITS, listRepos, pullGit, receiveUpload,
  removeRepo, renameRepo, RepoError,
} from '../core/repos.js';

const router = express.Router();
const reviewRoot = path.resolve(process.env.REPO_DIR || process.cwd());
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', '__pycache__']);
const MAX_CANDIDATES = 300;

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof RepoError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

/** Saved repos with their latest run and total spend. */
router.get('/repos', (req, res) => {
  const { spend, latest } = repoActivity();
  res.json({
    root: reviewRoot,
    limits: { ...LIMITS, gitHosts: gitAllowedHosts() },
    repos: listRepos().map((repo) => ({
      ...repo,
      spend: spend[repo.id] ?? null,
      lastRun: latest[repo.id] ?? null,
      busy: hasActiveRun(repo.id),
    })),
  });
});

/**
 * Folders that can be added as local repos: the review root, its
 * subdirectories, and Git repositories one level further down.
 */
router.get('/repos/candidates', (req, res) => {
  const saved = new Set(listRepos().filter((r) => r.source === 'local').map((r) => r.path));
  const found = [];
  const add = (dir, depth) => {
    let resolved;
    try {
      resolved = resolveWithin(reviewRoot, dir);
      if (!resolved || !fs.statSync(resolved).isDirectory()) return false;
    } catch {
      return false;
    }
    const git = fs.existsSync(path.join(resolved, '.git'));
    if (depth < 2 || git) {
      found.push({ path: resolved, name: path.relative(reviewRoot, dir) || path.basename(dir), git, depth, saved: saved.has(resolved) });
    }
    return true;
  };
  const children = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
        .map((e) => path.join(dir, e.name))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  };
  add(reviewRoot, 0);
  for (const child of children(reviewRoot)) {
    if (found.length >= MAX_CANDIDATES) break;
    if (!add(child, 1) || fs.existsSync(path.join(child, '.git'))) continue;
    for (const grandchild of children(child)) {
      if (found.length >= MAX_CANDIDATES) break;
      add(grandchild, 2);
    }
  }
  res.json({ root: reviewRoot, candidates: found, truncated: found.length >= MAX_CANDIDATES });
});

router.post('/repos', handle((req, res) => {
  const { source, path: dir, url, branch, name } = req.body || {};
  if (source === 'local') return res.status(201).json(addLocal({ path: dir, name }));
  if (source === 'git') return res.status(202).json(addGit({ url, branch, name }));
  throw new RepoError('Use source "local" or "git", or upload a ZIP to /api/repos/upload.');
}));

/** Upload a ZIP body (Content-Type: application/zip). The name comes in the query string. */
router.post('/repos/upload', handle(async (req, res) => {
  if (!req.is('application/zip')) throw new RepoError('Send the archive with Content-Type: application/zip.', 415);
  const file = await receiveUpload(req);
  res.status(201).json(addUpload(file, { name: req.query.name }));
}));

router.patch('/repos/:id', handle((req, res) => {
  res.json(renameRepo(req.params.id, req.body?.name));
}));

router.post('/repos/:id/pull', handle((req, res) => {
  res.status(202).json(pullGit(req.params.id, hasActiveRun));
}));

router.delete('/repos/:id', handle((req, res) => {
  removeRepo(req.params.id, hasActiveRun);
  res.status(204).end();
}));

router.get('/repos/:id', (req, res) => {
  const repo = getRepo(req.params.id);
  if (!repo) return res.status(404).json({ error: 'Repository not found.' });
  res.json(repo);
});

export default router;
