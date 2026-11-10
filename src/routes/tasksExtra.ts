import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest } from '../middleware/auth';
import { notifyUser } from '../services/notifications';

const router = Router();

router.get('/:id/comments', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const task = await prisma.task.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const comments = await prisma.taskComment.findMany({
      where: { taskId: req.params.id },
      include: { author: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' }
    });
    res.json(comments);
  } catch (e) { next(e); }
});

router.post('/:id/comments', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot comment on tasks' });
    }
    const input = z.object({ body: z.string().min(1).max(4000) }).parse(req.body);
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { assignedTo: { select: { id: true } }, createdBy: { select: { id: true } } }
    });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const comment = await prisma.taskComment.create({
      data: { taskId: task.id, authorId: req.user!.id, body: input.body },
      include: { author: { select: { id: true, name: true, email: true } } }
    });
    const notifyIds = [task.assignedToId, task.createdById].filter((id): id is string => !!id && id !== req.user!.id);
    await Promise.all(notifyIds.map(userId => notifyUser({
      userId,
      title: 'New task comment',
      body: input.body.slice(0, 140),
      type: 'task',
      entityType: 'tasks',
      entityId: task.id,
      href: '/tasks'
    })));
    await audit(req, 'COMMENT', 'tasks', task.id, undefined, comment);
    res.status(201).json(comment);
  } catch (e) { next(e); }
});

export default router;
