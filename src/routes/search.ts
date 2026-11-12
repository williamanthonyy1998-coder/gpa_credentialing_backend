import { Router, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middleware/auth';
import { getAuthorizedOrganizationIds } from '../services/orgAccess';
import {
  andWhere,
  listWhereForResource,
  providerInTenantWhere,
  requireTenantContext
} from '../services/tenantAccess';
import { isPlatformAdmin } from '../services/tenants';

const router = Router();

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const tenantId = req.tenantContext!.tenantId;
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ q, results: [] });
    const take = Math.min(10, Math.max(1, Number(req.query.limit) || 5));
    const orgIds = await getAuthorizedOrganizationIds(req.user!.id, req.user!.role, req.tenantContext);
    const orgInTenant = orgIds.length ? { id: { in: orgIds } } : { tenantId };
    const practiceScope = andWhere(listWhereForResource('practices', tenantId)!, orgIds.length ? { organizationId: { in: orgIds } } : {});
    const facilityScope = andWhere(listWhereForResource('facilities', tenantId)!, orgIds.length ? {
      OR: [
        { organizationId: { in: orgIds } },
        { practice: { is: { organizationId: { in: orgIds } } } }
      ]
    } : {});
    const enrollmentScope = andWhere(listWhereForResource('enrollments', tenantId)!, orgIds.length ? {
      OR: [
        { organizationId: { in: orgIds } },
        { practice: { is: { organizationId: { in: orgIds } } } }
      ]
    } : {});
    const caseScope = listWhereForResource('cases', tenantId)!;
    const taskScope = andWhere(listWhereForResource('tasks', tenantId)!, orgIds.length ? { organizationId: { in: orgIds } } : {});
    const providerScope = providerInTenantWhere(tenantId);

    const includeEmployees = isPlatformAdmin(req.user!.role) && req.tenantContext!.platformAccess;

    const [organizations, practices, facilities, providers, payers, enrollments, cases, employees, tasks] = await Promise.all([
      prisma.organization.findMany({
        where: {
          AND: [
            orgInTenant,
            { OR: [{ legalName: { contains: q, mode: 'insensitive' } }, { dba: { contains: q, mode: 'insensitive' } }] }
          ]
        },
        select: { id: true, legalName: true, status: true },
        take
      }),
      prisma.practice.findMany({
        where: {
          AND: [
            practiceScope,
            { OR: [{ name: { contains: q, mode: 'insensitive' } }, { npi: { contains: q } }] }
          ]
        },
        select: { id: true, name: true, npi: true, organizationId: true },
        take
      }),
      prisma.facility.findMany({
        where: {
          AND: [
            facilityScope,
            { OR: [{ name: { contains: q, mode: 'insensitive' } }, { npi: { contains: q } }] }
          ]
        },
        select: { id: true, name: true, npi: true },
        take
      }),
      prisma.provider.findMany({
        where: {
          AND: [
            providerScope,
            {
              OR: [
                { firstName: { contains: q, mode: 'insensitive' } },
                { lastName: { contains: q, mode: 'insensitive' } },
                { npi: { contains: q } }
              ]
            }
          ]
        },
        select: { id: true, firstName: true, lastName: true, npi: true, status: true },
        take
      }),
      prisma.payer.findMany({
        where: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { payerCode: { contains: q, mode: 'insensitive' } }] },
        select: { id: true, name: true, payerCode: true },
        take
      }),
      prisma.enrollmentApplication.findMany({
        where: {
          AND: [
            enrollmentScope,
            { OR: [{ applicationNo: { contains: q, mode: 'insensitive' } }, { referenceNo: { contains: q, mode: 'insensitive' } }] }
          ]
        },
        select: { id: true, applicationNo: true, status: true },
        take
      }),
      prisma.credentialingCase.findMany({
        where: {
          AND: [
            caseScope,
            { caseNumber: { contains: q, mode: 'insensitive' } }
          ]
        },
        select: { id: true, caseNumber: true, status: true },
        take
      }),
      includeEmployees
        ? prisma.user.findMany({
          where: {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
              { employeeCode: { contains: q, mode: 'insensitive' } }
            ]
          },
          select: { id: true, name: true, email: true, role: true },
          take
        })
        : Promise.resolve([]),
      prisma.task.findMany({
        where: {
          AND: [
            taskScope,
            { title: { contains: q, mode: 'insensitive' } }
          ]
        },
        select: { id: true, title: true, status: true },
        take
      })
    ]);

    const results = [
      ...organizations.map(r => ({ type: 'organization', id: r.id, label: r.legalName, meta: r.status, href: `/organizations/${r.id}/overview` })),
      ...practices.map(r => ({ type: 'practice', id: r.id, label: r.name, meta: r.npi, href: `/practices/${r.id}/profile` })),
      ...facilities.map(r => ({ type: 'facility', id: r.id, label: r.name, meta: r.npi, href: `/facilities/${r.id}/profile` })),
      ...providers.map(r => ({ type: 'provider', id: r.id, label: `${r.firstName} ${r.lastName}`, meta: r.npi, href: `/providers?edit=${r.id}` })),
      ...payers.map(r => ({ type: 'payer', id: r.id, label: r.name, meta: r.payerCode, href: '/payers' })),
      ...enrollments.map(r => ({ type: 'enrollment', id: r.id, label: r.applicationNo, meta: r.status, href: `/enrollments?edit=${r.id}` })),
      ...cases.map(r => ({ type: 'case', id: r.id, label: r.caseNumber, meta: r.status, href: '/cases' })),
      ...employees.map(r => ({ type: 'employee', id: r.id, label: r.name, meta: r.email, href: '/employees' })),
      ...tasks.map(r => ({ type: 'task', id: r.id, label: r.title, meta: r.status, href: '/tasks' }))
    ];

    res.json({ q, results });
  } catch (e) { next(e); }
});

export default router;
