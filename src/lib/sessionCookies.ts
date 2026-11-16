/**
 * HttpOnly session cookie + CSRF helpers (H7).
 * Browser auth uses cookies; JWT never stored in localStorage/sessionStorage.
 */
import crypto from 'node:crypto';
import { Response, CookieOptions } from 'express';

export const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'gpa_session';
export const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME || 'gpa_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function cookieSecure(): boolean {
  if (process.env.COOKIE_SECURE === '1') return true;
  if (process.env.COOKIE_SECURE === '0') return false;
  return process.env.NODE_ENV === 'production';
}

export function cookieSameSite(): 'lax' | 'strict' | 'none' {
  const raw = String(process.env.COOKIE_SAMESITE || 'lax').toLowerCase();
  if (raw === 'strict' || raw === 'none' || raw === 'lax') return raw;
  return 'lax';
}

function baseCookieOptions(maxAgeMs: number): CookieOptions {
  const secure = cookieSecure();
  const sameSite = cookieSameSite();
  // SameSite=None requires Secure.
  const effectiveSameSite = sameSite === 'none' && !secure ? 'lax' : sameSite;
  const opts: CookieOptions = {
    httpOnly: true,
    secure,
    sameSite: effectiveSameSite,
    path: '/',
    maxAge: maxAgeMs
  };
  if (process.env.COOKIE_DOMAIN) opts.domain = process.env.COOKIE_DOMAIN;
  return opts;
}

export function parseJwtExpiryMs(): number {
  const raw = String(process.env.JWT_EXPIRES_IN || '8h').trim();
  const m = raw.match(/^(\d+)([smhd])$/i);
  if (!m) return 8 * 60 * 60 * 1000;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 's') return n * 1000;
  if (unit === 'm') return n * 60 * 1000;
  if (unit === 'h') return n * 60 * 60 * 1000;
  if (unit === 'd') return n * 24 * 60 * 60 * 1000;
  return 8 * 60 * 60 * 1000;
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    ...baseCookieOptions(parseJwtExpiryMs()),
    httpOnly: true
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, {
    ...baseCookieOptions(0),
    httpOnly: true,
    maxAge: 0
  });
}

export function issueCsrfToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** CSRF cookie is readable by JS so the SPA can mirror it into X-CSRF-Token. */
export function setCsrfCookie(res: Response, token: string) {
  const opts = baseCookieOptions(parseJwtExpiryMs());
  res.cookie(CSRF_COOKIE, token, {
    ...opts,
    httpOnly: false
  });
}

export function clearCsrfCookie(res: Response) {
  const opts = baseCookieOptions(0);
  res.clearCookie(CSRF_COOKIE, { ...opts, httpOnly: false, maxAge: 0 });
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
