import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';

export interface AuthRequest extends Request { user?: { id: string; email: string; role: Role } }
export function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) return res.status(500).json({ error: 'Server authentication configuration is invalid' });
    req.user = jwt.verify(header.slice(7), secret) as AuthRequest['user'];
    next();
  } catch { return res.status(401).json({ error: 'Invalid or expired session' }); }
}
export function allowRoles(...roles: Role[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}
