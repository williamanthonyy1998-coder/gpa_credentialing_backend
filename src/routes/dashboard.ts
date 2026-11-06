import { Router } from 'express';
import { prisma } from '../lib/prisma';
const router = Router();
router.get('/', async (_req, res, next) => {
  try {
    const now = new Date(); const soon = new Date(); soon.setDate(soon.getDate() + 30);
    const [providers, organizations, practices, facilities, payers, employees, activeCases, pendingEnrollments, overdueTasks, expiringDocuments, cases, enrollments, tasks] = await Promise.all([
      prisma.provider.count(), prisma.organization.count(), prisma.practice.count(), prisma.facility.count(), prisma.payer.count(),
      prisma.user.count({ where: { active: true } }),
      prisma.credentialingCase.count({ where: { status: { notIn: ['APPROVED', 'REJECTED'] } } }),
      prisma.enrollmentApplication.count({ where: { status: { notIn: ['APPROVED', 'DENIED', 'WITHDRAWN'] } } }),
      prisma.task.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] }, dueAt: { lt: now } } }),
      prisma.document.count({ where: { expiresAt: { gte: now, lte: soon } } }),
      prisma.credentialingCase.findMany({ where: { status: { notIn: ['APPROVED', 'REJECTED'] } }, include: { provider: { select: { id: true, firstName: true, lastName: true, npi: true, primarySpecialty: true, status: true } }, practice: { select: { id: true, name: true } } }, orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }], take: 8 }),
      prisma.enrollmentApplication.findMany({ where: { status: { notIn: ['APPROVED', 'DENIED', 'WITHDRAWN'] } }, include: { provider: { select: { id: true, firstName: true, lastName: true, npi: true, primarySpecialty: true, status: true } }, organization: { select: { id: true, legalName: true } }, facility: { select: { id: true, name: true } }, payerPlan: { include: { payer: true } } }, orderBy: [{ nextFollowUpAt: 'asc' }, { updatedAt: 'desc' }], take: 8 }),
      prisma.task.findMany({ where: { status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] } }, orderBy: [{ dueAt: 'asc' }, { priority: 'desc' }], take: 8 })
    ]);
    res.json({ metrics: { providers, organizations, practices, facilities, payers, employees, activeCases, pendingEnrollments, overdueTasks, expiringDocuments }, cases, enrollments, tasks });
  } catch (e) { next(e); }
});
export default router;
