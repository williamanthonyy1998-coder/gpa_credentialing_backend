import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest, allowRoles } from '../middleware/auth';

const router = Router();

function startOfDay(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function parseHHMM(value: string | undefined | null, fallback: string) {
  const v = value || fallback;
  const [h, m] = v.split(':').map(Number);
  return { h: h || 0, m: m || 0 };
}

function expectedWindow(user: any, workDate: Date) {
  const schedule = user?.workSchedule || {};
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][workDate.getUTCDay()];
  const day = schedule[dayName] || { open: ![0, 6].includes(workDate.getUTCDay()), startTime: '09:00', endTime: '17:00' };
  if (!day.open) return null;
  const start = parseHHMM(day.startTime, '09:00');
  const end = parseHHMM(day.endTime, '17:00');
  const expectedStart = new Date(workDate);
  expectedStart.setUTCHours(start.h, start.m, 0, 0);
  const expectedEnd = new Date(workDate);
  expectedEnd.setUTCHours(end.h, end.m, 0, 0);
  return { expectedStart, expectedEnd, breakMinutes: Number(day.breakMinutes || 0) };
}

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const where: any = {};
    if (req.query.userId) where.userId = String(req.query.userId);
    if (req.query.mine === '1') where.userId = req.user!.id;
    if (req.query.from || req.query.to) {
      where.workDate = {};
      if (req.query.from) where.workDate.gte = new Date(String(req.query.from));
      if (req.query.to) where.workDate.lte = new Date(String(req.query.to));
    }
    if (!where.userId && !([Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[]).includes(req.user!.role)) {
      where.userId = req.user!.id;
    }
    const rows = await prisma.attendanceRecord.findMany({
      where,
      include: { user: { select: { id: true, name: true, email: true, department: true } } },
      orderBy: [{ workDate: 'desc' }, { checkInAt: 'desc' }],
      take: Math.min(200, Number(req.query.limit) || 50)
    });
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/check-in', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const workDate = startOfDay(new Date());
    const existing = await prisma.attendanceRecord.findUnique({
      where: { userId_workDate: { userId: req.user!.id, workDate } }
    });
    if (existing?.checkInAt) return res.status(409).json({ error: 'Already checked in today' });
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    const window = expectedWindow(user, workDate);
    const now = new Date();
    const lateMinutes = window && now > window.expectedStart
      ? Math.floor((now.getTime() - window.expectedStart.getTime()) / 60000)
      : 0;
    const row = existing
      ? await prisma.attendanceRecord.update({
        where: { id: existing.id },
        data: { checkInAt: now, lateMinutes }
      })
      : await prisma.attendanceRecord.create({
        data: {
          userId: req.user!.id,
          workDate,
          checkInAt: now,
          lateMinutes,
          breakMinutes: window?.breakMinutes || 0
        }
      });
    await audit(req, 'CHECK_IN', 'attendance', row.id, existing, row);
    res.status(201).json(row);
  } catch (e) { next(e); }
});

router.post('/check-out', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const workDate = startOfDay(new Date());
    const existing = await prisma.attendanceRecord.findUnique({
      where: { userId_workDate: { userId: req.user!.id, workDate } }
    });
    if (!existing?.checkInAt) return res.status(400).json({ error: 'Check in before checking out' });
    if (existing.checkOutAt) return res.status(409).json({ error: 'Already checked out today' });
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    const window = expectedWindow(user, workDate);
    const now = new Date();
    const earlyMinutes = window && now < window.expectedEnd
      ? Math.floor((window.expectedEnd.getTime() - now.getTime()) / 60000)
      : 0;
    const workedMinutes = Math.max(
      0,
      Math.floor((now.getTime() - existing.checkInAt.getTime()) / 60000) - (existing.breakMinutes || 0)
    );
    const row = await prisma.attendanceRecord.update({
      where: { id: existing.id },
      data: { checkOutAt: now, earlyMinutes, workedMinutes }
    });
    await audit(req, 'CHECK_OUT', 'attendance', row.id, existing, row);
    res.json(row);
  } catch (e) { next(e); }
});

router.patch('/:id', allowRoles(Role.ADMIN, Role.CREDENTIALING_MANAGER), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const input = z.object({
      checkInAt: z.coerce.date().optional().nullable(),
      checkOutAt: z.coerce.date().optional().nullable(),
      breakMinutes: z.coerce.number().int().nonnegative().optional(),
      notes: z.string().optional().nullable(),
      correctionNote: z.string().min(2)
    }).parse(req.body);
    const before = await prisma.attendanceRecord.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Attendance record not found' });
    const checkInAt = input.checkInAt ?? before.checkInAt;
    const checkOutAt = input.checkOutAt ?? before.checkOutAt;
    const breakMinutes = input.breakMinutes ?? before.breakMinutes;
    const workedMinutes = checkInAt && checkOutAt
      ? Math.max(0, Math.floor((checkOutAt.getTime() - checkInAt.getTime()) / 60000) - breakMinutes)
      : before.workedMinutes;
    const row = await prisma.attendanceRecord.update({
      where: { id: req.params.id },
      data: {
        checkInAt,
        checkOutAt,
        breakMinutes,
        workedMinutes,
        notes: input.notes ?? before.notes,
        corrected: true,
        correctionNote: input.correctionNote
      }
    });
    await audit(req, 'CORRECT', 'attendance', row.id, before, row);
    res.json(row);
  } catch (e) { next(e); }
});

export default router;
