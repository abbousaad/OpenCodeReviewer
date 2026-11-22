import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildBatches } from '../src/core/batcher.js';
import { splitLines } from '../src/core/chunk.js';
import { batchDiffs } from '../src/core/diff.js';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oc-reviewer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  mkdirSync(bin);
  mkdirSync(repo);
  writeFileSync(path.join(bin, 'opencode'), `#!/usr/bin/env node
const args = process.argv.slice(2);
const standalone = process.env.MOCK_STANDALONE === '1';
if (args[1] === '--help') {
  console.log(standalone ? '  --standalone   Run with a private server' : 'opencode run [message..]');
  process.exit(0);
}
const prompt = require('node:fs').readFileSync(0, 'utf8');
if (args.includes('--standalone') !== standalone) process.exit(2);
if (args[args.indexOf('--format') + 1] !== 'json') process.exit(2);
// The prompt must arrive on stdin, never as an argument.
if (args.indexOf('-m') !== args.length - 2) process.exit(2);
const model = args.at(-1);
for (const rule of ['A10:2025', 'API1:2023', 'API10:2023']) {
  if (!prompt.includes(rule)) process.exit(2);
}
for (const expected of (process.env.MOCK_CONTEXT || '').split(',').filter(Boolean)) {
  if (!prompt.includes(expected)) process.exit(2);
}
const reply = process.env.MOCK_REPLY;
const emit = (type, part) => console.log(JSON.stringify({ type, part }));
if (reply !== 'no-usage') {
  for (const [id, reason] of [['one', 'tool-calls'], ['two', 'stop']]) {
    emit('step_start', {});
    if (reply === 'partial' && id === 'two') continue;
    emit('step_finish', { id, reason, cost: 0.000125, tokens: {
      input: 100, output: 20, reasoning: 10, cache: { read: 30, write: 5 },
    } });
  }
}
if (reply === 'failure') process.exit(1);
if (reply === 'malformed' || (reply === 'retry-major' && !prompt.includes('OUTPUT RETRY'))) {
  emit('text', { text: 'unexpected output' });
} else {
  const severity = reply === 'retry-major' ? 'major' : ['major', 'minor'].includes(reply) ? reply : null;
  const message = model + (prompt.includes('OUTSIDE_CONTEXT') ? ' leaked context' : '');
  const text = JSON.stringify({
    findings: severity ? [{ severity, message }] : [],
    summary: 'Ownership check unverified in this fixture.',
  });
  emit('text', { text: text.slice(0, 7) });
  emit('text', { text: text.slice(7) });
}
`, { mode: 0o755 });
  return { root, repo, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
}

