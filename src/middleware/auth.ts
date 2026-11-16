import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import {
  PLATFORM_ACCESS_HEADER,
  TENANT_HEADER,
  TenantAuthContext,
  resolveTenantAuthContext
} from '../services/tenantAccess';
import { assertSessionActive } from '../services/authSession';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  timingSafeEqualString
} from '../lib/sessionCookies';

export interface AuthRequest extends Request {
  user?: { id: string; email: string; role: Role; jti?: string };
  tenantContext?: TenantAuthContext;
  /** True when the request authenticated via session cookie (CSRF required for mutations). */
  authViaCookie?: boolean;
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  return null;
}

function extractCookieToken(req: Request): string | null {
  const cookies = (req as any).cookies as Record<string, string> | undefined;
  const fromCookie = cookies?.[SESSION_COOKIE];
  if (fromCookie && String(fromCookie).trim()) return String(fromCookie).trim();
  return null;
}

export async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const bearer = extractBearer(req);
  const cookieToken = extractCookieToken(req);
  const token = bearer || cookieToken;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      return res.status(500).json({ error: 'Server authentication configuration is invalid' });
    }
    const payload = jwt.verify(token, secret) as AuthRequest['user'] & { jti?: string };
    await assertSessionActive(payload?.jti);
    req.user = { id: payload!.id, email: payload!.email, role: payload!.role, jti: payload?.jti };
    req.authViaCookie = Boolean(cookieToken) && !bearer;
    next();
  } catch (err: any) {
    if (err?.status === 401) return res.status(401).json({ error: err.message || 'Invalid or expired session' });
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

/**
 * CSRF guard for cookie-authenticated state-changing requests.
 * Bearer-token API clients are exempt (no ambient cookie authority).
 */
export function requireCsrfForCookieAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  if (!req.authViaCookie) return next();
  const headerToken = String(req.headers[CSRF_HEADER] || '').trim();
  const cookieToken = String((req as any).cookies?.[CSRF_COOKIE] || '').trim();
  if (!headerToken || !cookieToken || !timingSafeEqualString(headerToken, cookieToken)) {
    return res.status(403).json({ error: 'CSRF validation failed', code: 'CSRF_FAILED' });
  }
  next();
}

/**
 * Loads fresh membership from DB on every request.
 * JWT is never trusted for tenant authorization (revocation is immediate).
 */
export async function attachTenantContext(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const requestedTenantId = (req.headers[TENANT_HEADER] as string | undefined) || null;
    req.tenantContext = await resolveTenantAuthContext({
      userId: req.user.id,
      platformRole: req.user.role,
      requestedTenantId,
      platformAccessHeader: req.headers[PLATFORM_ACCESS_HEADER]
    });
    next();
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
}

export function allowRoles(...roles: Role[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}
