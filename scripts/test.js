import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildBatches } from '../src/core/batcher.js';
import { splitLines } from '../src/core/chunk.js';
import { ConfigError, loadConfig } from '../src/core/config.js';
import { batchDiffs } from '../src/core/diff.js';
import { runUnits } from '../src/core/reviewer.js';

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
const trace = (event) => process.env.MOCK_TRACE
  && require('node:fs').appendFileSync(process.env.MOCK_TRACE, event + ' ' + Date.now() + '\\n');
if (args[1] === '--help') {
  trace('help');
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
if (process.env.MOCK_EXPECT_KEY !== undefined && process.env.DEEPSEEK_API_KEY !== process.env.MOCK_EXPECT_KEY) process.exit(2);
trace('start');
if (process.env.MOCK_DELAY_MS) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.MOCK_DELAY_MS));
}
trace('end');
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
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, DATA_DIR: path.join(root, 'data') };
  for (const name of ['REVIEW_PASSWORD', 'DEEPSEEK_API_KEY', 'OC_MODEL', 'SEVERITY_GATE']) delete env[name];
  return { root, repo, env };
}

async function startDashboard(t, env) {
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { HOST: '127.0.0.1', PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  server.stderr.on('data', (data) => { stderr += data; });
  t.after(() => server.kill());
  // The data directory line comes last in the startup output.
  const started = new Promise((resolve) => server.stdout.on('data', (data) => {
    stdout += data;
    if (stdout.includes('data directory:')) resolve();
  }));
  await Promise.race([
    started,
    once(server, 'exit').then(([code]) => assert.fail(`Dashboard exited with status ${code}: ${stderr}`)),
  ]);
  const base = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(base);
  return { base, server, stdout };
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
    ['critical', 'typo', 2],
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

  const { base } = await startDashboard(t, {
    ...env,
    REPO_DIR: repo,
    REVIEW_PASSWORD: 'test-password',
    SEVERITY_GATE: 'major',
    MOCK_REPLY: 'minor',
    MOCK_CONTEXT: 'OWNER_ACCESS_RULE',
    MOCK_STANDALONE: '1',
  });
  const endpoint = base + '/api/review';
  const authorization = 'Basic ' + Buffer.from('ocr-admin:test-password').toString('base64');
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

test('config layers apply in order and the reviewed repo cannot set the gate or model', (t) => {
  const { root, repo } = fixture(t);
  const saved = { OC_MODEL: process.env.OC_MODEL, SEVERITY_GATE: process.env.SEVERITY_GATE };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  delete process.env.OC_MODEL;
  delete process.env.SEVERITY_GATE;

  writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({
    exclude: ['**/skip/**'],
    batch: { maxFiles: 2 },
    severityGate: 'critical',
    model: 'attacker/model',
    concurrency: 16,
  }));
  const fromRepo = loadConfig({ repoRoot: repo });
  assert.deepEqual(fromRepo.exclude, ['**/skip/**']);
  assert.deepEqual(fromRepo.batch, { maxFiles: 2, maxBytes: 48000 });
  assert.equal(fromRepo.severityGate, 'major');
  assert.equal(fromRepo.model, 'deepseek/deepseek-flash');
  assert.equal(fromRepo.sources.at(-1), realpathSync(path.join(repo, 'review.config.json')));
  assert.equal(fromRepo.warnings.length, 1);
  assert.equal(fromRepo.concurrency, 3);
  assert.match(fromRepo.warnings[0], /ignored severityGate, model, concurrency/);

  const explicit = path.join(root, 'ci.config.json');
  writeFileSync(explicit, JSON.stringify({ severityGate: 'minor', batch: { maxBytes: 1000 } }));
  const withFile = loadConfig({ repoRoot: repo, configPath: explicit });
  assert.equal(withFile.severityGate, 'minor');
  assert.deepEqual(withFile.batch, { maxFiles: 2, maxBytes: 1000 });

  process.env.SEVERITY_GATE = 'info';
  process.env.OC_MODEL = 'env/model';
  const withEnv = loadConfig({ repoRoot: repo, configPath: explicit });
  assert.equal(withEnv.severityGate, 'info');
  assert.equal(withEnv.model, 'env/model');
  const withFlags = loadConfig({
    repoRoot: repo,
    configPath: explicit,
    overrides: { severityGate: 'critical', model: 'flag/model' },
  });
  assert.equal(withFlags.severityGate, 'critical');
  assert.equal(withFlags.model, 'flag/model');
  delete process.env.SEVERITY_GATE;
  delete process.env.OC_MODEL;

  // A repo config symlinked from outside the repo is ignored.
  rmSync(path.join(repo, 'review.config.json'));
  symlinkSync(explicit, path.join(repo, 'review.config.json'));
  assert.equal(loadConfig({ repoRoot: repo }).severityGate, 'major');
  assert.deepEqual(loadConfig({ repoRoot: repo }).batch, { maxFiles: 6, maxBytes: 48000 });

  for (const [content, message] of [
    ['{bad', /is not valid JSON/],
    ['[]', /must contain a JSON object/],
    ['{"exlude": []}', /exlude is not a known key/],
    ['{"batch": {"maxFiles": 0}}', /batch\.maxFiles must be a positive integer/],
    ['{"include": "**/*.js"}', /include must be a list of nonempty strings/],
    ['{"severityGate": "typo"}', /severityGate must be one of/],
    ['{"concurrency": 0}', /concurrency must be an integer from 1 to 16/],
  ]) {
    writeFileSync(explicit, content);
    assert.throws(() => loadConfig({ configPath: explicit }), (err) => err instanceof ConfigError && message.test(err.message));
  }
  assert.throws(() => loadConfig({ configPath: path.join(root, 'missing.json') }), /Could not read config file/);
});

test('CI flags override the environment, and invalid flags or config exit 2', (t) => {
  const { root, repo, env } = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  const commit = () => git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture', '--allow-empty');
  git('init', '-q');
  commit();
  writeFileSync(path.join(repo, 'changed.js'), 'export const changed = true;\n');
  writeFileSync(path.join(repo, 'BUSINESS_LOGIC.md'), 'OWNER_ACCESS_RULE');
  git('add', '.');
  commit();
  const ci = (args, extraEnv = {}) => spawnSync(process.execPath, ['src/cli.js', 'ci', repo, '--base', 'HEAD^', ...args], {
    env: { ...env, REPORT_DIR: repo, MOCK_STANDALONE: '0', MOCK_REPLY: 'major', SEVERITY_GATE: 'critical', ...extraEnv },
    encoding: 'utf8',
    timeout: 5000,
  });
  const report = () => JSON.parse(readFileSync(path.join(repo, 'review-report.json'), 'utf8'));

  // The environment's critical gate passes a major finding. --gate major fails it.
  assert.equal(ci([]).status, 0);
  const flagged = ci(['--gate', 'major', '--model', 'test/flag']);
  assert.equal(flagged.status, 1, flagged.stderr);
  assert.equal(report().severityGate, 'major');
  assert.equal(report().model, 'test/flag');
  assert.equal(report().findings[0].message, 'test/flag');

  const explicit = path.join(root, 'ci.config.json');
  writeFileSync(explicit, JSON.stringify({ exclude: ['changed.js'] }));
  const excluded = ci(['--config', explicit]);
  assert.equal(excluded.status, 0, excluded.stderr);
  assert.deepEqual(report().meta.changedFiles, []);
  assert.match(excluded.stdout, /config: .*ci\.config\.json/);

  writeFileSync(explicit, '{"batch": {"maxFiles": "six"}}');
  for (const [args, message] of [
    [['--gate', 'typo'], /--gate must be one of/],
    [['--model', 'no-slash'], /--model must be in provider\/model format/],
    [['--config', ''], /require nonempty values/],
    [['--concurrency', '0'], /--concurrency must be an integer from 1 to 16/],
    [['--concurrency', '17'], /--concurrency must be an integer from 1 to 16/],
    [['--concurrency', '2.5'], /--concurrency must be an integer from 1 to 16/],
    [['--config', explicit], /batch\.maxFiles must be a positive integer/],
    [['--config', path.join(root, 'missing.json')], /Could not read config file/],
  ]) {
    const run = ci(args);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, message);
  }
});

