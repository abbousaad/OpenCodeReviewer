import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveWithin } from './match.js';
import { readSecret } from './settings.js';
import { DATA_DIR, readJson, writeJson } from './store.js';
import { extractZip, SKIP_SEGMENTS, ZipError } from './unzip.js';

const execFileP = promisify(execFile);

/**
 * Saved repositories. A repo is either a folder inside the review root
 * (source "local", never deleted from disk), or a copy the server manages in
 * DATA_DIR/repos/<id>: an upload ("upload") or a shallow Git clone ("git").
 */
const REGISTRY = 'repos.json';
export const MANAGED_DIR = path.join(DATA_DIR, 'repos');
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const LIMITS = {
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 200) * 1e6,
  maxFiles: Number(process.env.MAX_UPLOAD_FILES || 20000),
  maxFileBytes: Number(process.env.MAX_UPLOAD_FILE_MB || 2) * 1e6,
};
export const gitAllowedHosts = () => (process.env.GIT_ALLOWED_HOSTS ?? 'github.com,gitlab.com,bitbucket.org')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

export class RepoError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const reviewRoot = () => path.resolve(process.env.REPO_DIR || process.cwd());

function load() {
  return readJson(REGISTRY) ?? [];
}
function save(repos) {
  writeJson(REGISTRY, repos);
}
function update(id, changes) {
  const repos = load();
  const repo = repos.find((r) => r.id === id);
  if (!repo) return null;
  Object.assign(repo, changes, { updatedAt: new Date().toISOString() });
  save(repos);
  return repo;
}

/** Interrupted clones cannot finish after a restart. */
export function initRepos() {
  const repos = load();
  let changed = false;
  for (const repo of repos) {
    if (repo.status === 'cloning') {
      Object.assign(repo, { status: repo.files ? 'ready' : 'error', error: repo.files ? null : 'The server stopped during the clone.' });
      changed = true;
    }
  }
  if (changed) save(repos);
  // Remove staging folders left by a crash.
  try {
    for (const name of fs.readdirSync(MANAGED_DIR)) {
      if (/\.(tmp|old)$/.test(name)) fs.rmSync(path.join(MANAGED_DIR, name), { recursive: true, force: true });
    }
  } catch { /* no managed repos yet */ }
}

export function listRepos() {
  return load();
}

export function getRepo(id) {
  return typeof id === 'string' && ID.test(id) ? load().find((r) => r.id === id) ?? null : null;
}

/**
 * The directory to review for a saved repo, re-checked on every use: a local
 * repo must still be inside the review root, a managed one inside MANAGED_DIR.
 */
export function repoPath(repo) {
  if (repo.status !== 'ready') throw new RepoError('This repository is not ready yet.', 409);
  try {
    const root = repo.source === 'local' ? reviewRoot() : MANAGED_DIR;
    const resolved = resolveWithin(root, repo.path);
    if (resolved && fs.statSync(resolved).isDirectory()) return resolved;
  } catch { /* fall through */ }
  throw new RepoError('The repository folder is missing or outside the allowed root.', 409);
}

function cleanName(name, fallback) {
  const value = typeof name === 'string' ? name.trim() : '';
  if (value.length > 100) throw new RepoError('Use a name of at most 100 characters.');
  return value || fallback;
}

function register(fields) {
  const repos = load();
  const now = new Date().toISOString();
  const repo = { id: randomUUID(), createdAt: now, updatedAt: now, status: 'ready', error: null, ...fields };
  repos.push(repo);
  save(repos);
  return repo;
}

export function addLocal({ path: dir, name }) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new RepoError('Choose an absolute folder path.');
  let resolved;
  try {
    resolved = resolveWithin(reviewRoot(), dir);
  } catch {
    throw new RepoError('Could not open that folder.');
  }
  if (!resolved) throw new RepoError(`Choose a folder within ${reviewRoot()}.`, 403);
  if (!fs.statSync(resolved).isDirectory()) throw new RepoError('Choose a folder.');
  if (load().some((r) => r.source === 'local' && r.path === resolved)) throw new RepoError('This folder is already saved.', 409);
  return register({
    source: 'local',
    name: cleanName(name, path.basename(resolved) || resolved),
    path: resolved,
    git: fs.existsSync(path.join(resolved, '.git')),
  });
}

