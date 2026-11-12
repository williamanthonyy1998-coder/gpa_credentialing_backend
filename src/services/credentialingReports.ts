import { EnrollmentStatus, Role } from '@prisma/client';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { prisma } from '../lib/prisma';
import { getRevalidationDashboardCounts, ACTIVE_REVALIDATION, TERMINAL_REVALIDATION } from './enrollmentRevalidation';
import { getDeadlineDashboardExtras } from './credentialingDeadlines';
import { getEnrollmentDashboardCounts } from './enrollmentLifecycle';

function deny(message: string, status = 400, code?: string): never {
  const err: any = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

export function canViewReports(role: Role) {
  return role !== Role.EXTERNAL_PROVIDER;
}

export function canExportReports(role: Role) {
  return (
    role === Role.ADMIN
    || role === Role.CREDENTIALING_MANAGER
    || role === Role.ENROLLMENT_SPECIALIST
    || role === Role.CREDENTIALING_SPECIALIST
    || role === Role.APPROVER
    || role === Role.AUDITOR
  );
}

function parseRange(from?: string | null, to?: string | null) {
  const rangeFrom = from ? new Date(from) : null;
  const rangeTo = to ? new Date(to) : null;
  if (rangeFrom && Number.isNaN(rangeFrom.getTime())) deny('Invalid from date');
  if (rangeTo && Number.isNaN(rangeTo.getTime())) deny('Invalid to date');
  return { rangeFrom, rangeTo };
}

function avgCalendarDays(pairs: Array<{ start: Date; end: Date }>) {
  if (!pairs.length) return { averageDays: null as number | null, sampleSize: 0 };
  const total = pairs.reduce((sum, p) => sum + (p.end.getTime() - p.start.getTime()) / 86400000, 0);
  return { averageDays: Math.round((total / pairs.length) * 10) / 10, sampleSize: pairs.length };
}

export async function enrollmentStatusReport(tenantId: string, audience: 'gpa' | 'client') {
  const counts = await getEnrollmentDashboardCounts(tenantId);
  const byStatus = await prisma.enrollmentApplication.groupBy({
    by: ['status'],
    where: { tenantId },
    _count: { _all: true }
  });
  const map: Record<string, number> = {};
  for (const s of Object.values(EnrollmentStatus)) map[s] = 0;
  for (const row of byStatus) map[row.status] = row._count._all;
  return {
    report: 'enrollment_status',
    tenantScoped: true,
    generatedAt: new Date().toISOString(),
    totals: map,
    dashboard: audience === 'gpa' ? counts : {
      // sanitized subset for clients
      byStatus: map
    },
    definitions: {
      note: 'Counts are from persisted EnrollmentApplication rows. Attention flags are not statuses.'
    }
  };
}

export async function revalidationReport(tenantId: string) {
  const dash = await getRevalidationDashboardCounts(tenantId);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const nextNext = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));

  const [dueThisMonth, dueNextMonth, pendingPayer, assigned] = await Promise.all([
    prisma.enrollmentRevalidation.count({
      where: {
        tenantId,
        status: { in: ACTIVE_REVALIDATION },
        dueDate: { gte: monthStart, lt: nextMonthStart }
      }
    }),
    prisma.enrollmentRevalidation.count({
      where: {
        tenantId,
        status: { in: ACTIVE_REVALIDATION },
        dueDate: { gte: nextMonthStart, lt: nextNext }
      }
    }),
    prisma.enrollmentRevalidation.count({
      where: {
        tenantId,
        status: {
          in: ['SUBMITTED', 'ACKNOWLEDGED', 'APPROVED'] as any
        }
      }
    }),
    prisma.enrollmentRevalidation.groupBy({
      by: ['assignedToId'],
      where: { tenantId, status: { notIn: TERMINAL_REVALIDATION } },
      _count: { _all: true }
    })
  ]);

  return {
    report: 'revalidations',
    tenantScoped: true,
    generatedAt: new Date().toISOString(),
    dashboard: dash,
    dueThisMonth,
    dueNextMonth,
    pendingPayerResponse: pendingPayer,
    assignedWorkload: assigned.map((a) => ({
      assignedToId: a.assignedToId,
      count: a._count._all
    })),
    note: 'Payer revalidation is separate from credential/license expiration.'
  };
}

export async function credentialsReport(tenantId: string) {
  const extras = await getDeadlineDashboardExtras(tenantId);
  const [active, rejected] = await Promise.all([
    prisma.license.count({
      where: { tenantId, archived: false, verificationStatus: 'VERIFIED' as any }
    }),
    prisma.license.count({
      where: { tenantId, archived: false, verificationStatus: 'REJECTED' as any }
    })
  ]);
  const renewals = await prisma.license.count({
    where: { tenantId, renewedFromId: { not: null } }
  });
  return {
    report: 'credentials',
    tenantScoped: true,
    generatedAt: new Date().toISOString(),
    activeVerifiedLicenses: active,
    rejectedLicenses: rejected,
    renewalRecords: renewals,
    ...extras,
    note: 'Credential expiration ≠ payer revalidation ≠ enrollment effective status.'
  };
}

