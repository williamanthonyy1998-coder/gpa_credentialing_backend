import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
const router = Router();
router.post('/login', async (req, res, next) => {
  try {
    const input = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user || !user.active || !(await bcrypt.compare(input.password, user.passwordHash))) return res.status(401).json({ error: 'Invalid email or password' });
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) return res.status(500).json({ error: 'JWT_SECRET must be at least 32 characters' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, secret, { expiresIn: (process.env.JWT_EXPIRES_IN || '8h') as any });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (e) { next(e); }
});
router.get('/me', authenticate, async (req: AuthRequest, res, next) => {
  try { const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { id: true, email: true, name: true, role: true, active: true } }); res.json(user); }
  catch (e) { next(e); }
});
export default router;
