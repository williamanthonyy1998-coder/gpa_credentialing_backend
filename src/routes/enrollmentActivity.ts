import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest } from '../middleware/auth';
import { GENERAL_ALLOWED_MIME, validateUploadedFile } from '../services/fileMagic';
import {
  ENROLLMENT_ACTIVITY_TYPES,
  activityInclude,
  canDeleteEnrollmentActivity,
  canEditEnrollmentActivity,
  canWriteEnrollmentActivity,
  loadEnrollmentForAccess,
  markEnrollmentActivitiesRead,
  notifyEnrollmentStakeholders,
  unreadActivityCountForUser
} from '../services/enrollmentActivity';

const router = Router({ mergeParams: true });

const uploadDir = path.resolve(process.cwd(), 'private-uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 12)}`)
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(null, GENERAL_ALLOWED_MIME.has(file.mimetype));
  }
});

function safeUnlink(p?: string | null) {
  if (!p) return;
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}

function enrollmentIdFrom(req: AuthRequest) {
  return String(req.params.id || '');
}

router.get('/:id/activities', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const enrollment = await loadEnrollmentForAccess(enrollmentIdFrom(req), req.user!.id, req.user!.role);
    const includeDeleted = String(req.query.includeDeleted || '') === '1'
      && (req.user!.role === Role.ADMIN || req.user!.role === Role.AUDITOR);
    const activities = await prisma.enrollmentActivity.findMany({
      where: {
        enrollmentId: enrollment.id,
        ...(includeDeleted ? {} : { deletedAt: null })
      },
      include: activityInclude,
      orderBy: { createdAt: 'asc' }
    });
    const unreadCount = await unreadActivityCountForUser(enrollment.id, req.user!.id);
    res.json({
      enrollmentId: enrollment.id,
      applicationNo: enrollment.applicationNo,
      unreadCount,
      data: activities.map(a => ({
        ...a,
        documentPreview: undefined,
        canEdit: canEditEnrollmentActivity(req.user!.role, a.authorId, req.user!.id),
        canDelete: canDeleteEnrollmentActivity(req.user!.role, a.authorId, req.user!.id)
      }))
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.post('/:id/activities', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canWriteEnrollmentActivity(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot post enrollment activity' });
    }
    const input = z.object({
      body: z.string().min(1).max(8000),
      activityType: z.enum(ENROLLMENT_ACTIVITY_TYPES).optional().default('MESSAGE'),
      completedAt: z.coerce.date().optional().nullable(),
      nextFollowUpAt: z.coerce.date().optional().nullable(),
      metadata: z.record(z.any()).optional().nullable(),
      documentIds: z.array(z.string().min(1)).max(10).optional()
    }).parse(req.body);

    const enrollment = await loadEnrollmentForAccess(enrollmentIdFrom(req), req.user!.id, req.user!.role);

    if (input.activityType === 'FOLLOW_UP_COMPLETED' && !input.completedAt && !input.metadata?.completedAt) {
      input.completedAt = new Date();
    }
    if (input.activityType === 'FOLLOW_UP_SCHEDULED' && !input.nextFollowUpAt) {
      return res.status(400).json({ error: 'nextFollowUpAt is required when scheduling a follow-up' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const enrollmentPatch: any = {};
      const meta: any = { ...(input.metadata || {}) };

      if (input.activityType === 'FOLLOW_UP_COMPLETED') {
        const completedAt = input.completedAt || new Date();
        enrollmentPatch.lastFollowUpAt = completedAt;
        meta.completedAt = completedAt;
        meta.previousLastFollowUpAt = enrollment.lastFollowUpAt;
      }
      if (input.activityType === 'FOLLOW_UP_SCHEDULED' && input.nextFollowUpAt) {
        enrollmentPatch.nextFollowUpAt = input.nextFollowUpAt;
        meta.nextFollowUpAt = input.nextFollowUpAt;
        meta.previousNextFollowUpAt = enrollment.nextFollowUpAt;
      }

      if (Object.keys(enrollmentPatch).length) {
        await tx.enrollmentApplication.update({
          where: { id: enrollment.id },
          data: enrollmentPatch
        });
      }

      const activity = await tx.enrollmentActivity.create({
        data: {
          enrollmentId: enrollment.id,
          authorId: req.user!.id,
          body: input.body.trim(),
          activityType: input.activityType,
          metadata: Object.keys(meta).length ? meta : undefined
        }
      });

      if (input.documentIds?.length) {
        const docs = await tx.document.findMany({
          where: {
            id: { in: input.documentIds },
            OR: [
              { enrollmentId: enrollment.id },
              { enrollmentId: null, organizationId: enrollment.organizationId || undefined }
            ]
          },
          select: { id: true }
        });
        if (docs.length) {
          await tx.enrollmentActivityAttachment.createMany({
            data: docs.map(d => ({ activityId: activity.id, documentId: d.id })),
            skipDuplicates: true
          });
          await tx.document.updateMany({
            where: { id: { in: docs.map(d => d.id) } },
            data: { enrollmentId: enrollment.id }
          });
        }
      }

      return tx.enrollmentActivity.findUniqueOrThrow({
        where: { id: activity.id },
        include: activityInclude
      });
    });

    await notifyEnrollmentStakeholders(
      enrollment,
      req.user!.id,
      {
        title: 'New enrollment activity',
        body: `${enrollment.applicationNo}: ${input.body.slice(0, 140)}`,
        type: 'enrollment_activity'
      }
    );
    await audit(req, 'ACTIVITY_CREATE', 'enrollments', enrollment.id, undefined, result);
    res.status(201).json({
      ...result,
      canEdit: true,
      canDelete: true
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.patch('/:id/activities/:activityId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const enrollment = await loadEnrollmentForAccess(enrollmentIdFrom(req), req.user!.id, req.user!.role);
    const activity = await prisma.enrollmentActivity.findFirst({
      where: { id: req.params.activityId, enrollmentId: enrollment.id, deletedAt: null }
    });
    if (!activity) return res.status(404).json({ error: 'Activity not found' });
    if (!canEditEnrollmentActivity(req.user!.role, activity.authorId, req.user!.id)) {
      return res.status(403).json({ error: 'You cannot edit this activity' });
    }
    const input = z.object({
      body: z.string().min(1).max(8000)
    }).parse(req.body);

    const before = { ...activity };
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.enrollmentActivity.update({
        where: { id: activity.id },
        data: { body: input.body.trim() },
        include: activityInclude
      });
      await tx.enrollmentActivity.create({
        data: {
          enrollmentId: enrollment.id,
          authorId: req.user!.id,
          body: 'Activity message edited',
          activityType: 'SYSTEM',
          metadata: {
            editedActivityId: activity.id,
            beforeBody: before.body,
            afterBody: input.body.trim()
          }
        }
      });
      return row;
    });

    await audit(req, 'ACTIVITY_UPDATE', 'enrollments', enrollment.id, before, updated);
    res.json({
      ...updated,
      canEdit: canEditEnrollmentActivity(req.user!.role, updated.authorId, req.user!.id),
      canDelete: canDeleteEnrollmentActivity(req.user!.role, updated.authorId, req.user!.id)
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.delete('/:id/activities/:activityId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const enrollment = await loadEnrollmentForAccess(enrollmentIdFrom(req), req.user!.id, req.user!.role);
    const activity = await prisma.enrollmentActivity.findFirst({
      where: { id: req.params.activityId, enrollmentId: enrollment.id, deletedAt: null }
    });
    if (!activity) return res.status(404).json({ error: 'Activity not found' });
    if (!canDeleteEnrollmentActivity(req.user!.role, activity.authorId, req.user!.id)) {
      return res.status(403).json({ error: 'You cannot delete this activity' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.enrollmentActivity.update({
        where: { id: activity.id },
        data: { deletedAt: new Date() },
        include: activityInclude
      });
      await tx.enrollmentActivity.create({
        data: {
          enrollmentId: enrollment.id,
          authorId: req.user!.id,
          body: 'Activity message deleted',
          activityType: 'SYSTEM',
          metadata: {
            deletedActivityId: activity.id,
            deletedBody: activity.body,
            deletedActivityType: activity.activityType
          }
        }
      });
      return row;
    });

    await audit(req, 'ACTIVITY_DELETE', 'enrollments', enrollment.id, activity, updated);
    res.json({ ok: true, id: updated.id, deletedAt: updated.deletedAt });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.post('/:id/activities/read', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const enrollment = await loadEnrollmentForAccess(enrollmentIdFrom(req), req.user!.id, req.user!.role);
    const result = await markEnrollmentActivitiesRead(enrollment.id, req.user!.id);
    res.json(result);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.get('/:id/approval', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const enrollment = await loadEnrollmentForAccess(enrollmentIdFrom(req), req.user!.id, req.user!.role);
    const documents = await prisma.document.findMany({
      where: {
        enrollmentId: enrollment.id,
        OR: [{ category: 'enrollment_approval' }, { type: 'APPROVAL_LETTER' }, { type: 'ENROLLMENT_SUPPORTING' }]
      },
      select: {
        id: true,
        title: true,
        type: true,
        category: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        storageKey: true,
        createdAt: true
      },
      orderBy: { createdAt: 'desc' }
    });

    const details = enrollment.approvalDetails || {
      enrollmentId: enrollment.id,
      payerEnrollmentId: enrollment.referenceNo,
      effectiveAt: enrollment.effectiveAt,
      revalidationAt: enrollment.revalidationAt,
      notes: enrollment.decisionReason || enrollment.notes,
      createdBy: null,
      updatedBy: null,
      createdAt: null,
      updatedAt: null
    };

    res.json({
      enrollmentId: enrollment.id,
      applicationNo: enrollment.applicationNo,
      status: enrollment.status,
      // Explicit: loading/saving this form does not change status.
      statusUnchangedByApprovalForm: true,
      details,
      documents: documents.map(d => ({
        ...d,
        hasFile: Boolean(d.storageKey),
        storageKey: undefined
      }))
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.put('/:id/approval', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canWriteEnrollmentActivity(req.user!.role)) {
      return res.status(403).json({ error: 'Your role cannot update approval details' });
    }
    const input = z.object({
      payerEnrollmentId: z.string().min(1, 'Payer Enrollment ID is required').max(200),
      effectiveAt: z.coerce.date({ required_error: 'Effective Date is required' }),
      revalidationAt: z.coerce.date().optional().nullable(),
      notes: z.string().max(8000).optional().nullable()
    }).parse(req.body);

    const enrollment = await loadEnrollmentForAccess(enrollmentIdFrom(req), req.user!.id, req.user!.role);
    const before = enrollment.approvalDetails;

    const result = await prisma.$transaction(async (tx) => {
      const details = await tx.enrollmentApprovalDetails.upsert({
        where: { enrollmentId: enrollment.id },
        create: {
          enrollmentId: enrollment.id,
          payerEnrollmentId: input.payerEnrollmentId.trim(),
          effectiveAt: input.effectiveAt,
          revalidationAt: input.revalidationAt || null,
          notes: input.notes || null,
          createdById: req.user!.id,
          updatedById: req.user!.id
        },
        update: {
          payerEnrollmentId: input.payerEnrollmentId.trim(),
          effectiveAt: input.effectiveAt,
          revalidationAt: input.revalidationAt || null,
          notes: input.notes || null,
          updatedById: req.user!.id
        },
        include: {
          createdBy: { select: { id: true, name: true, email: true } },
          updatedBy: { select: { id: true, name: true, email: true } }
        }
      });

      // Sync denormalized fields used by list/search — never mutates status here.
      await tx.enrollmentApplication.update({
        where: { id: enrollment.id },
        data: {
          referenceNo: details.payerEnrollmentId,
          effectiveAt: details.effectiveAt,
          revalidationAt: details.revalidationAt,
          decisionReason: details.notes
        }
      });

      await tx.enrollmentActivity.create({
        data: {
          enrollmentId: enrollment.id,
          authorId: req.user!.id,
          body: before
            ? 'Approval details updated'
            : 'Approval details recorded',
          activityType: 'APPROVAL_UPDATE',
          metadata: {
            payerEnrollmentId: details.payerEnrollmentId,
            effectiveAt: details.effectiveAt,
            revalidationAt: details.revalidationAt
          }
        }
      });

      return details;
    });

    await notifyEnrollmentStakeholders(
      enrollment,
      req.user!.id,
      {
        title: 'Enrollment approval details saved',
        body: `${enrollment.applicationNo}: payer ref ${input.payerEnrollmentId}`,
        type: 'enrollment_approval'
      }
    );
    await audit(req, before ? 'APPROVAL_UPDATE' : 'APPROVAL_CREATE', 'enrollments', enrollment.id, before, result);
    res.json({
      enrollmentId: enrollment.id,
      applicationNo: enrollment.applicationNo,
      status: enrollment.status,
      statusUnchangedByApprovalForm: true,
      details: result
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.post('/:id/approval/documents', upload.single('file'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!canWriteEnrollmentActivity(req.user!.role)) {
      if (req.file) safeUnlink(req.file.path);
      return res.status(403).json({ error: 'Your role cannot upload approval documents' });
    }
    if (!req.file) return res.status(400).json({ error: 'Choose a supported file (PDF, JPG, PNG) under 20 MB.' });

    const enrollment = await loadEnrollmentForAccess(enrollmentIdFrom(req), req.user!.id, req.user!.role);
    const title = String(req.body?.title || req.file.originalname || 'Approval document').slice(0, 200);
    const docType = String(req.body?.type || 'APPROVAL_LETTER').slice(0, 80);

    const validation = validateUploadedFile({
      filePath: req.file.path,
      originalName: req.file.originalname,
      declaredMime: req.file.mimetype,
      allowedMimes: GENERAL_ALLOWED_MIME
    });
    if (!validation.ok) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: validation.error });
    }

    const result = await prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          title,
          type: docType,
          category: 'enrollment_approval',
          organizationId: enrollment.organizationId,
          facilityId: enrollment.facilityId,
          practiceId: enrollment.practiceId,
          providerId: enrollment.providerId,
          enrollmentId: enrollment.id,
          createdById: req.user!.id,
          storageKey: req.file!.filename,
          originalName: req.file!.originalname,
          mimeType: req.file!.mimetype,
          sizeBytes: req.file!.size,
          uploadedAt: new Date()
        }
      });
      await tx.enrollmentActivity.create({
        data: {
          enrollmentId: enrollment.id,
          authorId: req.user!.id,
          body: `Supporting document uploaded: ${title}`,
          activityType: 'APPROVAL_UPDATE',
          metadata: { documentId: document.id, title },
          attachments: {
            create: { documentId: document.id }
          }
        }
      });
      return document;
    });

    await audit(req, 'APPROVAL_DOCUMENT_UPLOAD', 'enrollments', enrollment.id, undefined, {
      documentId: result.id,
      title: result.title
    });
    res.status(201).json({
      id: result.id,
      title: result.title,
      type: result.type,
      category: result.category,
      originalName: result.originalName,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      hasFile: true,
      createdAt: result.createdAt
    });
  } catch (e: any) {
    if (req.file) safeUnlink(req.file.path);
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

export default router;
