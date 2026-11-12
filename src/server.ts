import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import { ZodError } from 'zod';
import authRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import resourcesRoutes from './routes/resources';
import filesRoutes from './routes/files';
import employeesRoutes from './routes/employees';
import directoryRoutes from './routes/directory';
import directoriesRoutes from './routes/directories';
import directoryQualityRoutes from './routes/directoryQuality';
import credentialsRoutes from './routes/credentials';
import enrollmentsRoutes from './routes/enrollments';
import enrollmentLifecycleRoutes from './routes/enrollmentLifecycle';
import enrollmentPacketRoutes from './routes/enrollmentPacket';
import enrollmentSubmissionRoutes from './routes/enrollmentSubmission';
import payerRequirementsRoutes from './routes/payerRequirements';
import intakeRoutes from './routes/intake';
import leaveRoutes from './routes/leave';
import attendanceRoutes from './routes/attendance';
import notificationsRoutes from './routes/notifications';
import searchRoutes from './routes/search';
import tasksExtraRoutes from './routes/tasksExtra';
import clientsRoutes from './routes/clients';
import portalRoutes from './routes/portal';
import invitationsPublicRoutes from './routes/invitationsPublic';
import providerInvitationsPublicRoutes from './routes/providerInvitationsPublic';
import providerPortalRoutes from './routes/providerPortal';
import professionalHistoryRoutes from './routes/professionalHistory';
import licensesLifecycleRoutes from './routes/licensesLifecycle';
import credentialingProfileRoutes from './routes/credentialingProfile';
import credentialingQaRoutes from './routes/credentialingQa';
import integrationsRoutes from './routes/integrations';
import providerIntegrationsRoutes from './routes/providerIntegrations';
import enrollmentIntegrationsRoutes from './routes/enrollmentIntegrations';
import {
  enrollmentRevalidationRoutes,
  revalidationRoutes
} from './routes/enrollmentRevalidation';
import credentialingOpsRoutes from './routes/credentialingOps';
import { authenticate, attachTenantContext } from './middleware/auth';
import { prisma } from './lib/prisma';
import { assertSafeRuntimeConfig, isE2eLoginBypassAllowed } from './lib/runtimeSecurity';

// C2 / C3: refuse unsafe production configuration before listening.
assertSafeRuntimeConfig();

const app = express();
app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({
  origin: (process.env.WEB_ORIGIN || 'http://localhost:5173,http://localhost:5174').split(',').map(x => x.trim()),
  credentials: false
}));
app.use(express.json({ limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 500, standardHeaders: true, legacyHeaders: false }));
// Dedicated login limiter. E2E may raise/skip limits only in non-production when
// E2E_SAFE_DATABASE=1 AND DATABASE_URL clearly targets an *_e2e / *_test database.
app.use(
  '/api/auth/login',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: isE2eLoginBypassAllowed() ? 10_000 : 30,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isE2eLoginBypassAllowed()
  })
);

app.get('/health', async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ status: 'ok', database: 'connected' }); }
  catch { res.status(503).json({ status: 'degraded', database: 'unavailable' }); }
});

app.use('/api/auth', authRoutes);
app.use('/api/invitations', invitationsPublicRoutes);
app.use('/api/provider-invitations', providerInvitationsPublicRoutes);
const withTenant = [authenticate, attachTenantContext] as const;
app.use('/api/provider-portal', ...withTenant, providerPortalRoutes);
app.use('/api/employees', ...withTenant, employeesRoutes);
app.use('/api/dashboard', ...withTenant, dashboardRoutes);
app.use('/api/documents', ...withTenant, filesRoutes);
app.use('/api/directory', ...withTenant, directoryRoutes);
app.use('/api/directories', ...withTenant, directoriesRoutes);
app.use('/api/directory-quality', ...withTenant, directoryQualityRoutes);
app.use('/api/credentials', ...withTenant, credentialsRoutes);
app.use('/api/payer-requirements', ...withTenant, payerRequirementsRoutes);
app.use('/api/enrollments/:id', ...withTenant, enrollmentPacketRoutes);
app.use('/api/enrollments/:id', ...withTenant, enrollmentSubmissionRoutes);
app.use('/api/enrollments/:id', ...withTenant, enrollmentIntegrationsRoutes);
app.use('/api/enrollments/:id', ...withTenant, enrollmentRevalidationRoutes);
app.use('/api/revalidations', ...withTenant, revalidationRoutes);
app.use('/api/credentialing', ...withTenant, credentialingOpsRoutes);
app.use('/api/integrations', ...withTenant, integrationsRoutes);
app.use('/api/providers/:providerId', ...withTenant, providerIntegrationsRoutes);
app.use('/api/enrollments', ...withTenant, enrollmentLifecycleRoutes);
  app.use('/api/enrollments', ...withTenant, enrollmentsRoutes);
app.use('/api/intake', ...withTenant, intakeRoutes);
app.use('/api/leave', ...withTenant, leaveRoutes);
app.use('/api/attendance', ...withTenant, attendanceRoutes);
app.use('/api/notifications', ...withTenant, notificationsRoutes);
app.use('/api/search', ...withTenant, searchRoutes);
app.use('/api/tasks', ...withTenant, tasksExtraRoutes);
app.use('/api/clients', ...withTenant, clientsRoutes);
app.use('/api/portal', ...withTenant, portalRoutes);
app.use('/api/providers/:providerId/professional-history', ...withTenant, professionalHistoryRoutes);
app.use('/api/provider-portal/providers/:providerId/professional-history', ...withTenant, professionalHistoryRoutes);
app.use('/api/provider-licenses', ...withTenant, licensesLifecycleRoutes);
  app.use('/api', ...withTenant, credentialingProfileRoutes);
  app.use('/api/credentialing-qa', ...withTenant, credentialingQaRoutes);
  app.use('/api', ...withTenant, resourcesRoutes);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
    });
  }
  if (err?.status && err?.message) return res.status(err.status).json({ error: err.message, missing: err.missing });
  if (err?.code === 'P2002') return res.status(409).json({ error: 'A record with this unique value already exists' });
  if (err?.code === 'P2003') return res.status(400).json({ error: 'Referenced record does not exist or is still in use' });
  console.error(err);
  return res.status(500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : (err?.message || 'Internal server error')
  });
});

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () => console.log(`Credentialing API listening on :${port}`));
const shutdown = async () => { server.close(); await prisma.$disconnect(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
