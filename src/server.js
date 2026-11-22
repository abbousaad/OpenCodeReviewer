import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { initAuth } from './core/auth.js';
import { DATA_DIR, ensureDataDir } from './core/store.js';
import authRouter, { csrfGuard, hostGuard, requireAuth } from './routes/auth.js';
import reviewRouter from './routes/review.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);

ensureDataDir();
const auth = initAuth();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(hostGuard);
app.use(express.json({ limit: '2mb' }));
app.use('/api', csrfGuard);
app.use(requireAuth);
app.use('/api/auth', authRouter);
app.use('/api', reviewRouter);
app.use(express.static(path.join(__dirname, 'public')));

// Answer request errors with JSON instead of Express's HTML page, which shows
// stack traces unless NODE_ENV=production.
const bodyErrors = {
  'entity.parse.failed': 'Send a valid JSON body.',
  'entity.too.large': 'The request body is too large.',
};
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('[OpenCodeReviewer] request failed:', err);
  const fallback = status === 500 ? 'Internal server error.' : 'Bad request.';
  res.status(status).json({ error: bodyErrors[err.type] || fallback });
});

const server = app.listen(port, host, () => {
  const address = host === '::1' ? '[::1]' : host;
  console.log(`[OpenCodeReviewer] dashboard listening on http://${address}:${server.address().port}`);
  console.log('[OpenCodeReviewer] standalone batch review — mount a repo and point the UI at it.');
  if (auth.mustChangePassword) {
    console.log('[OpenCodeReviewer] ⚠️  Sign in as ocr-admin / ocr-admin and set a new password. ' +
      'Until then, anyone who can reach this port can do the same.');
  }
  console.log(`[OpenCodeReviewer] data directory: ${DATA_DIR}`);
});
