import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readJson, writeJson } from './store.js';

export const USERNAME = 'ocr-admin';
export const DEFAULT_PASSWORD = 'ocr-admin';
export const MIN_PASSWORD_LENGTH = 12;
const AUTH_FILE = 'auth.json';
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// { salt, hash, mustChange, fromEnv }. mustChange holds only for the default password.
let credential;
const sessions = new Map();
const failures = new Map();

function derive(password, salt = randomBytes(16)) {
  return { salt: salt.toString('base64'), hash: scryptSync(password, salt, 32).toString('base64') };
}

function matches(password, record) {
  if (typeof password !== 'string') return false;
  const expected = Buffer.from(record.hash, 'base64');
  const actual = scryptSync(password, Buffer.from(record.salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

/**
 * Pick the admin password: REVIEW_PASSWORD, then the saved hash, then the
 * default, which only allows changing the password until it is replaced.
 */
export function initAuth() {
  sessions.clear();
  failures.clear();
  const saved = readJson(AUTH_FILE);
  if (process.env.REVIEW_PASSWORD) {
    credential = { ...derive(process.env.REVIEW_PASSWORD), mustChange: false, fromEnv: true };
  } else if (saved) {
    credential = { salt: saved.salt, hash: saved.hash, mustChange: false, fromEnv: false };
  } else {
    credential = { ...derive(DEFAULT_PASSWORD), mustChange: true, fromEnv: false };
  }
  return authState();
}

export function authState() {
  return { mustChangePassword: credential.mustChange, passwordFromEnv: credential.fromEnv };
}

/** Milliseconds until `ip` may try again, or 0. */
export function lockedFor(ip) {
  const entry = failures.get(ip);
  return entry?.lockedUntil > Date.now() ? entry.lockedUntil - Date.now() : 0;
}

/** Check credentials and count failures per IP. Returns { ok, retryAfterMs }. */
export function attempt(ip, username, password) {
  const wait = lockedFor(ip);
  if (wait) return { ok: false, retryAfterMs: wait };
  if (username === USERNAME && matches(password, credential)) {
    failures.delete(ip);
    return { ok: true };
  }
  let entry = failures.get(ip);
  if (!entry || entry.lockedUntil) entry = { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_FAILURES) entry.lockedUntil = Date.now() + LOCKOUT_MS;
  failures.set(ip, entry);
  return { ok: false, retryAfterMs: entry.lockedUntil ? LOCKOUT_MS : 0 };
}

export function createSession() {
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, { lastSeen: Date.now() });
  return token;
}

/** True for a live session, which this call keeps alive. */
export function touchSession(token) {
  const session = token && sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.lastSeen > SESSION_IDLE_MS) {
    sessions.delete(token);
    return false;
  }
  session.lastSeen = Date.now();
  return true;
}

export function endSession(token) {
  sessions.delete(token);
}

/**
 * Replace the admin password and end every other session.
 * Returns an error message, or null on success.
 */
export function changePassword(currentPassword, newPassword, keepToken) {
  if (credential.fromEnv) return 'The password is set by REVIEW_PASSWORD. Change it there.';
  if (!matches(currentPassword, credential)) return 'The current password is wrong.';
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (newPassword === DEFAULT_PASSWORD || newPassword === currentPassword) {
    return 'Choose a password different from the current and default passwords.';
  }
  const record = derive(newPassword);
  writeJson(AUTH_FILE, { username: USERNAME, ...record, changedAt: new Date().toISOString() });
  credential = { ...record, mustChange: false, fromEnv: false };
  for (const token of sessions.keys()) {
    if (token !== keepToken) sessions.delete(token);
  }
  return null;
}
