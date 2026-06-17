import type {
  MailboxAccessDescriptor,
  MailboxRecoverabilityEvidenceStatus,
  MailboxRecoverabilityLevel,
  MailboxRecoveryRequiredFields,
  MailboxSession,
  MailboxTemporaryAuthCredential,
  MailProviderRecoverabilityProfile,
  ProviderInstance,
} from "../domain/models.js";
import { decodeCloudflareTempMailboxRef } from "../providers/cloudflare_temp_email/connector/client.js";
import { decodeDuckMailMailboxRef } from "../providers/duckmail/client.js";
import { decodeEtempmailMailboxRef } from "../providers/etempmail/client.js";
import { decodeGuerrillaMailMailboxRef } from "../providers/guerrillamail/client.js";
import { decodeIm215MailboxRef } from "../providers/im215/client.js";
import { decodeM2uMailboxRef } from "../providers/m2u/client.js";
import { decodeMail2925MailboxRef } from "../providers/mail2925/client.js";
import { decodeMailTmMailboxRef } from "../providers/mailtm/client.js";
import { decodeMoemailMailboxRef } from "../providers/moemail/client.js";
import { decodeTempmailLolMailboxRef } from "../providers/tempmail_lol/client.js";
import { decodeTemporamMailboxRef } from "../providers/temporam/client.js";

export const MAILBOX_RECOVERABILITY_MINIMUM_HORIZON_DAYS = 90;

interface ProviderRecoverabilityDecision {
  evidenceStatus: MailboxRecoverabilityEvidenceStatus;
  level: MailboxRecoverabilityLevel;
  reason: string;
}

interface DecodedCredentialDescriptor {
  credential: MailboxTemporaryAuthCredential;
  recoveryFields: Record<string, string>;
  serverSidePrerequisites: string[];
}

function compactFields(values: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const normalized = value?.trim();
    if (normalized) {
      output[key] = normalized;
    }
  }
  return output;
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

function decodeGptmailMailboxRef(mailboxRef: string, expectedInstanceId: string): string | undefined {
  const prefix = `gptmail:${expectedInstanceId}:`;
  if (!mailboxRef.startsWith(prefix)) {
    return undefined;
  }
  const decoded = decodeURIComponent(mailboxRef.slice(prefix.length)).trim().toLowerCase();
  return decoded.includes("@") ? decoded : undefined;
}

