import type {
  MailboxAccessDescriptor,
  MailboxRecoverabilityEvidenceStatus,
  MailboxRecoverabilityLevel,
  MailboxRecoveryRequiredFields,
  MailboxSession,
  MailProviderRecoverabilityProfile,
  ProviderInstance,
} from "../domain/models.js";
import { compactFields, describeDecodedCredentials } from "./mailbox-credential-descriptor.js";

export const MAILBOX_RECOVERABILITY_MINIMUM_HORIZON_DAYS = 90;

interface ProviderRecoverabilityDecision {
  evidenceStatus: MailboxRecoverabilityEvidenceStatus;
  level: MailboxRecoverabilityLevel;
  reason: string;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeRecoverabilityLevel(value: string | undefined): MailboxRecoverabilityLevel | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "unrecoverable" || normalized === "key_recoverable" || normalized === "recoverable") {
    return normalized;
  }
  return undefined;
}

function normalizeEvidenceStatus(value: string | undefined): MailboxRecoverabilityEvidenceStatus | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "undetermined" || normalized === "verified") {
    return normalized;
  }
  return undefined;
}

function resolveMetadataRecoverabilityDecision(instance: ProviderInstance): ProviderRecoverabilityDecision | undefined {
  const evidenceStatus = normalizeEvidenceStatus(instance.metadata.recoverabilityEvidenceStatus);
  const level = normalizeRecoverabilityLevel(instance.metadata.recoverabilityLevel);
  if (evidenceStatus !== "verified" || !level) {
    return undefined;
  }

  const minimumHorizonDays = parsePositiveInteger(instance.metadata.recoverabilityMinimumHorizonDays);
  if (minimumHorizonDays !== undefined && minimumHorizonDays < MAILBOX_RECOVERABILITY_MINIMUM_HORIZON_DAYS) {
    return {
      evidenceStatus: "verified",
      level: "unrecoverable",
      reason: "verified_horizon_below_90_days",
    };
  }

  const mailboxRetentionDays = parsePositiveInteger(instance.metadata.mailboxRetentionDays);
  if (mailboxRetentionDays !== undefined && mailboxRetentionDays < MAILBOX_RECOVERABILITY_MINIMUM_HORIZON_DAYS) {
    return {
      evidenceStatus: "verified",
      level: "unrecoverable",
      reason: "mailbox_retention_below_90_days",
    };
  }

  return {
    evidenceStatus: "verified",
    level,
    reason: instance.metadata.recoverabilityReason?.trim() || "recoverability_verified",
  };
}

function resolveBuiltInRecoverabilityDecision(instance: ProviderInstance): ProviderRecoverabilityDecision | undefined {
  if (instance.providerTypeKey === "cloudflare_temp_email") {
    return {
      evidenceStatus: "verified",
      level: "recoverable",
      reason: "operator_controlled_mailbox_store",
    };
  }

  if (
    instance.providerTypeKey === "im215"
    || instance.providerTypeKey === "mail2925"
    || instance.providerTypeKey === "gptmail"
    || instance.providerTypeKey === "moemail"
  ) {
    return {
      evidenceStatus: "verified",
      level: "recoverable",
      reason: "same_address_recreation_verified",
    };
  }

  if (instance.providerTypeKey === "mailtm") {
    return {
      evidenceStatus: "verified",
      level: "key_recoverable",
      reason: "mailtm_password_relogin_verified",
    };
  }

  if (instance.providerTypeKey === "m2u") {
    return {
      evidenceStatus: "verified",
      level: "recoverable",
      reason: "manual_same_address_recreation_verified",
    };
  }

  if (instance.providerTypeKey === "temporam") {
    return {
      evidenceStatus: "verified",
      level: "recoverable",
      reason: "temporam_same_address_stateless_inbox_verified",
    };
  }

  if (instance.providerTypeKey === "guerrillamail") {
    return {
      evidenceStatus: "verified",
      level: "recoverable",
      reason: "guerrillamail_same_user_recreation_verified",
    };
  }

  if (instance.providerTypeKey === "duckmail") {
    return {
      evidenceStatus: "verified",
      level: "key_recoverable",
      reason: "duckmail_password_relogin_verified",
    };
  }

  if (instance.providerTypeKey === "tempmail-lol") {
    return {
      evidenceStatus: "verified",
      level: "unrecoverable",
      reason: "tempmail_lol_historical_token_future_delivery_failed",
    };
  }

  if (instance.providerTypeKey === "etempmail") {
    return {
      evidenceStatus: "verified",
      level: "unrecoverable",
      reason: "etempmail_recover_key_invalid_in_live_probe",
    };
  }

  return undefined;
}

export function resolveProviderRecoverabilityDecision(
  instance: ProviderInstance,
  _session: Pick<MailboxSession, "providerTypeKey" | "expiresAt"> | undefined,
  _now: Date,
): ProviderRecoverabilityDecision {
  const metadataDecision = resolveMetadataRecoverabilityDecision(instance);
  if (metadataDecision) {
    return metadataDecision;
  }

  const builtInDecision = resolveBuiltInRecoverabilityDecision(instance);
  if (builtInDecision) {
    return builtInDecision;
  }

  return {
    evidenceStatus: "undetermined",
    level: "unrecoverable",
    reason: "recoverability_not_verified",
  };
}

export function isProviderRecoverabilityEligible(
  instance: ProviderInstance,
  requestedLevels: MailboxRecoverabilityLevel[] | undefined,
  includeUndetermined: boolean | undefined,
  now: Date,
): boolean {
  if (!requestedLevels || requestedLevels.length === 0) {
    return true;
  }

  const decision = resolveProviderRecoverabilityDecision(instance, undefined, now);
  if (decision.evidenceStatus === "undetermined") {
    return includeUndetermined === true;
  }

  return requestedLevels.includes(decision.level);
}

export function createProviderRecoverabilityProfile(
  instance: ProviderInstance,
  now: Date,
): MailProviderRecoverabilityProfile {
  const decision = resolveProviderRecoverabilityDecision(instance, undefined, now);
  return {
    providerTypeKey: instance.providerTypeKey,
    providerInstanceId: instance.id,
    recoverabilityLevel: decision.level,
    evidenceStatus: decision.evidenceStatus,
    minimumHorizonDays: MAILBOX_RECOVERABILITY_MINIMUM_HORIZON_DAYS,
    reason: decision.reason,
  };
}

export function createMailboxAccessDescriptor(
  session: MailboxSession,
  instance: ProviderInstance,
  now: Date,
): MailboxAccessDescriptor {
  const decoded = describeDecodedCredentials(session, instance);
  const decision = resolveProviderRecoverabilityDecision(instance, session, now);
  const recoveryRequiredFields: MailboxRecoveryRequiredFields = {
    evidenceStatus: decision.evidenceStatus,
    minimumHorizonDays: MAILBOX_RECOVERABILITY_MINIMUM_HORIZON_DAYS,
    reason: decision.reason,
    fields: decoded.recoveryFields,
    serverSidePrerequisites: [...decoded.serverSidePrerequisites],
  };

  return {
    temporaryAuthCredential: decoded.credential,
    recoveryDataCredential: compactFields({
      emailAddress: session.emailAddress,
      providerTypeKey: instance.providerTypeKey,
      providerInstanceId: instance.id,
      hostId: session.hostId,
      ...decoded.credential.fields,
      ...decoded.recoveryFields,
    }),
    recoverabilityLevel: decision.level,
    recoveryRequiredFields,
    createdByProvider: {
      providerTypeKey: instance.providerTypeKey,
      providerInstanceId: instance.id,
      displayName: instance.displayName,
    },
  };
}
