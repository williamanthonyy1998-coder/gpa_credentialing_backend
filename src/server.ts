import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
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
import organizationWorkspaceRoutes from './routes/organizationWorkspace';
import automationRoutes from './routes/automation';
import { authenticate, attachTenantContext, requireCsrfForCookieAuth } from './middleware/auth';
import { prisma } from './lib/prisma';
import {
  assertProductionSecurityIntegrations,
  assertSafeRuntimeConfig,
  isCorsOriginAllowed,
  isE2eLoginBypassAllowed,
  isProductionRuntime,
  resolveTrustProxySetting
} from './lib/runtimeSecurity';
import { startAutomationScheduler, stopAutomationScheduler } from './services/automationScheduler';

// C2 / C3 / H6 / CORS / storage / scanner: refuse unsafe production configuration before listening.
assertSafeRuntimeConfig();
assertProductionSecurityIntegrations();

const app = express();
app.disable('x-powered-by');
// Must run before express-rate-limit so X-Forwarded-For from Vercel is trusted safely (1 hop).
app.set('trust proxy', resolveTrustProxySetting());
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({
  origin(origin, callback) {
    // Non-browser clients (no Origin) are fine; browsers must match WEB_ORIGIN exactly.
    if (!origin) return callback(null, true);
    if (isCorsOriginAllowed(origin)) return callback(null, origin);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-CSRF-Token',
    'X-Tenant-Id',
    'X-Platform-Access'
  ]
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(morgan(isProductionRuntime() ? 'combined' : 'dev'));
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

// Public API root (does not weaken authenticated resource routes mounted later).
app.get('/api', (_req, res) => {
  res.json({ ok: true, service: 'credentialing-api' });
});

app.use('/api/auth', authRoutes);
app.use('/api/invitations', invitationsPublicRoutes);
app.use('/api/provider-invitations', providerInvitationsPublicRoutes);
// CSRF runs after authenticate so cookie-vs-bearer authority is known.
const withTenant = [authenticate, requireCsrfForCookieAuth, attachTenantContext] as const;
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
app.use('/api/organizations/:organizationId', ...withTenant, organizationWorkspaceRoutes);
app.use('/api/automation', ...withTenant, automationRoutes);
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
    error: isProductionRuntime() ? 'Internal server error' : (err?.message || 'Internal server error')
  });
});

// Vercel (and other serverless hosts) import this module and invoke `app` directly.
// Only bind a port when running as a long-lived Node process (local / traditional host).
export default app;

const isServerlessRuntime = Boolean(process.env.VERCEL) || process.env.SERVERLESS === '1';

if (!isServerlessRuntime) {
  const port = Number(process.env.PORT || 4000);
  const server = app.listen(port, () => {
    console.log(`Credentialing API listening on :${port}`);
    startAutomationScheduler();
  });
  const shutdown = async () => {
    await stopAutomationScheduler();
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