test('CI checks quoted filenames and fails closed', (t) => {
  const { repo, env } = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  const commit = (...args) => git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture', ...args);
  git('init', '-q');
  commit('--allow-empty');
  const filename = 'café.js';
  writeFileSync(path.join(repo, filename), 'export const changed = true;\n');
  writeFileSync(path.join(repo, 'REVIEW_CONTEXT.md'), 'ARCHITECTURE_RULE');
  writeFileSync(path.join(repo, 'BUSINESS_LOGIC.md'), 'OWNER_ACCESS_RULE');
  git('add', '.');
  commit();

  for (const [reply, gate, status] of [
    ['', 'major', 0],
    ['major', 'major', 1],
    ['failure', 'major', 3],
    ['malformed', 'major', 3],
    ['retry-major', 'major', 1],
    ['partial', 'major', 0],
    ['no-usage', 'major', 0],
    ['critical', 'typo', 3],
  ]) {
    const run = spawnSync(process.execPath, ['src/cli.js', 'ci', repo], {
      env: {
        ...env,
        CI_MERGE_REQUEST_TARGET_BRANCH_NAME: '',
        GITHUB_BASE_REF: 'unavailable-ci-target',
        GITEA_BASE_REF: '',
        BASE_REF: '',
        REVIEW_BASE_REF: 'HEAD^',
        REVIEW_HEAD_REF: 'HEAD',
        REPORT_DIR: repo,
        MOCK_REPLY: reply,
        MOCK_CONTEXT: 'ARCHITECTURE_RULE,OWNER_ACCESS_RULE',
        MOCK_STANDALONE: '0',
        SEVERITY_GATE: gate,
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(run.status, status, run.stderr);
    if (gate === 'typo') {
      assert.match(run.stderr, /Invalid severity gate/);
    } else {
      const report = JSON.parse(readFileSync(path.join(repo, 'review-report.json'), 'utf8'));
      assert.deepEqual(report.meta.changedFiles, [filename]);
      assert.equal(report.errors.length, status === 3 ? 1 : 0);
      assert.equal(report.status, status === 3 ? 'incomplete' : 'complete');
      assert.match(run.stdout, /using context: REVIEW_CONTEXT\.md, BUSINESS_LOGIC\.md/);
      let steps = 2;
      if (reply === 'no-usage') steps = 0;
      if (reply === 'partial') steps = 1;
      if (['malformed', 'retry-major'].includes(reply)) steps = 4;
      assert.equal(report.usage.inputTokens, steps ? steps * 135 : null);
      assert.equal(report.usage.outputTokens, steps ? steps * 30 : null);
      assert.equal(report.usage.totalTokens, steps ? steps * 165 : null);
      assert.equal(report.usage.costUsd, steps ? steps * 0.000125 : null);
      assert.equal(report.usage.partial, ['failure', 'partial', 'no-usage'].includes(reply));
      const markdown = readFileSync(path.join(repo, 'review-report.md'), 'utf8');
      const cost = (steps * 0.000125).toLocaleString('en-US', {
        style: 'currency', currency: 'USD', maximumFractionDigits: 8,
      });
      assert.ok(markdown.includes(steps ? cost : '**Tokens:** Unavailable'));
      if (status === 3) {
        assert.match(markdown, /\*\*Review incomplete\.\*\*/);
        assert.doesNotMatch(markdown, /Found \*\*0\*\*/);
      } else {
        assert.match(markdown, /Ownership check unverified in this fixture/);
      }
      if (reply === 'retry-major') assert.equal(report.counts.major, 1);
    }
  }
});

test('CI reviews a unified diff without a Git checkout', (t) => {
  const { root, repo, env } = fixture(t);
  writeFileSync(path.join(repo, 'BUSINESS_LOGIC.md'), 'OWNER_ACCESS_RULE');
  const patch = path.join(root, 'change.patch');
  const run = (extraEnv) => spawnSync(process.execPath, ['src/cli.js', 'ci', repo, '--diff', patch], {
    env: {
      ...env,
      GITEA_BASE_REF: 'unavailable-ci-target',
      REVIEW_BASE_REF: 'unavailable-explicit-ref',
      REPORT_DIR: repo,
      MOCK_REPLY: 'major',
      MOCK_CONTEXT: 'OWNER_ACCESS_RULE,+++ not a file header',
      MOCK_STANDALONE: '0',
      SEVERITY_GATE: 'major',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 5000,
  });
  writeFileSync(patch, [
    'Index: src/app.js',
    '--- src/app.js\t(revision 1)',
    '+++ src/app.js\t(revision 2)',
    '@@ -1 +1 @@',
    '--- old line',
    '+++ not a file header',
    '--- /dev/null',
    '+++ assets/image.txt',
    '@@ -0,0 +1 @@',
    '+this file is filtered out',
    '',
  ].join('\n'));

  const completed = run();
  assert.equal(completed.status, 1, completed.stderr);
  const report = JSON.parse(readFileSync(path.join(repo, 'review-report.json'), 'utf8'));
  assert.equal(report.meta.kind, 'patch');
  assert.deepEqual(report.meta.changedFiles, ['src/app.js']);
  assert.equal(report.counts.major, 1);

  writeFileSync(patch, '--- src/app.js\n+++ src/app.js\n@@ -1 +1 @@\n-old\n');
  const invalid = run();
  assert.equal(invalid.status, 3, invalid.stderr);
  assert.match(invalid.stderr, /Incomplete unified diff hunk/);

  // A clipped line means unreviewed code: keep the findings but fail closed.
  writeFileSync(patch, `--- src/app.js\n+++ src/app.js\n@@ -1 +1 @@\n-old\n+${'x'.repeat(60000)}\n`);
  const clipped = run({ MOCK_REPLY: '', MOCK_CONTEXT: 'OWNER_ACCESS_RULE' });
  assert.equal(clipped.status, 3, clipped.stderr);
  assert.match(clipped.stderr, /clipped before review in: src\/app\.js/);
  const clippedReport = JSON.parse(readFileSync(path.join(repo, 'review-report.json'), 'utf8'));
  assert.equal(clippedReport.status, 'incomplete');
  assert.deepEqual(clippedReport.meta.truncatedFiles, ['src/app.js']);
  assert.match(clippedReport.errors[0].error, /was clipped/);
});

test('dashboard protects review jobs and uses the model selected for each job', { timeout: 10000 }, async (t) => {
  const { root, repo, env } = fixture(t);
  const outside = path.join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'context.md'), 'OUTSIDE_CONTEXT');
  symlinkSync(outside, path.join(repo, 'escape'));
  symlinkSync(path.join(outside, 'context.md'), path.join(repo, 'REVIEW_CONTEXT.md'));
  writeFileSync(path.join(repo, 'BUSINESS_LOGIC.md'), 'OWNER_ACCESS_RULE');
  writeFileSync(path.join(repo, 'source.js'), 'export const reviewed = true;\n');
  for (let i = 1; i <= 6; i++) {
    writeFileSync(path.join(repo, `extra-${i}.js`), '// Batch fixture\n');
  }

  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...env,
      REPO_DIR: repo,
      HOST: '127.0.0.1',
      PORT: '0',
      REVIEW_PASSWORD: 'test-password',
      SEVERITY_GATE: 'major',
      MOCK_REPLY: 'minor',
      MOCK_CONTEXT: 'OWNER_ACCESS_RULE',
      MOCK_STANDALONE: '1',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => server.kill());
  const base = await Promise.race([
    once(server.stdout, 'data').then(([data]) => data.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]),
    once(server, 'exit').then(([code]) => assert.fail(`Dashboard exited with status ${code}`)),
  ]);
  assert.ok(base);
  const endpoint = base + '/api/review';
  const authorization = 'Basic ' + Buffer.from('review:test-password').toString('base64');
  const headers = { authorization };
  const post = (repoRoot, model, severityGate) => fetch(endpoint, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ repoRoot, model, severityGate }),
  });
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await post(outside)).status, 403);
  assert.equal((await post(path.join(repo, 'escape'))).status, 403);
  assert.equal((await post(repo, undefined, 'typo')).status, 400);
  const sendBody = (body) => fetch(endpoint, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body,
  });
  const malformed = await sendBody('{bad');
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Send a valid JSON body.' });
  const oversized = await sendBody(JSON.stringify({ repoRoot: 'x'.repeat(3 * 1024 * 1024) }));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: 'The request body is too large.' });
  for (const model of ['test/first', 'test/second']) {
    const response = await post(repo, model);
    assert.equal(response.status, 202);
    const { id } = await response.json();
    const stream = await fetch(`${endpoint}/${id}/stream`, { headers });
    assert.equal(stream.status, 200);
    const events = (await stream.text()).trim().split('\n\n')
      .map(message => JSON.parse(message.slice('data: '.length)));
    assert.deepEqual(events.filter(event => event.type === 'context').map(event => event.path), ['BUSINESS_LOGIC.md']);
    const event = events.at(-1);
    assert.equal(event.type, 'complete');
    assert.equal(event.report.model, model);
    assert.equal(event.report.findings[0].message, model);
    assert.equal(event.report.meta.reviewedFiles.length, 7);
    assert.deepEqual(event.report.usage, {
      inputTokens: 540,
      outputTokens: 120,
      costUsd: 0.0005,
      partial: false,
      totalTokens: 660,
    });
  }
});

