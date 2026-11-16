import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middleware/auth';
import {
  getEffectivePreferences,
  upsertPreferences,
  NOTIFICATION_CATEGORIES
} from '../services/notificationPreferences';

const router = Router();

router.get('/preferences', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const items = await getEffectivePreferences(req.user!.id);
    res.json({ items, categories: NOTIFICATION_CATEGORIES });
  } catch (e) { next(e); }
});

router.put('/preferences', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      items: z.array(z.object({
        category: z.string(),
        channelInApp: z.boolean().optional(),
        channelEmail: z.boolean().optional()
      })).min(1)
    }).parse(req.body);
    const items = await upsertPreferences({
      userId: req.user!.id,
      actorId: req.user!.id,
      items: body.items
    });
    res.json({ items });
  } catch (e) { next(e); }
});

router.get('/deliveries', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const rows = await prisma.notificationDelivery.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(100, Number(req.query.limit) || 40)
    });
    res.json({ items: rows });
  } catch (e) { next(e); }
});

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    const where: any = { userId: req.user!.id };
    if (unreadOnly) where.readAt = null;
    const [total, unread, data] = await Promise.all([
      prisma.notification.count({ where: { userId: req.user!.id } }),
      prisma.notification.count({ where: { userId: req.user!.id, readAt: null } }),
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(100, Number(req.query.limit) || 30)
      })
    ]);
    res.json({ data, total, unread });
  } catch (e) { next(e); }
});

router.post('/:id/read', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const existing = await prisma.notification.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
    if (!existing) return res.status(404).json({ error: 'Notification not found' });
    const row = await prisma.notification.update({
      where: { id: existing.id },
      data: { readAt: existing.readAt || new Date() }
    });
    res.json(row);
  } catch (e) { next(e); }
});

router.post('/read-all', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await prisma.notification.updateMany({
      where: { userId: req.user!.id, readAt: null },
      data: { readAt: new Date() }
    });
    res.json({ updated: result.count });
  } catch (e) { next(e); }
});

export default router;
