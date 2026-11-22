import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { ROOT } from './config.js';

const execFileP = promisify(execFile);
let runOptions;

/**
 * Run one headless OpenCode request with the model selected for this review.
 */
export async function runOpenCode(prompt, model) {
  const env = { ...process.env };
  delete env.REVIEW_PASSWORD;
  if (!env.OPENCODE_CONFIG) {
    env.OPENCODE_CONFIG = path.join(ROOT, 'opencode.json');
  }
  const timeout = Number(process.env.OC_TIMEOUT_MS || 180000);
  let stdout = '';
  let failure;
  try {
    // OpenCode 1.x runs privately by default. OpenCode 2.x exposes this flag.
    // Parallel batches share one check; a failed check is retried next time.
    runOptions ??= execFileP('opencode', ['run', '--help'], { env, timeout })
      .then(({ stdout }) => (/^\s*--standalone\b/m.test(stdout) ? ['--standalone'] : []))
      .catch((err) => {
        runOptions = undefined;
        throw err;
      });
    const args = ['run', ...(await runOptions), '--format', 'json', '-m', model];
    const invocation = execFileP('opencode', args, {
      env,
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    });
    // Send the prompt on stdin: Linux caps one argument at 128 KiB (E2BIG).
    // A write error means OpenCode exited early, which the exit status reports.
    invocation.child.stdin.on('error', () => {});
    invocation.child.stdin.end(prompt);
    ({ stdout } = await invocation);
  } catch (err) {
    // Node's error message can include the prompt from the command arguments.
    const detail = err.stderr?.trim().split('\n').slice(-3).join(' ');
    stdout = err.stdout || '';
    failure = `opencode run failed: ${detail || err.signal || err.code || 'unknown error'}`;
  }
  const result = parseRunOutput(stdout);
  result.error ??= failure;
  if (result.error) result.usage.partial = true;
  return result;
}

function parseRunOutput(stdout) {
  const text = [];
  const usage = { inputTokens: null, outputTokens: null, costUsd: null, partial: false };
  const stepIds = new Set();
  let started = 0;
  let finished = 0;
  let lastReason;
  let error;

  for (const line of stdout.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === 'text' && typeof event.part?.text === 'string') text.push(event.part.text);
    if (event?.type === 'error') {
      const detail = event.error?.data?.message ?? event.error?.message;
      error = typeof detail === 'string' ? `OpenCode: ${detail}` : 'OpenCode reported a review error.';
    }
    if (event?.type === 'step_start') started += 1;
    if (event?.type !== 'step_finish' || !event.part) continue;

    const { id, tokens, cost, reason } = event.part;
    if (id && stepIds.has(id)) continue;
    if (id) stepIds.add(id);
    finished += 1;
    lastReason = reason;

    const input = [tokens?.input, tokens?.cache?.read ?? 0, tokens?.cache?.write ?? 0];
    const output = [tokens?.output, tokens?.reasoning ?? 0];
    if (input.every(isTokenCount) && output.every(isTokenCount)) {
      // OpenCode separates cached input and reasoning output from the base counts.
      usage.inputTokens = input.reduce((sum, count) => sum + count, usage.inputTokens ?? 0);
      usage.outputTokens = output.reduce((sum, count) => sum + count, usage.outputTokens ?? 0);
    } else {
      usage.partial = true;
    }
    // OpenCode can emit zero when it has no catalog price for a model.
    if (Number.isFinite(cost) && cost > 0) usage.costUsd = (usage.costUsd ?? 0) + cost;
    else usage.partial = true;
  }

  if (!finished || finished < started || lastReason === 'tool-calls') usage.partial = true;
  return { text: text.join('').trim(), usage, error };
}

function isTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function sumUsage(measurements) {
  const initial = measurements.length ? null : 0;
  const usage = { inputTokens: initial, outputTokens: initial, costUsd: initial, partial: false };
  for (const measured of measurements) {
    usage.partial ||= !measured || measured.partial;
    for (const field of ['inputTokens', 'outputTokens', 'costUsd']) {
      if (measured?.[field] != null) usage[field] = (usage[field] ?? 0) + measured[field];
    }
  }
  return {
    ...usage,
    totalTokens: usage.inputTokens == null ? null : usage.inputTokens + usage.outputTokens,
  };
}
