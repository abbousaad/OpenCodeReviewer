import { simpleGit } from 'simple-git';

/**
 * Determine the review scope (PR/MR, branch push, or single commit) from
 * standard CI environment variables, falling back to plain git heuristics.
 * Returns { kind, base, head, description }.
 */
export async function detectGitContext(repoRoot, options = {}) {
  const git = simpleGit({ baseDir: repoRoot });
  const env = process.env;

  // Explicit refs override CI provider hints.
  const baseRef = options.base ?? env.REVIEW_BASE_REF;
  const headRef = options.head ?? (env.REVIEW_HEAD_REF || 'HEAD');
  if (baseRef) {
    const base = await resolveCommit(git, baseRef);
    const head = await resolveCommit(git, headRef);
    return {
      kind: options.mergeBase ? 'pull_request' : 'range',
      base,
      head,
      description: `Range ${baseRef}${options.mergeBase ? '...' : '..'}${headRef}`,
    };
  }
  if (options.head || options.mergeBase) {
    throw new Error('--head and --merge-base require a base ref');
  }

  // Pull/Merge request fallback — GitLab, GitHub Actions, Gitea Actions, generic.
  const prTarget =
    env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ||
    env.GITHUB_BASE_REF ||
    env.GITEA_BASE_REF ||
    env.BASE_REF;

  if (prTarget) {
    const base = await resolveRef(git, [`origin/${prTarget}`, prTarget]);
    return {
      kind: 'pull_request',
      base: base || prTarget,
      head: 'HEAD',
      description: `Merge/PR into ${prTarget}`,
    };
  }

  // 3) Branch push with a known "before" SHA (GitLab).
  const beforeSha = env.CI_COMMIT_BEFORE_SHA;
  if (beforeSha && !/^0+$/.test(beforeSha)) {
    return {
      kind: 'push',
      base: beforeSha,
      head: 'HEAD',
      description: `Push ${beforeSha.slice(0, 8)}..HEAD`,
    };
  }

  // 4) Explicit single commit.
  const sha = env.REVIEW_COMMIT || env.CI_COMMIT_SHA;
  if (sha && (await hasParent(git, sha))) {
    return {
      kind: 'commit',
      base: `${sha}^`,
      head: sha,
      description: `Commit ${sha.slice(0, 8)}`,
    };
  }

  // 5) Fallback: last commit on the current checkout.
  if (await hasParent(git, 'HEAD')) {
    return { kind: 'commit', base: 'HEAD^', head: 'HEAD', description: 'Last commit (HEAD^..HEAD)' };
  }

  // 6) Brand-new repo with a single commit — review everything committed.
  return { kind: 'initial', base: null, head: 'HEAD', description: 'Initial commit (all tracked files)' };
}

async function resolveCommit(git, ref) {
  try {
    return (await git.revparse(['--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  } catch (cause) {
    throw new Error(`Cannot resolve Git commit: ${ref}`, { cause });
  }
}

async function resolveRef(git, candidates) {
  for (const ref of candidates) {
    try {
      await git.revparse(['--verify', ref]);
      return ref;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function hasParent(git, ref) {
  try {
    await git.revparse(['--verify', `${ref}^`]);
    return true;
  } catch {
    return false;
  }
}