function describeDecodedCredentials(session: MailboxSession, instance: ProviderInstance): DecodedCredentialDescriptor {
  if (session.providerTypeKey === "cloudflare_temp_email") {
    const mailbox = decodeCloudflareTempMailboxRef(session.mailboxRef, instance.id);
    if (mailbox) {
      return {
        credential: {
          credentialType: "cloudflare_temp_email_jwt",
          expiresAt: session.expiresAt,
          fields: compactFields({
            address: mailbox.address,
            jwt: mailbox.jwt,
          }),
          serverManaged: false,
        },
        recoveryFields: compactFields({
          emailAddress: mailbox.address,
        }),
        serverSidePrerequisites: ["cloudflare_temp_email_admin_auth"],
      };
    }
  }

  if (session.providerTypeKey === "mailtm") {
    const mailbox = decodeMailTmMailboxRef(session.mailboxRef, instance.id);
    if (mailbox) {
      return {
        credential: {
          credentialType: "mailtm_token_password",
          expiresAt: session.expiresAt,
          fields: compactFields({
            email: mailbox.email,
            token: mailbox.token,
            password: mailbox.password,
          }),
          serverManaged: false,
        },
        recoveryFields: compactFields({
          emailAddress: mailbox.email,
          password: mailbox.password,
        }),
        serverSidePrerequisites: [],
      };
    }
  }

  if (session.providerTypeKey === "m2u") {
    const mailbox = decodeM2uMailboxRef(session.mailboxRef, instance.id);
    if (mailbox) {
      return {
        credential: {
          credentialType: "m2u_token_view_token",
          expiresAt: mailbox.expiresAt ?? session.expiresAt,
          fields: compactFields({
            email: mailbox.email,
            token: mailbox.token,
            viewToken: mailbox.viewToken,
            mailboxId: mailbox.mailboxId,
          }),
          serverManaged: false,
        },
        recoveryFields: compactFields({
          emailAddress: mailbox.email,
        }),
        serverSidePrerequisites: ["m2u_manual_same_address_recreation"],
      };
    }
  }

  if (session.providerTypeKey === "etempmail") {
    const mailbox = decodeEtempmailMailboxRef(session.mailboxRef, instance.id);
    if (mailbox) {
      return {
        credential: {
          credentialType: "etempmail_recover_key_cookie",
          expiresAt: session.expiresAt,
          fields: compactFields({
            email: mailbox.email,
            recoverKey: mailbox.recoverKey,
            mailboxId: mailbox.mailboxId,
            sessionCookieHeader: mailbox.sessionCookieHeader,
          }),
          serverManaged: false,
        },
        recoveryFields: compactFields({
          emailAddress: mailbox.email,
          recoverKey: mailbox.recoverKey,
        }),
        serverSidePrerequisites: [],
      };
    }
  }

  if (session.providerTypeKey === "duckmail") {
    const mailbox = decodeDuckMailMailboxRef(session.mailboxRef, instance.id);
    if (mailbox) {
      return {
        credential: {
          credentialType: "duckmail_account_token",
          expiresAt: session.expiresAt,
          fields: compactFields({
            email: mailbox.email,
            token: mailbox.token,
            password: mailbox.password,
            accountId: mailbox.accountId,
          }),
          serverManaged: false,
        },
        recoveryFields: compactFields({
          emailAddress: mailbox.email,
          password: mailbox.password,
        }),
        serverSidePrerequisites: [],
      };
    }
  }

  if (session.providerTypeKey === "guerrillamail") {
    const mailbox = decodeGuerrillaMailMailboxRef(session.mailboxRef, instance.id);
    if (mailbox) {
      return {
        credential: {
          credentialType: "guerrillamail_sid",
          expiresAt: session.expiresAt,
          fields: compactFields({
            emailAddress: mailbox.emailAddress,
            emailUser: mailbox.emailUser,
            sidToken: mailbox.sidToken,
          }),
          serverManaged: false,
        },
        recoveryFields: compactFields({
          emailAddress: mailbox.emailAddress,
          emailUser: mailbox.emailUser,
        }),
        serverSidePrerequisites: [],
      };
    }
  }

  if (session.providerTypeKey === "tempmail-lol") {
    const mailbox = decodeTempmailLolMailboxRef(session.mailboxRef, instance.id);
    if (mailbox) {
      return {
        credential: {
          credentialType: "tempmail_lol_token",
          expiresAt: session.expiresAt,
          fields: compactFields({
            email: mailbox.email,
            token: mailbox.token,
          }),
          serverManaged: false,
        },
        recoveryFields: compactFields({
          emailAddress: mailbox.email,
          token: mailbox.token,
        }),
        serverSidePrerequisites: [],
      };
    }
  }

  if (session.providerTypeKey === "temporam") {
    const mailbox = decodeTemporamMailboxRef(session.mailboxRef, instance.id);
    if (mailbox) {
      return {
        credential: {
          credentialType: "temporam_anonymous_address",
          expiresAt: session.expiresAt,
          fields: compactFields({
            email: mailbox.email,
            localPart: mailbox.localPart,
            domain: mailbox.domain,
            openedAt: mailbox.openedAt,
          }),
          serverManaged: false,
        },
        recoveryFields: compactFields({
          emailAddress: mailbox.email,
          localPart: mailbox.localPart,
          domain: mailbox.domain,
        }),
        serverSidePrerequisites: [],
      };
    }
  }

  if (session.providerTypeKey === "moemail") {
    const mailbox = decodeMoemailMailboxRef(session.mailboxRef, instance.id);
    if (mailbox) {
      return {
        credential: {
          credentialType: "moemail_server_managed_account_binding",
          expiresAt: session.expiresAt,
          fields: compactFields({
            emailId: mailbox.emailId,
            email: mailbox.email,
            credentialSetId: mailbox.credentialSetId,
            credentialItemId: mailbox.credentialItemId,
          }),
          serverManaged: true,
        },
        recoveryFields: compactFields({
          emailAddress: mailbox.email,
        }),
        serverSidePrerequisites: ["moemail_api_key"],
      };
    }
  }

  if (session.providerTypeKey === "mail2925") {
    const mailbox = decodeMail2925MailboxRef(session.mailboxRef, instance.id);
    if (mailbox) {
      return {
        credential: {
          credentialType: "mail2925_server_managed_alias_account",
          expiresAt: session.expiresAt,
          fields: compactFields({
            aliasAddress: mailbox.aliasAddress,
            accountEmail: mailbox.accountEmail,
            credentialSetId: mailbox.credentialSetId,
            credentialItemId: mailbox.credentialItemId,
          }),
          serverManaged: true,
        },
        recoveryFields: compactFields({
          emailAddress: mailbox.aliasAddress,
        }),
        serverSidePrerequisites: ["mail2925_account_credentials"],
      };
    }
  }

  if (session.providerTypeKey === "gptmail") {
    const emailAddress = decodeGptmailMailboxRef(session.mailboxRef, instance.id) ?? session.emailAddress;
    return {
      credential: {
        credentialType: "gptmail_server_managed_api_key_binding",
        expiresAt: session.expiresAt,
        fields: compactFields({
          emailAddress,
        }),
        serverManaged: true,
      },
      recoveryFields: compactFields({
        emailAddress,
      }),
      serverSidePrerequisites: ["gptmail_api_key"],
    };
  }

  if (session.providerTypeKey === "im215") {
    const mailbox = decodeIm215MailboxRef(session.mailboxRef, instance.id);
    if (mailbox) {
      return {
        credential: {
          credentialType: "im215_mailbox_token",
          expiresAt: session.expiresAt,
          fields: compactFields({
            emailAddress: mailbox.address,
            mailboxId: mailbox.mailboxId,
            tempToken: mailbox.tempToken,
          }),
          serverManaged: false,
        },
        recoveryFields: compactFields({
          emailAddress: mailbox.address,
        }),
        serverSidePrerequisites: ["im215_api_key"],
      };
    }
  }

  return {
    credential: {
      credentialType: `${session.providerTypeKey}_mailbox_ref`,
      expiresAt: session.expiresAt,
      fields: compactFields({
        emailAddress: session.emailAddress,
        mailboxRef: session.mailboxRef,
      }),
      serverManaged: false,
    },
    recoveryFields: compactFields({
      emailAddress: session.emailAddress,
    }),
    serverSidePrerequisites: [],
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
