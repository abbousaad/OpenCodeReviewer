import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import reviewRouter from './routes/review.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const password = process.env.REVIEW_PASSWORD;
const loopbackHosts = ['localhost', '127.0.0.1', '::1'];

if (!password && !loopbackHosts.includes(host)) {
  throw new Error('Set REVIEW_PASSWORD to listen outside loopback.');
}

app.get('/healthz', (req, res) => res.json({ ok: true }));
if (password) {
  const expectedToken = Buffer.from(Buffer.from(`review:${password}`).toString('base64'));
  app.use((req, res, next) => {
    const token = Buffer.from(req.get('Authorization')?.match(/^Basic (.+)$/i)?.[1] || '');
    if (token.length === expectedToken.length && timingSafeEqual(token, expectedToken)) return next();
    res.set('WWW-Authenticate', 'Basic realm="OpenCodeReviewer", charset="UTF-8"');
    res.status(401).send('Authentication required.');
  });
} else {
  app.use((req, res, next) => {
    if (loopbackHosts.includes(req.hostname) || req.hostname === '[::1]') return next();
    res.status(403).send('Use a loopback address to open the dashboard.');
  });
}
app.use(express.json({ limit: '2mb' }));
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
});
