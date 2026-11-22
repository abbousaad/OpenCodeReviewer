import { runOpenCode, sumUsage } from './opencodeClient.js';
import { diffReviewPrompt, batchReviewPrompt, parseFindings } from './prompts.js';

/**
 * Review one group of diff hunks (CI mode).
 * @param {object} unit - { label, diffText, files }
 */
export async function reviewDiffUnit(unit, { config, contextText }) {
  const prompt = diffReviewPrompt({ diffText: unit.diffText, contextText });
  return failClipped(await review(prompt, config.model, unit.label, unit.files), unit);
}

/**
 * Review one batch of whole files (standalone mode).
 * @param {object} batch - { label, files: [{ path, content }] }
 */
export async function reviewBatch(batch, { config, contextText }) {
  const prompt = batchReviewPrompt({ files: batch.files, contextText });
  const fileNames = batch.files.map((f) => f.path);
  return failClipped(await review(prompt, config.model, batch.label, fileNames), batch);
}

// Code the model never saw cannot pass the gate: keep the findings, mark the batch failed.
function failClipped(result, unit) {
  if (!unit.truncated || result.error) return result;
  return {
    ...result,
    error: 'A line over the size limit was clipped, so part of this batch was not reviewed. ' +
      'Exclude generated or minified files, or raise the size limit.',
  };
}

async function review(prompt, model, label, files) {
  const { text, usage, error } = await runOpenCode(prompt, model);
  if (error) return { label, usage, error };
  try {
    return { label, usage, ...parseFindings(text, files) };
  } catch {
    // Retry once with the original evidence and a stricter output instruction.
  }

  const retryPrompt = `${prompt}

OUTPUT RETRY: Return one valid JSON object only. Escape quotation marks, backslashes,
and line breaks inside strings. Do not use Markdown fences or text outside the object.
Keep findings and the summary concise so the entire JSON object fits in the response.`;
  const retry = await runOpenCode(retryPrompt, model);
  const combinedUsage = sumUsage([usage, retry.usage]);
  if (retry.error) return { label, usage: combinedUsage, error: `Retry failed. ${retry.error}` };
  try {
    return { label, usage: combinedUsage, ...parseFindings(retry.text, files) };
  } catch (err) {
    return { label, usage: combinedUsage, error: `${err.message} The retry did not produce a valid review.` };
  }
}

/**
 * Run review units with at most `concurrency` in flight, invoking onProgress as
 * each starts and finishes. Units each expose { label } and a `run()` that
 * returns { findings, summary }. Results keep the order of `units`; `completed`
 * counts finished units, since they can finish out of order.
 */
export async function runUnits(units, { onProgress, concurrency = 1 } = {}) {
  const results = new Array(units.length);
  let next = 0;
  let completed = 0;

  const worker = async () => {
    while (next < units.length) {
      const i = next++;
      const unit = units[i];
      onProgress?.({ phase: 'start', index: i, total: units.length, label: unit.label });
      let result;
      try {
        result = await unit.run();
      } catch (err) {
        result = {
          label: unit.label,
          findings: [],
          summary: '',
          error: err?.message || String(err),
        };
      }
      results[i] = result;
      completed++;
      onProgress?.({
        phase: 'done',
        index: i,
        completed,
        total: units.length,
        label: unit.label,
        findingCount: result.findings?.length ?? 0,
        error: result.error,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, units.length) }, worker));
  return results;
}
