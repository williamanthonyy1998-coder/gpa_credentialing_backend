import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { LeaveStatus, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest, allowRoles } from '../middleware/auth';
import { notifyUser } from '../services/notifications';

const router = Router();

const include = {
  user: { select: { id: true, name: true, email: true, department: true } },
  leaveType: true,
  reviewedBy: { select: { id: true, name: true, email: true } }
};

function daysBetween(start: Date, end: Date) {
  const ms = end.getTime() - start.getTime();
  return Math.max(1, Math.floor(ms / (24 * 60 * 60 * 1000)) + 1);
}

router.get('/types', async (_req, res, next) => {
  try {
    const rows = await prisma.leaveType.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/types', allowRoles(Role.ADMIN, Role.CREDENTIALING_MANAGER), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const input = z.object({
      name: z.string().min(2),
      code: z.string().optional().nullable(),
      paid: z.boolean().optional(),
      annualDays: z.coerce.number().nonnegative().optional().nullable()
    }).parse(req.body);
    const row = await prisma.leaveType.create({ data: input as any });
    res.status(201).json(row);
  } catch (e) { next(e); }
});

router.get('/balances', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = String(req.query.userId || req.user!.id);
    const year = Number(req.query.year) || new Date().getFullYear();
    if (userId !== req.user!.id && !([Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[]).includes(req.user!.role)) {
      return res.status(403).json({ error: 'Cannot view another employee leave balance' });
    }
    const rows = await prisma.leaveBalance.findMany({
      where: { userId, year },
      include: { leaveType: true }
    });
    res.json(rows);
  } catch (e) { next(e); }
});

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const where: any = {};
    if (req.query.userId) where.userId = String(req.query.userId);
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.mine === '1') where.userId = req.user!.id;
    const rows = await prisma.leaveRequest.findMany({
      where,
      include,
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Number(req.query.limit) || 50)
    });
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const input = z.object({
      leaveTypeId: z.string().min(1),
      startDate: z.coerce.date(),
      endDate: z.coerce.date(),
      reason: z.string().optional().nullable(),
      userId: z.string().optional()
    }).parse(req.body);
    if (input.endDate < input.startDate) return res.status(400).json({ error: 'End date must be on or after start date' });
    const userId = input.userId && ([Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[]).includes(req.user!.role)
      ? input.userId
      : req.user!.id;

    const overlap = await prisma.leaveRequest.findFirst({
      where: {
        userId,
        status: { in: ['PENDING', 'APPROVED'] },
        startDate: { lte: input.endDate },
        endDate: { gte: input.startDate }
      }
    });
    if (overlap) return res.status(409).json({ error: 'Overlapping leave request already exists for these dates' });

    const row = await prisma.leaveRequest.create({
      data: {
        userId,
        leaveTypeId: input.leaveTypeId,
        startDate: input.startDate,
        endDate: input.endDate,
        reason: input.reason || null
      },
      include
    });

    const managers = await prisma.user.findMany({
      where: {
        OR: [
          { id: (await prisma.user.findUnique({ where: { id: userId }, select: { managerId: true } }))?.managerId || '__none__' },
          { role: { in: [Role.ADMIN, Role.CREDENTIALING_MANAGER] }, active: true }
        ]
      },
      select: { id: true },
      take: 10
    });
    await Promise.all(managers.map(m => notifyUser({
      userId: m.id,
      title: 'Leave request pending',
      body: `${row.user.name} requested leave ${row.startDate.toISOString().slice(0, 10)} → ${row.endDate.toISOString().slice(0, 10)}`,
      type: 'leave',
      entityType: 'leave',
      entityId: row.id,
      href: '/employees?tab=leave'
    })));

    await audit(req, 'CREATE', 'leave', row.id, undefined, row);
    res.status(201).json(row);
  } catch (e) { next(e); }
});

router.post('/:id/decide', allowRoles(Role.ADMIN, Role.CREDENTIALING_MANAGER), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const input = z.object({
      status: z.enum(['APPROVED', 'REJECTED']),
      reviewNote: z.string().optional().nullable()
    }).parse(req.body);
    const before = await prisma.leaveRequest.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Leave request not found' });
    if (before.status !== 'PENDING') return res.status(400).json({ error: 'Only pending leave can be decided' });

    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.leaveRequest.update({
        where: { id: req.params.id },
        data: {
          status: input.status as LeaveStatus,
          reviewedById: req.user!.id,
          reviewedAt: new Date(),
          reviewNote: input.reviewNote || null
        },
        include
      });
      if (input.status === 'APPROVED') {
        const year = before.startDate.getFullYear();
        const days = daysBetween(before.startDate, before.endDate);
        const balance = await tx.leaveBalance.findUnique({
          where: { userId_leaveTypeId_year: { userId: before.userId, leaveTypeId: before.leaveTypeId, year } }
        });
        if (balance) {
          await tx.leaveBalance.update({
            where: { id: balance.id },
            data: { used: Number(balance.used) + days }
          });
        } else {
          const type = await tx.leaveType.findUnique({ where: { id: before.leaveTypeId } });
          await tx.leaveBalance.create({
            data: {
              userId: before.userId,
              leaveTypeId: before.leaveTypeId,
              year,
              entitled: type?.annualDays ?? 0,
              used: days
            }
          });
        }
      }
      return updated;
    });

    await notifyUser({
      userId: row.userId,
      title: `Leave ${input.status.toLowerCase()}`,
      body: input.reviewNote || `Your leave request was ${input.status.toLowerCase()}`,
      type: 'leave',
      entityType: 'leave',
      entityId: row.id,
      href: '/employees?tab=leave'
    });
    await audit(req, 'UPDATE', 'leave', row.id, before, row);
    res.json(row);
  } catch (e) { next(e); }
});

export default router;
