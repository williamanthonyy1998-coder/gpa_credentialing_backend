import {
  ExternalConnectionMode,
  ExternalIntegrationStatus,
  ExternalIntegrationType,
  ExternalOperationStatus,
  ProviderIntegrationAuthStatus,
  Role
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  awsSecretsManagerConfigured,
  buildEnvSecretRef,
  configureTenantMemSecret,
  publicSecretStatus,
  redactSecretsFromText
} from '../lib/secretStore';
import { assertProviderInTenant } from './tenantAccess';
import { assertTrustedEvidence } from './enrollmentLifecycle';
import { createCommunication } from './enrollmentSubmission';
import { adapterForType, CapabilityMap } from './integrationAdapters';

function deny(message: string, status = 400, code?: string): never {
  const err: any = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

export function canConfigureIntegrations(role: Role) {
  return role === Role.ADMIN || role === Role.CREDENTIALING_MANAGER;
}

export function canManageProviderAuthorization(role: Role) {
  return (
    role === Role.ADMIN
    || role === Role.CREDENTIALING_MANAGER
    || role === Role.CREDENTIALING_SPECIALIST
    || role === Role.ENROLLMENT_SPECIALIST
  );
}

export function canViewIntegrations(role: Role) {
  return role !== Role.EXTERNAL_PROVIDER;
}

export function canTestConnection(role: Role) {
  return canConfigureIntegrations(role);
}

function sanitizeIntegration(row: any, audience: 'gpa' | 'client' | 'provider') {
  if (!row) return row;
  const secret = publicSecretStatus(row.credentialSecretRef);
  const out: any = {
    id: row.id,
    tenantId: row.tenantId,
    integrationType: row.integrationType,
    displayName: row.displayName,
    systemName: row.systemName,
    status: row.status,
    connectionMode: row.connectionMode,
    capabilities: row.capabilities,
    feasibilityNotes: audience === 'gpa' ? row.feasibilityNotes : null,
    officialSourceUrl: row.officialSourceUrl,
    lastVerifiedAt: row.lastVerifiedAt,
    lastTestedAt: row.lastTestedAt,
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt,
    lastErrorAt: audience === 'gpa' ? row.lastErrorAt : null,
    lastErrorCode: audience === 'gpa' ? row.lastErrorCode : null,
    lastErrorSummary: audience === 'gpa' ? row.lastErrorSummary : null,
    credentialConfigured: secret.configured,
    credentialBackend: audience === 'gpa' ? secret.backend : null,
    awsSecretsManagerConfigured: audience === 'gpa' ? awsSecretsManagerConfigured() : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
  // Never expose credentialSecretRef or secret values
  return out;
}

const PLATFORM_CATALOG: Array<{
  integrationType: ExternalIntegrationType;
  displayName: string;
  systemName: string;
  status: ExternalIntegrationStatus;
  connectionMode: ExternalConnectionMode;
  officialSourceUrl: string;
  feasibilityNotes: string;
}> = [
  {
    integrationType: ExternalIntegrationType.CAQH,
    displayName: 'CAQH Provider Data / ProView',
    systemName: 'CAQH',
    status: ExternalIntegrationStatus.PENDING_APPROVAL,
    connectionMode: ExternalConnectionMode.OFFICIAL_API,
    officialSourceUrl:
      'https://www.caqh.org/hubfs/43908627/drupal/solutions/proview/proview-directassure-roster-statuscheck-api-specifications.pdf',
    feasibilityNotes:
      'Official PO Roster/Status/Credentialing APIs exist for Participating Organizations after CAQH approval. This deployment has not completed authorized live API access. Manual portal fallback available.'
  },
  {
    integrationType: ExternalIntegrationType.PECOS,
    displayName: 'CMS PECOS',
    systemName: 'PECOS',
    status: ExternalIntegrationStatus.MANUAL_ONLY,
    connectionMode: ExternalConnectionMode.MANUAL_PORTAL,
    officialSourceUrl: 'https://pecos.cms.hhs.gov/',
    feasibilityNotes:
      'No verified public machine-to-machine PECOS enrollment API for this organization. CMS PPEF public files are read-only extracts, not submit APIs. Manual PECOS portal workflow required.'
  },
  {
    integrationType: ExternalIntegrationType.AVAILITY,
    displayName: 'Availity',
    systemName: 'Availity',
    status: ExternalIntegrationStatus.PENDING_APPROVAL,
    connectionMode: ExternalConnectionMode.OFFICIAL_API,
    officialSourceUrl: 'https://developer.availity.com/',
    feasibilityNotes:
      'Availity partner OAuth2 APIs exist after contracting/subscription. Credentialing/enrollment submission is NOT assumed. Not configured for this deployment.'
  },
  {
    integrationType: ExternalIntegrationType.PAYER_PORTAL,
    displayName: 'Generic payer portal (manual)',
    systemName: 'PAYER_PORTAL',
    status: ExternalIntegrationStatus.MANUAL_ONLY,
    connectionMode: ExternalConnectionMode.MANUAL_PORTAL,
    officialSourceUrl: '',
    feasibilityNotes:
      'Individual payer portals vary. No automated submission claimed. Use Phase 4C manual submission confirmation.'
  }
];

export async function ensurePlatformIntegrationCatalog() {
  for (const item of PLATFORM_CATALOG) {
    const existing = await prisma.externalIntegration.findFirst({
      where: { tenantId: null, integrationType: item.integrationType, systemName: item.systemName }
    });
    const adapter = adapterForType(item.integrationType);
    const capabilities = adapter.getCapabilities({
      integrationId: existing?.id || 'catalog',
      integrationType: item.integrationType,
      tenantId: null,
      credentialSecretRef: null,
      capabilities: (existing?.capabilities as CapabilityMap) || {},
      connectionMode: item.connectionMode,
      status: item.status
    });
    if (existing) {
      await prisma.externalIntegration.update({
        where: { id: existing.id },
        data: {
          capabilities: capabilities as any,
          feasibilityNotes: item.feasibilityNotes,
          officialSourceUrl: item.officialSourceUrl || null
        }
      });
    } else {
      await prisma.externalIntegration.create({
        data: {
          tenantId: null,
          integrationType: item.integrationType,
          displayName: item.displayName,
          systemName: item.systemName,
          status: item.status,
          connectionMode: item.connectionMode,
          capabilities: capabilities as any,
          feasibilityNotes: item.feasibilityNotes,
          officialSourceUrl: item.officialSourceUrl || null,
          lastVerifiedAt: new Date()
        }
      });
    }
  }
}

export async function listIntegrations(input: {
  tenantId: string;
  role: Role;
  audience: 'gpa' | 'client' | 'provider';
  includePlatform?: boolean;
}) {
  if (!canViewIntegrations(input.role)) deny('Insufficient permissions', 403);
  await ensurePlatformIntegrationCatalog();
  const rows = await prisma.externalIntegration.findMany({
    where: {
      OR: [
        { tenantId: input.tenantId },
        ...(input.includePlatform !== false ? [{ tenantId: null as any }] : [])
      ]
    },
    orderBy: [{ integrationType: 'asc' }, { displayName: 'asc' }]
  });
  return rows.map((r) => sanitizeIntegration(r, input.audience));
}

export async function getIntegration(input: {
  tenantId: string;
  integrationId: string;
  role: Role;
  audience: 'gpa' | 'client' | 'provider';
}) {
  if (!canViewIntegrations(input.role)) deny('Insufficient permissions', 403);
  const row = await prisma.externalIntegration.findFirst({
    where: {
      id: input.integrationId,
      OR: [{ tenantId: input.tenantId }, { tenantId: null }]
    }
  });
  if (!row) deny('Integration not found', 404);
  return sanitizeIntegration(row, input.audience);
}

async function loadTenantScopedIntegration(tenantId: string, integrationId: string) {
  const row = await prisma.externalIntegration.findFirst({
    where: {
      id: integrationId,
      OR: [{ tenantId }, { tenantId: null }]
    }
  });
  if (!row) deny('Integration not found', 404);
  return row;
}

export async function createTenantIntegration(input: {
  tenantId: string;
  actorId: string;
  role: Role;
  integrationType: ExternalIntegrationType;
  displayName: string;
  systemName: string;
  connectionMode?: ExternalConnectionMode;
  status?: ExternalIntegrationStatus;
  feasibilityNotes?: string | null;
  officialSourceUrl?: string | null;
  cloneFromPlatformId?: string | null;
}) {
  if (!canConfigureIntegrations(input.role)) deny('Insufficient permissions to configure integrations', 403);
  if (input.status === ExternalIntegrationStatus.CONNECTED) {
    deny('CONNECTED may only be set after a successful connection test', 400, 'CONNECTED_REQUIRES_TEST');
  }

  let capabilities: CapabilityMap = {};
  let connectionMode = input.connectionMode || ExternalConnectionMode.NOT_AVAILABLE;
  let status = input.status || ExternalIntegrationStatus.NOT_CONFIGURED;
  let feasibilityNotes = input.feasibilityNotes || null;
  let officialSourceUrl = input.officialSourceUrl || null;

  if (input.cloneFromPlatformId) {
    const platform = await prisma.externalIntegration.findFirst({
      where: { id: input.cloneFromPlatformId, tenantId: null }
    });
    if (!platform) deny('Platform integration template not found', 404);
    capabilities = (platform.capabilities as CapabilityMap) || {};
    connectionMode = platform.connectionMode;
    status = platform.status === ExternalIntegrationStatus.CONNECTED
      ? ExternalIntegrationStatus.NOT_CONFIGURED
      : platform.status;
    feasibilityNotes = feasibilityNotes || platform.feasibilityNotes;
    officialSourceUrl = officialSourceUrl || platform.officialSourceUrl;
  } else {
    const adapter = adapterForType(input.integrationType);
    capabilities = adapter.getCapabilities({
      integrationId: 'new',
      integrationType: input.integrationType,
      tenantId: input.tenantId,
      credentialSecretRef: null,
      capabilities: {},
      connectionMode,
      status
    });
  }

  const row = await prisma.externalIntegration.create({
    data: {
      tenantId: input.tenantId,
      integrationType: input.integrationType,
      displayName: input.displayName,
      systemName: input.systemName,
      status,
      connectionMode,
      capabilities: capabilities as any,
      feasibilityNotes,
      officialSourceUrl,
      credentialConfiguredById: null
    }
  });
  return sanitizeIntegration(row, 'gpa');
}

export async function updateIntegration(input: {
  tenantId: string;
  integrationId: string;
  actorId: string;
  role: Role;
  displayName?: string;
  status?: ExternalIntegrationStatus;
  connectionMode?: ExternalConnectionMode;
  feasibilityNotes?: string | null;
  officialSourceUrl?: string | null;
  disabled?: boolean;
}) {
  if (!canConfigureIntegrations(input.role)) deny('Insufficient permissions', 403);
  const existing = await prisma.externalIntegration.findFirst({
    where: { id: input.integrationId, tenantId: input.tenantId }
  });
  if (!existing) {
    // Platform rows: limited updates
    const platform = await prisma.externalIntegration.findFirst({
      where: { id: input.integrationId, tenantId: null }
    });
    if (!platform) deny('Integration not found', 404);
    deny('Platform catalog integrations are read-only; create a tenant-scoped copy to configure', 403);
  }

  if (input.status === ExternalIntegrationStatus.CONNECTED && existing!.status !== ExternalIntegrationStatus.CONNECTED) {
    deny('CONNECTED may only be set by a successful connection test', 400, 'CONNECTED_REQUIRES_TEST');
  }

  const row = await prisma.externalIntegration.update({
    where: { id: existing!.id },
    data: {
      displayName: input.displayName ?? undefined,
      status: input.disabled ? ExternalIntegrationStatus.DISABLED : (input.status ?? undefined),
      connectionMode: input.connectionMode ?? undefined,
      feasibilityNotes: input.feasibilityNotes === undefined ? undefined : input.feasibilityNotes,
      officialSourceUrl: input.officialSourceUrl === undefined ? undefined : input.officialSourceUrl
    }
  });
  return sanitizeIntegration(row, 'gpa');
}

/**
 * Configure credential reference only — never store plaintext secret in DB.
 * Local/dev: tenant-scoped in-memory secret (mem:…) — never process.env.
 * Production: AWS Secrets Manager ref (aws:name); leave PENDING_CREDENTIALS if AWS not configured.
 */
export async function configureIntegrationCredentials(input: {
  tenantId: string;
  integrationId: string;
  actorId: string;
  role: Role;
  envVarName?: string | null;
  awsSecretId?: string | null;
  /** Local/test only — stored in tenant-scoped memory map. Never process.env / never DB. */
  localSecretValue?: string | null;
}) {
  if (!canConfigureIntegrations(input.role)) {
    deny('Insufficient permissions — clients and external providers cannot configure integration credentials', 403);
  }

  const existing = await prisma.externalIntegration.findFirst({
    where: { id: input.integrationId, tenantId: input.tenantId }
  });
  if (!existing) deny('Tenant integration not found (platform catalog is not credential-configurable here)', 404);

  let secretRef: string | null = null;
  let credentialsReady = false;

  if (input.awsSecretId) {
    if (!awsSecretsManagerConfigured()) {
      deny(
        'AWS Secrets Manager is not configured (set AWS_SECRETS_MANAGER_ENABLED=1 and AWS_REGION). Integration remains PENDING_CREDENTIALS.',
        409,
        'AWS_SECRETS_NOT_CONFIGURED'
      );
    }
    secretRef = `aws:${String(input.awsSecretId).trim()}`;
    credentialsReady = true;
  } else if (input.localSecretValue != null && String(input.localSecretValue) !== '') {
    if (process.env.NODE_ENV === 'production') {
      deny(
        'Local secret values are forbidden in production — configure AWS Secrets Manager',
        409,
        'LOCAL_SECRET_FORBIDDEN_IN_PRODUCTION'
      );
    }
    const secretId = input.envVarName
      ? String(input.envVarName).trim()
      : `integration_${existing.id}`;
    const configured = configureTenantMemSecret(input.tenantId, secretId, input.localSecretValue);
    secretRef = configured.secretRef;
    credentialsReady = configured.configured;
  } else if (input.envVarName) {
    // Platform env reference only (no plaintext write). Ready if the env var already exists.
    const name = String(input.envVarName).trim();
    secretRef = buildEnvSecretRef(name);
    credentialsReady = Boolean(process.env[name] && String(process.env[name]).trim());
  } else {
    deny('Provide envVarName, awsSecretId, or localSecretValue as a secret reference (never store raw secrets in the database)', 400);
  }

  const nextStatus =
    secretRef.startsWith('aws:') || credentialsReady
      ? ExternalIntegrationStatus.READY_FOR_CONNECTION_TEST
      : ExternalIntegrationStatus.PENDING_CREDENTIALS;

  const row = await prisma.externalIntegration.update({
    where: { id: existing.id },
    data: {
      credentialSecretRef: secretRef,
      credentialConfiguredAt: new Date(),
      credentialConfiguredById: input.actorId,
      status: nextStatus,
      lastErrorAt: null,
      lastErrorCode: null,
      lastErrorSummary: null
    }
  });

  return sanitizeIntegration(row, 'gpa');
}

export async function testIntegrationConnection(input: {
  tenantId: string;
  integrationId: string;
  actorId: string;
  role: Role;
}) {
  if (!canTestConnection(input.role)) deny('Insufficient permissions', 403);
  const integration = await loadTenantScopedIntegration(input.tenantId, input.integrationId);
  // Only allow mutating status for tenant-owned rows; platform catalog can be tested read-only
  const adapter = adapterForType(integration.integrationType);
  const ctx = {
    integrationId: integration.id,
    integrationType: integration.integrationType,
    tenantId: integration.tenantId,
    credentialSecretRef: integration.credentialSecretRef,
    capabilities: (integration.capabilities as CapabilityMap) || {},
    connectionMode: integration.connectionMode,
    status: integration.status
  };

  const result = await adapter.testConnection(ctx);
  const safeSummary = redactSecretsFromText(result.summary);

  const op = await prisma.externalIntegrationOperation.create({
    data: {
      tenantId: input.tenantId,
      integrationId: integration.id,
      operationType: 'TEST_CONNECTION',
      operationStatus: result.ok
        ? (result.code === 'MANUAL_ONLY' || result.code === 'MANUAL_WORKFLOW_AVAILABLE'
          ? ExternalOperationStatus.REQUIRES_MANUAL_ACTION
          : ExternalOperationStatus.SUCCEEDED)
        : ExternalOperationStatus.FAILED,
      startedAt: new Date(),
      completedAt: new Date(),
      initiatedById: input.actorId,
      safeErrorCode: result.ok ? null : (result.code || 'TEST_FAILED'),
      safeErrorSummary: safeSummary,
      metadata: {
        wouldSetStatus: result.data?.wouldSetStatus || null,
        mock: process.env.INTEGRATION_TEST_MOCK === '1' || undefined
      } as any
    }
  });

  if (integration.tenantId === input.tenantId) {
    const nextStatus = result.data?.wouldSetStatus || integration.status;
    const isMock = result.code === 'MOCK_ONLY' || process.env.INTEGRATION_TEST_MOCK === '1';
    // C3: CONNECTED only for verified real connection tests — never from mocks.
    let statusToApply = integration.status;
    if (result.ok && nextStatus === ExternalIntegrationStatus.TEST_MOCK_SUCCEEDED) {
      statusToApply = ExternalIntegrationStatus.TEST_MOCK_SUCCEEDED;
    } else if (result.ok && nextStatus === ExternalIntegrationStatus.CONNECTED && !isMock) {
      statusToApply = ExternalIntegrationStatus.CONNECTED;
    } else if (result.ok && nextStatus === ExternalIntegrationStatus.MANUAL_ONLY) {
      statusToApply = ExternalIntegrationStatus.MANUAL_ONLY;
    } else if (!result.ok) {
      statusToApply =
        nextStatus === ExternalIntegrationStatus.PENDING_CREDENTIALS
        || nextStatus === ExternalIntegrationStatus.PENDING_APPROVAL
          ? nextStatus
          : ExternalIntegrationStatus.DEGRADED;
    }

    await prisma.externalIntegration.update({
      where: { id: integration.id },
      data: {
        status: statusToApply,
        connectionMode: result.data?.connectionMode || integration.connectionMode,
        lastTestedAt: new Date(),
        lastSuccessfulSyncAt:
          result.ok && statusToApply === ExternalIntegrationStatus.CONNECTED
            ? new Date()
            : integration.lastSuccessfulSyncAt,
        lastErrorAt: result.ok ? null : new Date(),
        lastErrorCode: result.ok ? null : (result.code || 'TEST_FAILED'),
        lastErrorSummary: result.ok ? null : safeSummary
      }
    });
  }

  return {
    operationId: op.id,
    ok: result.ok,
    code: result.code,
    summary: safeSummary,
    integration: await getIntegration({
      tenantId: input.tenantId,
      integrationId: integration.id,
      role: input.role,
      audience: 'gpa'
    })
  };
}

function isAuthActive(auth: {
  status: ProviderIntegrationAuthStatus;
  expiresAt: Date | null;
  revokedAt: Date | null;
}) {
  if (auth.status !== ProviderIntegrationAuthStatus.GRANTED) return false;
  if (auth.revokedAt) return false;
  if (auth.expiresAt && auth.expiresAt.getTime() < Date.now()) return false;
  return true;
}

export async function assertActiveProviderAuthorization(input: {
  tenantId: string;
  providerId: string;
  integrationId: string;
}) {
  const auth = await prisma.providerIntegrationAuthorization.findFirst({
    where: {
      tenantId: input.tenantId,
      providerId: input.providerId,
      integrationId: input.integrationId
    },
    orderBy: { createdAt: 'desc' }
  });
  if (!auth) deny('Provider integration authorization is required', 403, 'AUTH_REQUIRED');
  if (auth.status === ProviderIntegrationAuthStatus.REVOKED) {
    deny('Provider integration authorization was revoked', 403, 'AUTH_REVOKED');
  }
  if (auth.status === ProviderIntegrationAuthStatus.EXPIRED
    || (auth.expiresAt && auth.expiresAt.getTime() < Date.now())) {
    if (auth.status === ProviderIntegrationAuthStatus.GRANTED) {
      await prisma.providerIntegrationAuthorization.update({
        where: { id: auth.id },
        data: { status: ProviderIntegrationAuthStatus.EXPIRED }
      });
    }
    deny('Provider integration authorization is expired', 403, 'AUTH_EXPIRED');
  }
  if (!isAuthActive(auth)) deny('Provider integration authorization is not granted', 403, 'AUTH_NOT_GRANTED');
  return auth;
}

export async function listProviderAuthorizations(input: {
  tenantId: string;
  providerId: string;
  role: Role;
}) {
  if (!canViewIntegrations(input.role)) deny('Insufficient permissions', 403);
  await assertProviderInTenant(input.tenantId, input.providerId);
  const rows = await prisma.providerIntegrationAuthorization.findMany({
    where: { tenantId: input.tenantId, providerId: input.providerId },
    orderBy: { createdAt: 'desc' },
    include: {
      integration: { select: { id: true, displayName: true, integrationType: true, status: true } },
      grantedBy: { select: { id: true, name: true, email: true } }
    }
  });
  return rows.map((r) => ({
    ...r,
    active: isAuthActive(r),
    // never leak internal notes beyond notes field already present
  }));
}

export async function grantProviderAuthorization(input: {
  tenantId: string;
  providerId: string;
  integrationId: string;
  actorId: string;
  role: Role;
  authorizationType?: string;
  expiresAt?: Date | string | null;
  evidenceDocumentId?: string | null;
  externalReference?: string | null;
  scope?: string[];
  notes?: string | null;
}) {
  if (!canManageProviderAuthorization(input.role)) deny('Insufficient permissions', 403);
  await assertProviderInTenant(input.tenantId, input.providerId);
  const integration = await loadTenantScopedIntegration(input.tenantId, input.integrationId);
  await assertTrustedEvidence(input.tenantId, input.evidenceDocumentId, 'Authorization evidence');

  const existing = await prisma.providerIntegrationAuthorization.findFirst({
    where: {
      tenantId: input.tenantId,
      providerId: input.providerId,
      integrationId: integration.id,
      status: ProviderIntegrationAuthStatus.GRANTED
    }
  });

  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) deny('Invalid expiresAt');

  let row;
  if (existing) {
    row = await prisma.providerIntegrationAuthorization.update({
      where: { id: existing.id },
      data: {
        status: ProviderIntegrationAuthStatus.GRANTED,
        grantedAt: new Date(),
        expiresAt,
        revokedAt: null,
        grantedById: input.actorId,
        evidenceDocumentId: input.evidenceDocumentId || null,
        externalReference: input.externalReference || null,
        scope: (input.scope || []) as any,
        notes: input.notes || null,
        authorizationType: input.authorizationType || existing.authorizationType
      }
    });
    await prisma.providerIntegrationAuthorizationEvent.create({
      data: {
        authorizationId: row.id,
        fromStatus: existing.status,
        toStatus: ProviderIntegrationAuthStatus.GRANTED,
        actorId: input.actorId,
        reason: 'Authorization re-granted/updated'
      }
    });
  } else {
    row = await prisma.providerIntegrationAuthorization.create({
      data: {
        tenantId: input.tenantId,
        providerId: input.providerId,
        integrationId: integration.id,
        authorizationType: input.authorizationType || 'DELEGATION',
        status: ProviderIntegrationAuthStatus.GRANTED,
        grantedAt: new Date(),
        expiresAt,
        grantedById: input.actorId,
        evidenceDocumentId: input.evidenceDocumentId || null,
        externalReference: input.externalReference || null,
        scope: (input.scope || []) as any,
        notes: input.notes || null
      }
    });
    await prisma.providerIntegrationAuthorizationEvent.create({
      data: {
        authorizationId: row.id,
        fromStatus: ProviderIntegrationAuthStatus.NOT_REQUESTED,
        toStatus: ProviderIntegrationAuthStatus.GRANTED,
        actorId: input.actorId,
        reason: 'Authorization granted'
      }
    });
  }
  return row;
}

export async function revokeProviderAuthorization(input: {
  tenantId: string;
  providerId: string;
  authorizationId: string;
  actorId: string;
  role: Role;
  reason?: string | null;
}) {
  if (!canManageProviderAuthorization(input.role)) deny('Insufficient permissions', 403);
  await assertProviderInTenant(input.tenantId, input.providerId);
  const row = await prisma.providerIntegrationAuthorization.findFirst({
    where: {
      id: input.authorizationId,
      tenantId: input.tenantId,
      providerId: input.providerId
    }
  });
  if (!row) deny('Authorization not found', 404);
  const updated = await prisma.providerIntegrationAuthorization.update({
    where: { id: row.id },
    data: {
      status: ProviderIntegrationAuthStatus.REVOKED,
      revokedAt: new Date()
    }
  });
  await prisma.providerIntegrationAuthorizationEvent.create({
    data: {
      authorizationId: row.id,
      fromStatus: row.status,
      toStatus: ProviderIntegrationAuthStatus.REVOKED,
      actorId: input.actorId,
      reason: input.reason || 'Revoked'
    }
  });
  return updated;
}

export async function listOperations(input: {
  tenantId: string;
  integrationId?: string;
  role: Role;
  limit?: number;
}) {
  if (!canViewIntegrations(input.role)) deny('Insufficient permissions', 403);
  if (input.integrationId) {
    await loadTenantScopedIntegration(input.tenantId, input.integrationId);
  }
  return prisma.externalIntegrationOperation.findMany({
    where: {
      tenantId: input.tenantId,
      ...(input.integrationId ? { integrationId: input.integrationId } : {})
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(input.limit || 50, 200),
    include: {
      initiatedBy: { select: { id: true, name: true, email: true } },
      integration: { select: { id: true, displayName: true, integrationType: true } }
    }
  });
}

export async function getOperation(input: { tenantId: string; operationId: string; role: Role }) {
  if (!canViewIntegrations(input.role)) deny('Insufficient permissions', 403);
  const row = await prisma.externalIntegrationOperation.findFirst({
    where: { id: input.operationId, tenantId: input.tenantId },
    include: {
      initiatedBy: { select: { id: true, name: true, email: true } },
      integration: { select: { id: true, displayName: true, integrationType: true } }
    }
  });
  if (!row) deny('Operation not found', 404);
  return row;
}

/**
 * Manual workflow fallback — records a staff action; does NOT mark enrollment SUBMITTED/APPROVED.
 * Optionally creates a Phase 4C communication. Links operation history as REQUIRES_MANUAL_ACTION / SUCCEEDED (manual record).
 */
export async function recordManualIntegrationAction(input: {
  tenantId: string;
  enrollmentId: string;
  actorId: string;
  role: Role;
  integrationId: string;
  actionType: string;
  summary: string;
  externalReference?: string | null;
  evidenceDocumentId?: string | null;
  channel?: string | null;
  notes?: string | null;
  createCommunication?: boolean;
  idempotencyKey?: string | null;
}) {
  if (!canManageProviderAuthorization(input.role)) {
    deny('Only GPA staff may record manual integration actions', 403);
  }

  const enrollment = await prisma.enrollmentApplication.findFirst({
    where: { id: input.enrollmentId, tenantId: input.tenantId }
  });
  if (!enrollment) deny('Enrollment not found', 404);
  if (enrollment.providerId) await assertProviderInTenant(input.tenantId, enrollment.providerId);

  const integration = await loadTenantScopedIntegration(input.tenantId, input.integrationId);
  await assertTrustedEvidence(input.tenantId, input.evidenceDocumentId, 'Manual action evidence');

  if (input.idempotencyKey) {
    const existing = await prisma.externalIntegrationOperation.findFirst({
      where: { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey }
    });
    if (existing) return { operation: existing, communication: null, note: 'Idempotent replay — existing operation returned' };
  }

  // Authorization required when provider is present — does not invent consent
  if (enrollment.providerId) {
    await assertActiveProviderAuthorization({
      tenantId: input.tenantId,
      providerId: enrollment.providerId,
      integrationId: integration.id
    });
  }

  const beforeStatus = enrollment.status;

  const operation = await prisma.externalIntegrationOperation.create({
    data: {
      tenantId: input.tenantId,
      integrationId: integration.id,
      providerId: enrollment.providerId,
      enrollmentId: enrollment.id,
      operationType: `MANUAL_${input.actionType}`,
      operationStatus: ExternalOperationStatus.REQUIRES_MANUAL_ACTION,
      externalReference: input.externalReference || null,
      idempotencyKey: input.idempotencyKey || null,
      startedAt: new Date(),
      completedAt: new Date(),
      initiatedById: input.actorId,
      safeErrorSummary: null,
      metadata: {
        summary: input.summary,
        channel: input.channel || 'PAYER_PORTAL_MANUAL',
        evidenceDocumentId: input.evidenceDocumentId || null,
        note: 'Manual workflow record — not an automated external API success',
        enrollmentStatusUnchanged: beforeStatus
      } as any
    }
  });

  let communication = null;
  if (input.createCommunication !== false) {
    communication = await createCommunication({
      tenantId: input.tenantId,
      enrollmentId: enrollment.id,
      actorId: input.actorId,
      role: input.role,
      communicationType: 'OTHER',
      channel: input.channel || 'PAYER_PORTAL_MANUAL',
      channelExplanation: input.channel === 'OTHER' || input.channel === 'PHONE' ? (input.notes || 'manual portal') : null,
      summary: input.summary,
      notes: input.notes || null,
      internalNotes: `Manual integration action via ${integration.displayName}; operation ${operation.id}`,
      evidenceDocumentId: input.evidenceDocumentId || null
    });
  }

  await prisma.enrollmentActivity.create({
    data: {
      enrollmentId: enrollment.id,
      authorId: input.actorId,
      body: `Manual integration action (${integration.displayName}): ${input.summary}`,
      activityType: 'INTEGRATION_MANUAL_ACTION',
      metadata: {
        operationId: operation.id,
        integrationId: integration.id,
        enrollmentStatus: beforeStatus,
        apiSuccessClaimed: false
      } as any
    }
  });

  // Re-read enrollment — status must be unchanged
  const after = await prisma.enrollmentApplication.findUnique({ where: { id: enrollment.id } });
  if (after?.status !== beforeStatus) {
    // Should never happen — defensive
    deny('Manual action unexpectedly changed enrollment status', 500);
  }

  return {
    operation,
    communication,
    enrollmentStatus: after?.status,
    note: 'Manual action recorded. Enrollment lifecycle status was not changed. Confirm actual submission via Phase 4C if applicable.'
  };
}

export async function runUnsupportedExternalOperation(input: {
  tenantId: string;
  integrationId: string;
  actorId: string;
  role: Role;
  providerId?: string | null;
  enrollmentId?: string | null;
  operationType: string;
  idempotencyKey?: string | null;
}) {
  if (!canConfigureIntegrations(input.role) && !canManageProviderAuthorization(input.role)) {
    deny('Insufficient permissions', 403);
  }
  const integration = await loadTenantScopedIntegration(input.tenantId, input.integrationId);
  if (input.providerId) {
    await assertProviderInTenant(input.tenantId, input.providerId);
    await assertActiveProviderAuthorization({
      tenantId: input.tenantId,
      providerId: input.providerId,
      integrationId: integration.id
    });
  }
  if (input.idempotencyKey) {
    const existing = await prisma.externalIntegrationOperation.findFirst({
      where: { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey }
    });
    if (existing) return existing;
  }

  const adapter = adapterForType(integration.integrationType);
  const adapterCtx = {
    integrationId: integration.id,
    integrationType: integration.integrationType,
    tenantId: integration.tenantId,
    credentialSecretRef: integration.credentialSecretRef,
    capabilities: (integration.capabilities as CapabilityMap) || {},
    connectionMode: integration.connectionMode,
    status: integration.status
  };
  let result: { ok: boolean; code?: string; summary: string };
  if (input.operationType === 'SUBMIT_APPLICATION' && adapter.submitApplication) {
    result = await adapter.submitApplication(adapterCtx, {
      idempotencyKey: input.idempotencyKey || undefined
    });
  } else if (input.operationType === 'GET_PROVIDER_PROFILE' && adapter.getProviderProfile) {
    result = await adapter.getProviderProfile(adapterCtx, {});
  } else {
    result = {
      ok: false,
      code: 'NOT_SUPPORTED',
      summary: `${input.operationType} is not implemented for ${integration.integrationType}`
    };
  }

  const enrollmentBefore = input.enrollmentId
    ? await prisma.enrollmentApplication.findFirst({
        where: { id: input.enrollmentId, tenantId: input.tenantId },
        select: { id: true, status: true }
      })
    : null;

  const op = await prisma.externalIntegrationOperation.create({
    data: {
      tenantId: input.tenantId,
      integrationId: integration.id,
      providerId: input.providerId || null,
      enrollmentId: input.enrollmentId || null,
      operationType: input.operationType,
      operationStatus:
        result.code === 'NOT_SUPPORTED'
          ? ExternalOperationStatus.NOT_SUPPORTED
          : result.code === 'REQUIRES_MANUAL_ACTION'
            ? ExternalOperationStatus.REQUIRES_MANUAL_ACTION
            : result.ok
              ? ExternalOperationStatus.SUCCEEDED
              : ExternalOperationStatus.FAILED,
      idempotencyKey: input.idempotencyKey || null,
      startedAt: new Date(),
      completedAt: new Date(),
      initiatedById: input.actorId,
      safeErrorCode: result.ok ? null : result.code || 'FAILED',
      safeErrorSummary: redactSecretsFromText(result.summary),
      metadata: {
        enrollmentStatusBefore: enrollmentBefore?.status || null,
        note: 'External operation did not mutate enrollment lifecycle'
      } as any
    }
  });

  if (enrollmentBefore) {
    const after = await prisma.enrollmentApplication.findUnique({
      where: { id: enrollmentBefore.id },
      select: { status: true }
    });
    if (after && after.status !== enrollmentBefore.status) {
      deny('External operation unexpectedly changed enrollment status', 500);
    }
  }

  return op;
}