function folderSize(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_SEGMENTS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { files++; bytes += fs.statSync(p).size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** Stream an upload request body to a temp file, stopping at the size limit. */
export async function receiveUpload(req) {
  fs.mkdirSync(MANAGED_DIR, { recursive: true, mode: 0o700 });
  const declared = Number(req.get('content-length'));
  if (declared > LIMITS.maxUploadBytes) throw new RepoError(`Uploads are limited to ${LIMITS.maxUploadBytes / 1e6} MB.`, 413);
  const file = path.join(MANAGED_DIR, `${randomUUID()}.zip.tmp`);
  const out = fs.createWriteStream(file, { mode: 0o600 });
  let received = 0;
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        received += chunk.length;
        if (received > LIMITS.maxUploadBytes) {
          req.unpipe(out);
          reject(new RepoError(`Uploads are limited to ${LIMITS.maxUploadBytes / 1e6} MB.`, 413));
          req.resume();
        }
      });
      req.on('error', reject);
      req.on('aborted', () => reject(new RepoError('The upload was interrupted.')));
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
  } catch (err) {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw err;
  }
  return file;
}

/** Extract an uploaded ZIP into a new managed repo. */
export function addUpload(zipFile, { name }) {
  const id = randomUUID();
  const staging = path.join(MANAGED_DIR, `${id}.tmp`);
  const final = path.join(MANAGED_DIR, id);
  try {
    const label = cleanName(name, 'upload');
    fs.mkdirSync(staging, { mode: 0o700 });
    const { files, bytes, skipped } = extractZip(zipFile, staging, {
      maxFiles: LIMITS.maxFiles, maxFileBytes: LIMITS.maxFileBytes, maxTotalBytes: LIMITS.maxUploadBytes,
    });
    fs.renameSync(staging, final);
    const repos = load();
    const now = new Date().toISOString();
    const repo = { id, createdAt: now, updatedAt: now, status: 'ready', error: null,
      source: 'upload', name: label, path: final, files, bytes, skipped };
    repos.push(repo);
    save(repos);
    return repo;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (err instanceof ZipError) throw new RepoError(err.message);
    throw err;
  } finally {
    fs.rmSync(zipFile, { force: true });
  }
}

/** Validate a clone URL: HTTPS, no embedded credentials, an allowed host. */
export function checkGitUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new RepoError('Enter a valid HTTPS repository URL.');
  }
  if (url.protocol !== 'https:') throw new RepoError('Only https:// repository URLs are allowed.');
  if (url.username || url.password) throw new RepoError('Remove the credentials from the URL. Save a token in Settings instead.');
  if (url.search || url.hash) throw new RepoError('Remove the query string and fragment from the URL.');
  const allowed = gitAllowedHosts();
  if (!allowed.includes('*') && !allowed.includes(url.hostname.toLowerCase())) {
    throw new RepoError(`Cloning from ${url.hostname} is not allowed. Allowed hosts: ${allowed.join(', ')}.`, 403);
  }
  return url;
}

const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;

export function addGit({ url, branch, name }) {
  const parsed = checkGitUrl(url);
  if (branch && (typeof branch !== 'string' || !BRANCH.test(branch))) throw new RepoError('Enter a valid branch name.');
  const fallback = path.basename(parsed.pathname).replace(/\.git$/, '') || parsed.hostname;
  const repo = register({
    source: 'git', name: cleanName(name, fallback), url: parsed.href, branch: branch || null,
    path: null, status: 'cloning', files: null, bytes: null,
  });
  repo.path = path.join(MANAGED_DIR, repo.id);
  update(repo.id, { path: repo.path });
  clone(repo).catch(() => {});
  return repo;
}

