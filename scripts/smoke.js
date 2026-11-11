#!/usr/bin/env node
// Minimal end-to-end check that OpenCode answers a prompt.
import { loadConfig } from '../src/core/config.js';
import { runOpenCode } from '../src/core/opencodeClient.js';

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY is not set — the model call will fail.');
  }
  const config = loadConfig();
  console.log(`[smoke] model=${config.model}`);
  const { text: reply, error } = await runOpenCode('Reply with exactly the word: pong', config.model);
  if (error) throw new Error(error);
  console.log('[smoke] model reply:', JSON.stringify(reply));

  if (!reply) {
    console.error('[smoke] empty reply — check provider/auth config.');
    process.exit(1);
  }
  console.log('[smoke] ✅ ok');
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] failed:', err?.stack || err);
  process.exit(1);
});
