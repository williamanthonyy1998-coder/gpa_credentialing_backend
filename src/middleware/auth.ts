import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import {
  PLATFORM_ACCESS_HEADER,
  TENANT_HEADER,
  TenantAuthContext,
  resolveTenantAuthContext
} from '../services/tenantAccess';

export interface AuthRequest extends Request {
  user?: { id: string; email: string; role: Role };
  tenantContext?: TenantAuthContext;
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) return res.status(500).json({ error: 'Server authentication configuration is invalid' });
    req.user = jwt.verify(header.slice(7), secret) as AuthRequest['user'];
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

/**
 * Loads fresh membership from DB on every request.
 * JWT is never trusted for tenant authorization (revocation is immediate).
 */
export async function attachTenantContext(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    // Only the dedicated header may select tenant context. Query/body tenantId
    // values are ignored for authorization so clients cannot switch tenants by
    // mutating URL params or payloads. Membership is always revalidated in DB.
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