export async function payerPerformanceReport(tenantId: string, from?: string | null, to?: string | null) {
  const { rangeFrom, rangeTo } = parseRange(from, to);
  const where: any = { tenantId };
  if (rangeFrom || rangeTo) {
    where.createdAt = {};
    if (rangeFrom) where.createdAt.gte = rangeFrom;
    if (rangeTo) where.createdAt.lte = rangeTo;
  }

  const enrollments = await prisma.enrollmentApplication.findMany({
    where,
    select: {
      id: true,
      status: true,
      submittedAt: true,
      acknowledgedAt: true,
      decisionAt: true,
      effectiveAt: true,
      payerPlanId: true,
      payerPlan: { select: { id: true, name: true, payerId: true, payer: { select: { id: true, name: true } } } }
    },
    take: 5000
  });

  type Agg = {
    payerId: string;
    payerName: string;
    applications: number;
    submitted: number;
    approved: number;
    denied: number;
    aiCount: number;
    submitToAck: Array<{ start: Date; end: Date }>;
    submitToApprove: Array<{ start: Date; end: Date }>;
    submitToEffective: Array<{ start: Date; end: Date }>;
  };
  const byPayer = new Map<string, Agg>();

  for (const e of enrollments) {
    const payerId = e.payerPlan?.payerId || 'unknown';
    const payerName = e.payerPlan?.payer?.name || 'Unknown payer';
    if (!byPayer.has(payerId)) {
      byPayer.set(payerId, {
        payerId,
        payerName,
        applications: 0,
        submitted: 0,
        approved: 0,
        denied: 0,
        aiCount: 0,
        submitToAck: [],
        submitToApprove: [],
        submitToEffective: []
      });
    }
    const a = byPayer.get(payerId)!;
    a.applications += 1;
    if (e.submittedAt) a.submitted += 1;
    if (e.status === EnrollmentStatus.APPROVED || e.status === EnrollmentStatus.EFFECTIVE) a.approved += 1;
    if (e.status === EnrollmentStatus.DENIED) a.denied += 1;
    if (e.status === EnrollmentStatus.ADDITIONAL_INFORMATION_NEEDED) a.aiCount += 1;
    if (e.submittedAt && e.acknowledgedAt) a.submitToAck.push({ start: e.submittedAt, end: e.acknowledgedAt });
    if (e.submittedAt && e.decisionAt && (e.status === 'APPROVED' || e.status === 'EFFECTIVE' || e.status === 'DENIED')) {
      a.submitToApprove.push({ start: e.submittedAt, end: e.decisionAt });
    }
    if (e.submittedAt && e.effectiveAt) a.submitToEffective.push({ start: e.submittedAt, end: e.effectiveAt });
  }

  const overdueFollowUps = await prisma.task.count({
    where: {
      tenantId,
      source: 'ENROLLMENT_FOLLOWUP',
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      dueAt: { lt: new Date() }
    }
  });

  return {
    report: 'payer_performance',
    tenantScoped: true,
    generatedAt: new Date().toISOString(),
    dateRange: { from: rangeFrom?.toISOString() || null, to: rangeTo?.toISOString() || null },
    dayBasis: 'calendar_days',
    overdueFollowUps,
    payers: [...byPayer.values()].map((a) => ({
      payerId: a.payerId,
      payerName: a.payerName,
      applications: a.applications,
      submitted: a.submitted,
      approved: a.approved,
      denied: a.denied,
      additionalInformationCount: a.aiCount,
      avgSubmitToAcknowledgement: avgCalendarDays(a.submitToAck),
      avgSubmitToDecision: avgCalendarDays(a.submitToApprove),
      avgSubmitToEffective: avgCalendarDays(a.submitToEffective)
    })),
    note: 'Averages only use rows with both timestamps present. Sample size is reported. Incomplete timestamps are excluded — not estimated.'
  };
}