test('runUnits keeps at most `concurrency` units in flight and results in order', async () => {
  for (const concurrency of [1, 3]) {
    let active = 0;
    let maxActive = 0;
    const completed = [];
    const units = Array.from({ length: 10 }, (_, i) => ({
      label: `unit ${i}`,
      run: async () => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise((resolve) => setTimeout(resolve, (i * 7) % 20));
        active--;
        if (i === 4) throw new Error('boom');
        return { label: `unit ${i}`, findings: [{ i }], summary: '' };
      },
    }));
    const results = await runUnits(units, {
      concurrency,
      onProgress: (p) => p.phase === 'done' && completed.push(p.completed),
    });
    assert.equal(maxActive, concurrency);
    assert.deepEqual(results.map((r) => r.label), units.map((u) => u.label));
    assert.equal(results[4].error, 'boom');
    assert.equal(results.filter((r) => r.error).length, 1);
    assert.deepEqual(completed, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  }
  assert.deepEqual(await runUnits([], { concurrency: 4 }), []);
});

test('CI reviews diff batches in parallel up to --concurrency', { timeout: 20000 }, (t) => {
  const { root, repo, env } = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  const commit = () => git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture', '--allow-empty');
  git('init', '-q');
  commit();
  for (let i = 1; i <= 6; i++) writeFileSync(path.join(repo, `file-${i}.js`), `export const value${i} = ${i};\n`);
  git('add', '.');
  commit();
  // Small diff batches put each file in its own unit.
  const explicit = path.join(root, 'ci.config.json');
  writeFileSync(explicit, JSON.stringify({ diff: { maxHunkBytesPerCall: 200 } }));

  for (const concurrency of [1, 3]) {
    const tracePath = path.join(root, `trace-${concurrency}.log`);
    const run = spawnSync(process.execPath, [
      'src/cli.js', 'ci', repo, '--base', 'HEAD^', '--config', explicit, '--concurrency', String(concurrency),
    ], {
      env: { ...env, REPORT_DIR: repo, MOCK_STANDALONE: '0', MOCK_REPLY: 'minor', MOCK_TRACE: tracePath, MOCK_DELAY_MS: '400' },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /6 changed file\(s\) to review in 6 batch\(es\)/);
    assert.match(run.stdout, new RegExp(`concurrency=${concurrency}`));
    assert.match(run.stdout, /\[6\/6 done\]/);

    const events = readFileSync(tracePath, 'utf8').trim().split('\n').map((line) => line.split(' '));
    assert.equal(events.filter(([type]) => type === 'help').length, 1);
    let active = 0;
    let maxActive = 0;
    // On equal timestamps, count an end before a start so overlap is not overstated.
    for (const [type] of events.filter(([type]) => type !== 'help')
      .sort((a, b) => a[1] - b[1] || (a[0] === 'end' ? -1 : 1))) {
      active += type === 'start' ? 1 : -1;
      maxActive = Math.max(maxActive, active);
    }
    assert.equal(maxActive, concurrency);

    const report = JSON.parse(readFileSync(path.join(repo, 'review-report.json'), 'utf8'));
    assert.deepEqual(report.findings.map((f) => f.file), report.findings.map((f) => f.file).toSorted());
    assert.equal(report.findings.length, 6);
  }
});

test('CI --dry-run lists the batches a real run reviews without calling the model', { timeout: 20000 }, (t) => {
  const { root, repo, env } = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  const commit = () => git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture', '--allow-empty');
  git('init', '-q');
  commit();
  for (let i = 1; i <= 4; i++) writeFileSync(path.join(repo, `file-${i}.js`), `export const value${i} = ${i};\n`);
  writeFileSync(path.join(repo, 'skipped.js'), 'export const skipped = true;\n');
  writeFileSync(path.join(repo, 'BUSINESS_LOGIC.md'), 'OWNER_ACCESS_RULE');
  git('add', '.');
  commit();
  const explicit = path.join(root, 'ci.config.json');
  writeFileSync(explicit, JSON.stringify({ diff: { maxHunkBytesPerCall: 400 }, exclude: ['skipped.js'] }));
  const reports = path.join(root, 'reports');
  mkdirSync(reports);
  const tracePath = path.join(root, 'trace.log');
  const ci = (...args) => spawnSync(process.execPath, ['src/cli.js', 'ci', repo, '--base', 'HEAD^', '--config', explicit, ...args], {
    env: { ...env, REPORT_DIR: reports, MOCK_STANDALONE: '0', MOCK_REPLY: '', MOCK_TRACE: tracePath },
    encoding: 'utf8',
    timeout: 15000,
  });

  const dry = ci('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.throws(() => readFileSync(tracePath), { code: 'ENOENT' });
  assert.deepEqual(readdirSync(reports), []);
  assert.match(dry.stdout, /dry run: no model calls, no report files/);
  assert.match(dry.stdout, /using context: BUSINESS_LOGIC\.md/);
  assert.doesNotMatch(dry.stdout, /skipped\.js/);
  const planned = [...dry.stdout.matchAll(/batch \d+\/\d+: (.+) — \d+ file\(s\), [\d.]+ KB diff, ~([\d,]+) input tokens/g)];
  assert.ok(planned.length > 1);
  const listed = [...dry.stdout.matchAll(/^ {4}(\S+)$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(listed, ['file-1.js', 'file-2.js', 'file-3.js', 'file-4.js']);
  const total = Number(dry.stdout.match(/total: ~([\d,]+) estimated input tokens/)[1].replaceAll(',', ''));
  assert.equal(total, planned.reduce((sum, m) => sum + Number(m[2].replaceAll(',', '')), 0));

  const real = ci();
  assert.equal(real.status, 0, real.stderr);
  const reviewed = [...real.stdout.matchAll(/\[\d+\/\d+ done\] (.+) — /g)].map((m) => m[1]).sort();
  assert.deepEqual(reviewed, planned.map((m) => m[1]).sort());
});

test('dashboard requires a new password before the default login can do anything', { timeout: 20000 }, async (t) => {
  const { repo, env } = fixture(t);
  const dashboardEnv = { ...env, REPO_DIR: repo };
  let { base, server, stdout } = await startDashboard(t, dashboardEnv);
  const json = { 'content-type': 'application/json' };
  const login = (password, headers = {}) => fetch(base + '/api/auth/login', {
    method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify({ username: 'ocr-admin', password }),
  });
  const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

  assert.match(stdout, /Sign in as ocr-admin \/ ocr-admin/);
  assert.equal((await fetch(base + '/api/review')).status, 401);
  const page = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login.html');
  assert.equal((await fetch(base + '/login.html')).status, 200);
  assert.match((await fetch(base + '/login.html')).headers.get('content-security-policy'), /default-src 'self'/);

  // DNS rebinding pages use their own hostname; cross-origin and non-JSON posts are refused.
  // fetch() drops a custom Host header, so send this one with node:http.
  const rebound = await new Promise((resolve, reject) => {
    http.get(base + '/login.html', { headers: { host: 'evil.example:80' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(rebound, 403);
  assert.equal((await login('ocr-admin', { origin: 'http://evil.example' })).status, 403);
  const form = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=ocr-admin',
  });
  assert.equal(form.status, 415);

  const first = await login('ocr-admin');
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { mustChangePassword: true, passwordFromEnv: false });
  const setCookie = first.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = cookieOf(first);
  const blocked = await fetch(base + '/api/review', { headers: { cookie } });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).mustChangePassword, true);
  const basicDefault = 'Basic ' + Buffer.from('ocr-admin:ocr-admin').toString('base64');
  assert.equal((await fetch(base + '/api/review', { headers: { authorization: basicDefault } })).status, 403);

  const change = (currentPassword, newPassword) => fetch(base + '/api/auth/password', {
    method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ currentPassword, newPassword }),
  });
  assert.equal((await change('ocr-admin', 'too-short')).status, 400);
  assert.equal((await change('wrong', 'a-new-long-password')).status, 400);
  assert.equal((await change('ocr-admin', 'ocr-admin')).status, 400);
  const changed = await change('ocr-admin', 'a-new-long-password');
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).mustChangePassword, false);
  assert.equal((await fetch(base + '/api/review', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(base + '/', { headers: { cookie } })).status, 200);
  const saved = JSON.parse(readFileSync(path.join(env.DATA_DIR, 'auth.json'), 'utf8'));
  assert.equal(saved.username, 'ocr-admin');
  assert.ok(!JSON.stringify(saved).includes('a-new-long-password'));
  if (process.platform !== 'win32') {
    assert.equal(statSync(path.join(env.DATA_DIR, 'auth.json')).mode & 0o777, 0o600);
  }

  const logout = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { ...json, cookie }, body: '{}' });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(base + '/api/review', { headers: { cookie } })).status, 401);

  // The new password survives a restart, and the default no longer works.
  server.kill();
  await once(server, 'exit');
  ({ base, server, stdout } = await startDashboard(t, dashboardEnv));
  assert.doesNotMatch(stdout, /Sign in as ocr-admin/);
  assert.equal((await login('ocr-admin')).status, 401);
  const again = await login('a-new-long-password');
  assert.equal(again.status, 200);
  assert.equal((await again.json()).mustChangePassword, false);
  const basic = 'Basic ' + Buffer.from('ocr-admin:a-new-long-password').toString('base64');
  assert.equal((await fetch(base + '/api/review', { headers: { authorization: basic } })).status, 200);

  // Five failures lock the address out, even for the right password.
  for (let i = 0; i < 4; i++) assert.equal((await login('wrong-password')).status, 401);
  const locked = await login('wrong-password');
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal((await login('a-new-long-password')).status, 429);
});

