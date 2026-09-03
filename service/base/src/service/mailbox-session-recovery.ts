import { normalizeMailProviderTypeKey } from "../domain/models.js";
import type { MailRegistry } from "../domain/registry.js";
import { createMailboxAccessDescriptor } from "./mailbox-access-descriptor.js";
import { createMailboxSessionFromRecoveryFields } from "./mailbox-field-recovery.js";
import type { MailProviderAdapter, MailboxRecoveryStrategy } from "../providers/contracts.js";
import type {
  MailboxAccessDescriptor,
  MailboxSession,
  MailProviderTypeKey,
} from "../domain/models.js";

export interface MailboxSessionRecoveryInput {
  emailAddress?: string;
  providerTypeKey?: MailProviderTypeKey;
  providerInstanceId?: string;
  hostId?: string;
  recoveryDataCredential?: Record<string, string>;
  recoveryFields?: Record<string, string>;
}

export type MailboxSessionRecoveryResult = {
  recovered: boolean;
  strategy: MailboxRecoveryStrategy;
  providerTypeKey?: MailProviderTypeKey;
  providerInstanceId?: string;
  session?: MailboxSession;
  detail?: string;
} & Partial<MailboxAccessDescriptor>;

export async function recoverMailboxSessionByEmailAddress({
  input,
  registry,
  adapterMap,
  now = new Date(),
  syncOperationalState,
}: {
  input: MailboxSessionRecoveryInput;
  registry: MailRegistry;
  adapterMap: Map<MailProviderTypeKey, MailProviderAdapter>;
  now?: Date;
  syncOperationalState: (now?: Date) => void;
}): Promise<MailboxSessionRecoveryResult> {
  syncOperationalState(now);
  const recoveryDataCredential = input.recoveryDataCredential;
  const effectiveRecoveryFields = input.recoveryFields ?? recoveryDataCredential;
  const normalizedEmail = (input.emailAddress ?? recoveryDataCredential?.emailAddress)?.trim().toLowerCase();
  if (!normalizedEmail) {
    return {
      recovered: false,
      strategy: "not_supported",
      detail: "email_address_required_for_recovery",
    };
  }

  const requestedProviderInstanceId = input.providerInstanceId?.trim()
    || recoveryDataCredential?.providerInstanceId?.trim();
  const effectiveHostId = input.hostId?.trim()
    || recoveryDataCredential?.hostId?.trim();
  const requestedInstance = requestedProviderInstanceId
    ? registry.findInstanceById(requestedProviderInstanceId)
    : undefined;
  const normalizedProviderTypeKey = normalizeMailProviderTypeKey(input.providerTypeKey)
    ?? normalizeMailProviderTypeKey(recoveryDataCredential?.providerTypeKey)
    ?? requestedInstance?.providerTypeKey;

  if (requestedProviderInstanceId && !requestedInstance) {
    return {
      recovered: false,
      strategy: "not_supported",
      providerTypeKey: normalizedProviderTypeKey,
      providerInstanceId: requestedProviderInstanceId,
      detail: "provider_instance_not_found",
    };
  }

  if (
    requestedInstance
    && input.providerTypeKey
    && normalizedProviderTypeKey
    && requestedInstance.providerTypeKey !== normalizedProviderTypeKey
  ) {
    return {
      recovered: false,
      strategy: "not_supported",
      providerTypeKey: normalizedProviderTypeKey,
      providerInstanceId: requestedInstance.id,
      detail: "provider_instance_type_mismatch",
    };
  }

  const session = registry.listSessions()
    .filter((item) => item.emailAddress.trim().toLowerCase() === normalizedEmail)
    .filter((item) => !normalizedProviderTypeKey || item.providerTypeKey === normalizedProviderTypeKey)
    .filter((item) => !requestedProviderInstanceId || item.providerInstanceId === requestedProviderInstanceId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

  if (session) {
    const instance = registry.findInstanceById(session.providerInstanceId);
    const adapter = instance ? adapterMap.get(instance.providerTypeKey) : undefined;
    if (instance && adapter?.recoverMailboxSession) {
      const credentialSets = registry.resolveCredentialSetsForInstance(instance.id, "generate");
      const recovered = await adapter.recoverMailboxSession({
        emailAddress: normalizedEmail,
        hostId: effectiveHostId || session.hostId,
        instance,
        credentialSets,
        now,
        session,
        recoveryFields: effectiveRecoveryFields,
      });
      if (recovered) {
        registry.saveSession(recovered.session);
        const descriptor = createMailboxAccessDescriptor(recovered.session, instance, now);
        return {
          recovered: true,
          strategy: recovered.strategy,
          providerTypeKey: recovered.session.providerTypeKey,
          providerInstanceId: recovered.session.providerInstanceId,
          session: recovered.session,
          detail: recovered.detail,
          ...descriptor,
        };
      }
    }

    const descriptor = instance
      ? createMailboxAccessDescriptor(session, instance, now)
      : undefined;
    return {
      recovered: true,
      strategy: "session_restore",
      providerTypeKey: session.providerTypeKey,
      providerInstanceId: session.providerInstanceId,
      session,
      detail: "recovered_from_persisted_state",
      ...(descriptor ?? {}),
    };
  }

  if (!normalizedProviderTypeKey) {
    return {
      recovered: false,
      strategy: "not_supported",
      detail: "provider_type_required_for_provider_recovery",
    };
  }

  const candidates = requestedProviderInstanceId
    ? registry.listActiveInstancesByType(normalizedProviderTypeKey)
      .filter((instance) => instance.id === requestedProviderInstanceId)
    : registry.listActiveInstancesByType(normalizedProviderTypeKey);
  const adapter = adapterMap.get(normalizedProviderTypeKey);
  if (!adapter?.recoverMailboxSession || candidates.length === 0) {
    if (effectiveRecoveryFields && candidates.length > 0) {
      for (const instance of candidates) {
        const recoveredFromFields = createMailboxSessionFromRecoveryFields({
          emailAddress: normalizedEmail,
          hostId: effectiveHostId,
          providerTypeKey: normalizedProviderTypeKey,
          instance,
          recoveryFields: effectiveRecoveryFields,
          now,
        });
        if (!recoveredFromFields) {
          continue;
        }

        registry.saveSession(recoveredFromFields.session);
        const descriptor = createMailboxAccessDescriptor(recoveredFromFields.session, instance, now);
        return {
          recovered: true,
          strategy: recoveredFromFields.strategy,
          providerTypeKey: recoveredFromFields.session.providerTypeKey,
          providerInstanceId: recoveredFromFields.session.providerInstanceId,
          session: recoveredFromFields.session,
          detail: recoveredFromFields.detail,
          ...descriptor,
        };
      }
    }
    return {
      recovered: false,
      strategy: "not_supported",
      providerTypeKey: normalizedProviderTypeKey,
      providerInstanceId: requestedProviderInstanceId,
      detail: "provider_recovery_not_supported",
    };
  }

  for (const instance of candidates) {
    const credentialSets = registry.resolveCredentialSetsForInstance(instance.id, "generate");
    const recovered = await adapter.recoverMailboxSession({
      emailAddress: normalizedEmail,
      hostId: effectiveHostId || `recovery:${normalizedProviderTypeKey}`,
      instance,
      credentialSets,
      now,
      recoveryFields: effectiveRecoveryFields,
    });

    if (!recovered) {
      continue;
    }

    registry.saveSession(recovered.session);
    const descriptor = createMailboxAccessDescriptor(recovered.session, instance, now);
    return {
      recovered: true,
      strategy: recovered.strategy,
      providerTypeKey: recovered.session.providerTypeKey,
      providerInstanceId: recovered.session.providerInstanceId,
      session: recovered.session,
      detail: recovered.detail,
      ...descriptor,
    };
  }

  if (effectiveRecoveryFields) {
    for (const instance of candidates) {
      const recoveredFromFields = createMailboxSessionFromRecoveryFields({
        emailAddress: normalizedEmail,
        hostId: effectiveHostId,
        providerTypeKey: normalizedProviderTypeKey,
        instance,
        recoveryFields: effectiveRecoveryFields,
        now,
      });
      if (!recoveredFromFields) {
        continue;
      }

      registry.saveSession(recoveredFromFields.session);
      const descriptor = createMailboxAccessDescriptor(recoveredFromFields.session, instance, now);
      return {
        recovered: true,
        strategy: recoveredFromFields.strategy,
        providerTypeKey: recoveredFromFields.session.providerTypeKey,
        providerInstanceId: recoveredFromFields.session.providerInstanceId,
        session: recoveredFromFields.session,
        detail: recoveredFromFields.detail,
        ...descriptor,
      };
    }
  }

  return {
    recovered: false,
    strategy: "not_supported",
    providerTypeKey: normalizedProviderTypeKey,
    providerInstanceId: requestedProviderInstanceId,
    detail: "provider_recovery_not_supported",
  };
}
