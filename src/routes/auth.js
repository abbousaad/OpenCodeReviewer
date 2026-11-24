import { isIP } from 'node:net';
import express from 'express';
import {
  USERNAME, attempt, authState, changePassword, createSession, endSession, touchSession,
} from '../core/auth.js';

const COOKIE = 'ocr_session';
const PUBLIC_PATHS = new Set(['/login.html', '/login.js', '/styles.css', '/api/auth/login', '/api/auth/session']);
// Paths a signed-in user can reach while the default password is still active.
const CHANGE_PATHS = new Set(['/api/auth/password', '/api/auth/logout', '/api/auth/session']);
const allowedHosts = new Set((process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));

/**
 * Accept only IP addresses, localhost and ALLOWED_HOSTS in the Host header.
 * A DNS rebinding page uses its own hostname, so it cannot reach the login,
 * which matters while the default password is active.
 */
export function hostGuard(req, res, next) {
  const hostname = (req.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(hostname) || hostname === 'localhost' || allowedHosts.has(hostname)) return next();
  res.status(403).json({ error: 'Open the dashboard by IP address or localhost, or add this hostname to ALLOWED_HOSTS.' });
}

/** Browsers cannot send JSON across origins without a preflight, and SameSite blocks the cookie. */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('Origin');
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== req.get('Host')) return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
  }
  // Uploads send a ZIP body. Like JSON, that content type needs a CORS
  // preflight, so a cross-site form still cannot send it.
  if (req.method === 'POST' && req.path === '/repos/upload' && req.is('application/zip')) return next();
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Send JSON with Content-Type: application/json.' });
  }
  next();
}

function sessionToken(req) {
  for (const part of (req.get('Cookie') || '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=');
  }
  return null;
}

/** Sign in with the session cookie, or with Basic auth for API clients. */
export function requireAuth(req, res, next) {
  const token = sessionToken(req);
  let authenticated = touchSession(token);
  if (!authenticated) {
    const basic = req.get('Authorization')?.match(/^Basic (.+)$/i)?.[1];
    if (basic) {
      const decoded = Buffer.from(basic, 'base64').toString('utf8');
      const split = decoded.indexOf(':');
      const result = attempt(req.ip, decoded.slice(0, split), decoded.slice(split + 1));
      if (result.retryAfterMs) return tooManyAttempts(res, result.retryAfterMs);
      authenticated = result.ok;
    }
  }
  req.authenticated = authenticated;
  req.sessionToken = authenticated ? token : null;
  if (PUBLIC_PATHS.has(req.path)) return next();

  const isApi = req.path.startsWith('/api/');
  if (!authenticated) {
    if (isApi) return res.status(401).json({ error: 'Sign in first.' });
    return res.redirect('/login.html');
  }
  if (authState().mustChangePassword && !CHANGE_PATHS.has(req.path)) {
    if (isApi) return res.status(403).json({ error: 'Change the default password first.', mustChangePassword: true });
    return res.redirect('/login.html');
  }
  next();
}

function tooManyAttempts(res, retryAfterMs) {
  res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
  res.status(429).json({ error: 'Too many failed sign-in attempts. Try again later.' });
}

function setCookie(req, res, token, maxAgeSeconds) {
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`);
}

const router = express.Router();

router.get('/session', (req, res) => {
  res.json({ authenticated: req.authenticated, username: USERNAME, ...authState() });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const result = attempt(req.ip, username, password);
  if (result.retryAfterMs) return tooManyAttempts(res, result.retryAfterMs);
  if (!result.ok) return res.status(401).json({ error: 'Wrong username or password.' });
  setCookie(req, res, createSession(), 12 * 60 * 60);
  res.json(authState());
});

router.post('/logout', (req, res) => {
  endSession(req.sessionToken);
  setCookie(req, res, '', 0);
  res.json({ ok: true });
});

router.post('/password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const error = changePassword(currentPassword, newPassword, req.sessionToken);
  if (error) return res.status(authState().passwordFromEnv ? 409 : 400).json({ error });
  res.json(authState());
});

export default router;