test('REVIEW_PASSWORD replaces the default login and cannot be changed in the dashboard', { timeout: 10000 }, async (t) => {
  const { repo, env } = fixture(t);
  const { base, stdout } = await startDashboard(t, { ...env, REPO_DIR: repo, REVIEW_PASSWORD: 'from-the-environment' });
  assert.doesNotMatch(stdout, /Sign in as ocr-admin/);
  const json = { 'content-type': 'application/json' };
  assert.equal((await fetch(base + '/api/auth/login', {
    method: 'POST', headers: json, body: JSON.stringify({ username: 'ocr-admin', password: 'ocr-admin' }),
  })).status, 401);
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: json, body: JSON.stringify({ username: 'ocr-admin', password: 'from-the-environment' }),
  });
  assert.deepEqual(await res.json(), { mustChangePassword: false, passwordFromEnv: true });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const change = await fetch(base + '/api/auth/password', {
    method: 'POST',
    headers: { ...json, cookie },
    body: JSON.stringify({ currentPassword: 'from-the-environment', newPassword: 'another-long-password' }),
  });
  assert.equal(change.status, 409);
  assert.throws(() => readFileSync(path.join(env.DATA_DIR, 'auth.json')), { code: 'ENOENT' });
});

test('dashboard settings are validated, saved, applied to runs and never echo secrets', { timeout: 20000 }, async (t) => {
  const { repo, env } = fixture(t);
  writeFileSync(path.join(repo, 'source.js'), 'export const reviewed = true;\n');
  writeFileSync(path.join(repo, 'BUSINESS_LOGIC.md'), 'OWNER_ACCESS_RULE');
  const secret = 'sk-test-secret-value';
  const dashboardEnv = {
    ...env, REPO_DIR: repo, REVIEW_PASSWORD: 'test-password', MOCK_REPLY: 'minor', MOCK_STANDALONE: '1', MOCK_EXPECT_KEY: secret,
  };
  let { base, server } = await startDashboard(t, dashboardEnv);
  const headers = {
    authorization: 'Basic ' + Buffer.from('ocr-admin:test-password').toString('base64'),
    'content-type': 'application/json',
  };
  const bodies = [];
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers, body: body && JSON.stringify(body) });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, data: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
  };

  const initial = await call('GET', '/api/settings');
  assert.equal(initial.status, 200);
  assert.equal(initial.data.settings.model, 'deepseek/deepseek-flash');
  assert.equal(initial.data.settings.concurrency, 3);
  assert.deepEqual(initial.data.locked, {});
  assert.deepEqual(initial.data.secrets.deepseekApiKey, { label: 'DeepSeek API key', set: false, fromEnv: false });
  assert.ok(initial.data.models.some((m) => m.id === 'deepseek/deepseek-v4-pro'));

  const invalid = await call('PUT', '/api/settings', {
    settings: { concurrency: 40, batch: { maxFiles: 0 }, include: 'src/**', bogus: 1, model: 'no-slash' },
    secrets: { deepseekApiKey: 'has spaces', other: 'x' },
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(Object.keys(invalid.data.fields).sort(), [
    'batch.maxFiles', 'bogus', 'concurrency', 'include', 'model', 'secrets.deepseekApiKey', 'secrets.other',
  ]);
  assert.throws(() => readFileSync(path.join(env.DATA_DIR, 'settings.json')), { code: 'ENOENT' });

  const saved = await call('PUT', '/api/settings', {
    settings: { model: 'test/saved', concurrency: 2, batch: { maxFiles: 1 }, exclude: ['**/skip/**'] },
    secrets: { deepseekApiKey: secret, githubToken: 'ghp_example' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.settings.model, 'test/saved');
  assert.deepEqual(saved.data.settings.batch, { maxFiles: 1, maxBytes: 48000 });
  assert.equal(saved.data.secrets.deepseekApiKey.set, true);
  assert.equal(saved.data.secrets.githubToken.set, true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(path.join(env.DATA_DIR, 'secrets.json')).mode & 0o777, 0o600);
  }
  assert.equal((await call('GET', '/api/config')).data.model, 'test/saved');

  // A run uses the saved model and batch size, and OpenCode receives the saved key.
  mkdirSync(path.join(repo, 'skip'));
  writeFileSync(path.join(repo, 'skip', 'ignored.js'), 'export const ignored = true;\n');
  writeFileSync(path.join(repo, 'second.js'), 'export const second = true;\n');
  const started = await call('POST', '/api/review', { repoRoot: repo });
  assert.equal(started.status, 202);
  const stream = await fetch(`${base}/api/review/${started.data.id}/stream`, { headers });
  const events = (await stream.text()).trim().split('\n\n').map((m) => JSON.parse(m.slice('data: '.length)));
  const done = events.at(-1);
  assert.equal(done.type, 'complete');
  assert.deepEqual(done.report.errors, []);
  assert.equal(done.report.model, 'test/saved');
  assert.deepEqual(done.report.meta.reviewedFiles.sort(), ['second.js', 'source.js']);
  assert.equal(events.filter((e) => e.type === 'batch-done').length, 2);

  // Settings survive a restart; null resets a key and clears a secret.
  server.kill();
  await once(server, 'exit');
  ({ base, server } = await startDashboard(t, dashboardEnv));
  assert.equal((await call('GET', '/api/settings')).data.settings.model, 'test/saved');
  const reset = await call('PUT', '/api/settings', { settings: { model: null }, secrets: { githubToken: null } });
  assert.equal(reset.data.settings.model, 'deepseek/deepseek-flash');
  assert.equal(reset.data.secrets.githubToken.set, false);
  assert.equal(reset.data.secrets.deepseekApiKey.set, true);

  for (const body of bodies) {
    assert.ok(!body.includes(secret) && !body.includes('ghp_example'), 'a response contained a secret');
  }
});

test('environment variables lock the matching settings', { timeout: 10000 }, async (t) => {
  const { repo, env } = fixture(t);
  const { base } = await startDashboard(t, {
    ...env, REPO_DIR: repo, REVIEW_PASSWORD: 'test-password', OC_MODEL: 'env/model', DEEPSEEK_API_KEY: 'from-env',
  });
  const headers = {
    authorization: 'Basic ' + Buffer.from('ocr-admin:test-password').toString('base64'),
    'content-type': 'application/json',
  };
  const view = await (await fetch(base + '/api/settings', { headers })).json();
  assert.deepEqual(view.locked, { model: 'OC_MODEL' });
  assert.equal(view.settings.model, 'env/model');
  assert.deepEqual(view.secrets.deepseekApiKey, { label: 'DeepSeek API key', set: true, fromEnv: true });
  const res = await fetch(base + '/api/settings', {
    method: 'PUT', headers, body: JSON.stringify({ settings: { model: 'test/other' }, secrets: { deepseekApiKey: 'x' } }),
  });
  assert.equal(res.status, 400);
  const { fields } = await res.json();
  assert.deepEqual(fields, { model: 'is set by OC_MODEL', 'secrets.deepseekApiKey': 'is set by DEEPSEEK_API_KEY' });
});

test('saved settings sit between the bundled file and the reviewed repo file', (t) => {
  const { repo } = fixture(t);
  const saved = { OC_MODEL: process.env.OC_MODEL, SEVERITY_GATE: process.env.SEVERITY_GATE };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  delete process.env.OC_MODEL;
  delete process.env.SEVERITY_GATE;
  writeFileSync(path.join(repo, 'review.config.json'), JSON.stringify({ exclude: ['from-repo'] }));
  const cfg = loadConfig({ repoRoot: repo, settings: { exclude: ['from-settings'], severityGate: 'minor' } });
  assert.deepEqual(cfg.exclude, ['from-repo']);
  assert.equal(cfg.severityGate, 'minor');
  assert.ok(cfg.sources.includes('saved settings'));
  assert.equal(loadConfig({ overrides: { severityGate: 'info' }, settings: { severityGate: 'minor' } }).severityGate, 'info');
  assert.throws(() => loadConfig({ settings: { concurrency: 0 } }), /Saved settings: concurrency must be an integer/);
});