test('oversized files are split into line ranges instead of truncated', async (t) => {
  const { repo } = fixture(t);
  const lines = Array.from({ length: 400 }, (_, i) => `export const v${i} = 'é${i}';\n`);
  writeFileSync(path.join(repo, 'big.js'), lines.join(''));
  writeFileSync(path.join(repo, 'small.js'), 'export const small = 1;\n');
  writeFileSync(path.join(repo, 'minified.js'), 'x'.repeat(5000) + '\nok();\n');

  const config = { include: ['**/*.js'], exclude: [], batch: { maxFiles: 6, maxBytes: 2000 } };
  const { batches, truncated } = await buildBatches(repo, config);
  const parts = batches.flatMap(b => b.files).filter(f => f.path === 'big.js');
  assert.ok(parts.length > 1);
  assert.equal(parts.map(f => f.content).join(''), lines.join(''));
  let next = 1;
  for (const part of parts) {
    assert.ok(Buffer.byteLength(part.content) <= 2000);
    assert.equal(part.startLine, next);
    assert.equal(part.totalLines, 400);
    next = part.endLine + 1;
  }
  assert.equal(next, 401);
  assert.deepEqual(truncated, ['minified.js']);

  const [clipped] = splitLines('€'.repeat(10), 7);
  assert.equal(clipped.text, '€€');
  assert.equal(clipped.truncated, true);
});

test('oversized diffs are split into valid hunks covering every change', (t) => {
  const { repo } = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const oldLines = Array.from({ length: 600 }, (_, i) => `line ${i}\n`);
  const newLines = oldLines.flatMap((line, i) => {
    if (i % 7 === 0) return [];
    if (i % 5 === 0) return [`changed ${i}\n`, `added ${i}\n`];
    return [line];
  });
  const file = path.join(repo, 'file.txt');
  git('init', '-q');
  writeFileSync(file, oldLines.join(''));
  git('add', 'file.txt');
  writeFileSync(file, newLines.join(''));
  const diffText = git('diff', '-U2', '--', 'file.txt');

  const maxBytes = 1500;
  const units = batchDiffs([{ file: 'file.txt', diffText }], maxBytes);
  assert.ok(units.length > 2);
  const header = diffText.slice(0, diffText.indexOf('\n@@') + 1);
  units.forEach((unit, i) => {
    assert.equal(unit.label, `file.txt (part ${i + 1}/${units.length})`);
    assert.equal(unit.truncated, false);
    assert.ok(unit.diffText.startsWith(header));
    assert.ok(Buffer.byteLength(unit.diffText) <= maxBytes);
  });

  // Reassemble every part's hunks into one patch: git must accept it and reproduce the change.
  const patch = header + units.map(u => u.diffText.slice(header.length)).join('');
  writeFileSync(path.join(repo, 'split.patch'), patch);
  git('checkout', '--', 'file.txt');
  git('apply', '--unidiff-zero', 'split.patch');
  assert.equal(readFileSync(file, 'utf8'), newLines.join(''));

  const long = header + '@@ -1 +1 @@\n-a\n+' + 'b'.repeat(4000) + '\n';
  const [clipped] = batchDiffs([{ file: 'file.txt', diffText: long }], maxBytes);
  assert.equal(clipped.truncated, true);
  assert.ok(Buffer.byteLength(clipped.diffText) <= maxBytes);
});