/** Re-clone a Git repo into a fresh folder, then swap it in. */
export function pullGit(id, isBusy) {
  const repo = getRepo(id);
  if (!repo) throw new RepoError('Repository not found.', 404);
  if (repo.source !== 'git') throw new RepoError('Only Git repositories can be updated.');
  if (repo.status === 'cloning') throw new RepoError('This repository is already updating.', 409);
  if (isBusy(id)) throw new RepoError('Wait for the review of this repository to finish.', 409);
  update(id, { status: 'cloning', error: null });
  clone({ ...repo, status: 'cloning' }).catch(() => {});
  return getRepo(id);
}

async function clone(repo) {
  fs.mkdirSync(MANAGED_DIR, { recursive: true, mode: 0o700 });
  const staging = path.join(MANAGED_DIR, `${repo.id}.tmp`);
  fs.rmSync(staging, { recursive: true, force: true });
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', GCM_INTERACTIVE: 'never' };
  delete env.REVIEW_PASSWORD;
  // The token travels in environment config, so it never appears in the
  // process list, the URL or the saved record, and only goes to github.com.
  const token = readSecret('githubToken');
  if (token && new URL(repo.url).hostname.toLowerCase() === 'github.com') {
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    });
  }
  const args = [
    '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
    '-c', 'core.symlinks=false', '-c', 'http.followRedirects=false',
    'clone', '--depth', '1', '--single-branch', '--no-tags', '--no-recurse-submodules',
    ...(repo.branch ? ['--branch', repo.branch] : []),
    '--', repo.url, staging,
  ];
  try {
    await execFileP('git', args, { env, timeout: Number(process.env.GIT_CLONE_TIMEOUT_MS || 300000), maxBuffer: 4 * 1024 * 1024 });
    const { files, bytes } = folderSize(staging);
    if (files > LIMITS.maxFiles || bytes > LIMITS.maxUploadBytes) {
      throw new Error(`The repository is larger than the limit (${LIMITS.maxFiles} files, ${LIMITS.maxUploadBytes / 1e6} MB).`);
    }
    const final = path.join(MANAGED_DIR, repo.id);
    const old = `${final}.old`;
    if (fs.existsSync(final)) fs.renameSync(final, old);
    fs.renameSync(staging, final);
    fs.rmSync(old, { recursive: true, force: true });
    if (!update(repo.id, { status: 'ready', error: null, files, bytes, path: final, clonedAt: new Date().toISOString() })) {
      fs.rmSync(final, { recursive: true, force: true }); // removed while cloning
    }
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    const detail = String(err.stderr || err.message || err).trim().split('\n').filter(Boolean).slice(-2).join(' ');
    const hadCopy = fs.existsSync(path.join(MANAGED_DIR, repo.id));
    update(repo.id, { status: hadCopy ? 'ready' : 'error', error: `Clone failed: ${detail.replace(/Authorization:[^\s]*/gi, '')}` });
  }
}

/** Forget a repo. Managed copies are deleted; local folders are never touched. */
export function removeRepo(id, isBusy) {
  const repo = getRepo(id);
  if (!repo) throw new RepoError('Repository not found.', 404);
  if (isBusy(id)) throw new RepoError('Cancel or wait for the review of this repository first.', 409);
  if (repo.status === 'cloning') throw new RepoError('Wait for the clone to finish.', 409);
  if (repo.source !== 'local') {
    const dir = path.join(MANAGED_DIR, repo.id);
    if (path.dirname(dir) === MANAGED_DIR) fs.rmSync(dir, { recursive: true, force: true });
  }
  save(load().filter((r) => r.id !== id));
}

export function renameRepo(id, name) {
  if (!getRepo(id)) throw new RepoError('Repository not found.', 404);
  return update(id, { name: cleanName(name, getRepo(id).name) });
}