export async function buildExcelReportBuffer(input: {
  tenantId: string;
  tenantName?: string;
  audience: 'gpa' | 'client';
  from?: string | null;
  to?: string | null;
}) {
  const [enrollments, revals, credentials, payerPerf] = await Promise.all([
    enrollmentStatusReport(input.tenantId, input.audience),
    revalidationReport(input.tenantId),
    credentialsReport(input.tenantId),
    payerPerformanceReport(input.tenantId, input.from, input.to)
  ]);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'GPA Credentialing';
  wb.created = new Date();

  const summary = wb.addWorksheet('Summary');
  summary.columns = [
    { header: 'Metric', key: 'metric', width: 40 },
    { header: 'Value', key: 'value', width: 24 }
  ];
  summary.addRow({ metric: 'Tenant', value: input.tenantName || input.tenantId });
  summary.addRow({ metric: 'Generated at (UTC)', value: new Date().toISOString() });
  summary.addRow({ metric: 'Report range from', value: input.from || '—' });
  summary.addRow({ metric: 'Report range to', value: input.to || '—' });
  summary.addRow({ metric: 'Completed revalidations', value: revals.dashboard.completed });
  summary.addRow({ metric: 'Overdue revalidations', value: revals.dashboard.overdue });
  summary.addRow({ metric: 'Credentials expiring 30d', value: credentials.credentialsExpiringWithin30Days });
  summary.addRow({ metric: 'Expired credentials', value: credentials.expiredCredentials });

  const statusSheet = wb.addWorksheet('Enrollment statuses');
  statusSheet.columns = [
    { header: 'Status', key: 'status', width: 32 },
    { header: 'Count', key: 'count', width: 12 }
  ];
  for (const [status, count] of Object.entries(enrollments.totals)) {
    statusSheet.addRow({ status, count });
  }

  const payerSheet = wb.addWorksheet('Payer performance');
  payerSheet.columns = [
    { header: 'Payer', key: 'payer', width: 28 },
    { header: 'Applications', key: 'applications', width: 14 },
    { header: 'Submitted', key: 'submitted', width: 12 },
    { header: 'Approved', key: 'approved', width: 12 },
    { header: 'Denied', key: 'denied', width: 10 },
    { header: 'Avg submit→ack (days)', key: 'ack', width: 20 },
    { header: 'Ack sample', key: 'ackN', width: 12 },
    { header: 'Avg submit→effective (days)', key: 'eff', width: 24 },
    { header: 'Effective sample', key: 'effN', width: 14 }
  ];
  for (const p of payerPerf.payers) {
    payerSheet.addRow({
      payer: p.payerName,
      applications: p.applications,
      submitted: p.submitted,
      approved: p.approved,
      denied: p.denied,
      ack: p.avgSubmitToAcknowledgement.averageDays ?? '—',
      ackN: p.avgSubmitToAcknowledgement.sampleSize,
      eff: p.avgSubmitToEffective.averageDays ?? '—',
      effN: p.avgSubmitToEffective.sampleSize
    });
  }

  const meta = wb.addWorksheet('Metadata');
  meta.addRow(['Filters/date range applied as requested; tenant-scoped only.']);
  meta.addRow(['Credential expiration is separate from payer revalidation.']);
  meta.addRow(['Internal notes are not included in this export.']);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export async function buildPdfReportBuffer(input: {
  tenantId: string;
  tenantName?: string;
  audience: 'gpa' | 'client';
  from?: string | null;
  to?: string | null;
}) {
  const [enrollments, revals, credentials] = await Promise.all([
    enrollmentStatusReport(input.tenantId, input.audience),
    revalidationReport(input.tenantId),
    credentialsReport(input.tenantId)
  ]);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const generated = new Date().toISOString();
    doc.fontSize(16).text('GPA Credentialing — Operational Report', { align: 'left' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#333');
    doc.text(`Tenant: ${input.tenantName || input.tenantId}`);
    doc.text(`Generated: ${generated}`);
    doc.text(`Period: ${input.from || '—'} to ${input.to || '—'}`);
    doc.moveDown();
    doc.fontSize(12).fillColor('#000').text('Enrollment status counts');
    doc.fontSize(9);
    for (const [status, count] of Object.entries(enrollments.totals)) {
      doc.text(`${status}: ${count}`);
    }
    doc.moveDown();
    doc.fontSize(12).text('Revalidation summary');
    doc.fontSize(9);
    doc.text(`Upcoming (active): ${revals.dashboard.upcomingTotal}`);
    doc.text(`Due within 30 days: ${revals.dashboard.dueWithin30Days}`);
    doc.text(`Overdue: ${revals.dashboard.overdue}`);
    doc.text(`Completed: ${revals.dashboard.completed}`);
    doc.text(`Denied: ${revals.dashboard.denied}`);
    doc.moveDown();
    doc.fontSize(12).text('Credential summary');
    doc.fontSize(9);
    doc.text(`Expiring within 30 days: ${credentials.credentialsExpiringWithin30Days}`);
    doc.text(`Expired: ${credentials.expiredCredentials}`);
    doc.text(`Pending verification: ${credentials.credentialsPendingVerification}`);
    doc.moveDown();
    doc.fontSize(8).fillColor('#555').text(
      'Credential expiration ≠ payer revalidation ≠ enrollment approval/effective. ' +
        'Averages and KPIs use persisted timestamps only.'
    );

    // Page number
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).fillColor('#666').text(
        `Page ${i - range.start + 1} of ${range.count}`,
        50,
        doc.page.height - 40,
        { align: 'center', width: doc.page.width - 100 }
      );
    }

    doc.end();
  });
}
