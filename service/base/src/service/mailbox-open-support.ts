import type { MailAliasService } from "../alias/service.js";
import { EasyEmailError } from "../domain/errors.js";
import type { MailRegistry } from "../domain/registry.js";
import type {
  MailAliasOutcome,
  MailAliasPlan,
  MailboxPlanResult,
  MailboxSession,
  MailProviderTypeKey,
  VerificationMailboxRequest,
} from "../domain/models.js";

function normalizeMailboxOpenError(error: unknown): unknown {
  if (error instanceof EasyEmailError) {
    if (error.code === "MOEMAIL_CAPACITY_EXHAUSTED") {
      return new EasyEmailError("MAILBOX_CAPACITY_UNAVAILABLE", error.message, error.details);
    }
    if (error.code === "MOEMAIL_UPSTREAM_TRANSIENT") {
      return new EasyEmailError("MAILBOX_UPSTREAM_TRANSIENT", error.message, error.details);
    }
    return error;
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  if (
    normalized.includes("shared domain")
    && (normalized.includes("restricted") || normalized.includes("not accepting new public addresses"))
  ) {
    return new EasyEmailError("MAILBOX_DOMAIN_EXCLUDED", message);
  }
  if (normalized.includes("m2u_capacity_failure")) {
    return new EasyEmailError("MAILBOX_CAPACITY_UNAVAILABLE", message);
  }
  if (normalized.includes("m2u_transient_failure")) {
    return new EasyEmailError("MAILBOX_UPSTREAM_TRANSIENT", message);
  }
  if (normalized.includes("temporam_capacity_failure")) {
    return new EasyEmailError("MAILBOX_CAPACITY_UNAVAILABLE", message);
  }
  if (normalized.includes("temporam_transient_failure")) {
    return new EasyEmailError("MAILBOX_UPSTREAM_TRANSIENT", message);
  }
  return error;
}

export function attachMailboxOpenErrorContext(
  error: unknown,
  plan: MailboxPlanResult | undefined,
  attemptedProviderTypeKey: MailProviderTypeKey,
): unknown {
  const normalizedError = normalizeMailboxOpenError(error);
  if (!(normalizedError instanceof EasyEmailError)) {
    return normalizedError;
  }

  return new EasyEmailError(normalizedError.code, normalizedError.message, {
    ...normalizedError.details,
    providerTypeKey: normalizedError.details.providerTypeKey
      ?? plan?.providerType.key
      ?? attemptedProviderTypeKey,
    providerInstanceId: normalizedError.details.providerInstanceId ?? plan?.instance.id,
  });
}

export function isUnresolvedProviderPlanError(error: unknown): boolean {
  return error instanceof EasyEmailError && error.code === "PROVIDER_INSTANCE_UNAVAILABLE";
}

export function planAliasSafely(
  aliasService: MailAliasService,
  request: VerificationMailboxRequest,
): MailAliasPlan {
  try {
    return aliasService.planAlias(request);
  } catch (error) {
    if (request.includeAliasEmail !== true) {
      return {
        requested: false,
        status: "not_requested",
      };
    }

    return {
      requested: true,
      status: "failed",
      providerKey: "ddg",
      failureReason: "alias_plan_unexpected_error",
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createAliasOutcomeSafely(
  aliasService: MailAliasService,
  request: VerificationMailboxRequest,
  now: Date,
): Promise<MailAliasOutcome> {
  try {
    return await aliasService.createAliasOutcome(request, now);
  } catch (error) {
    const aliasPlan = planAliasSafely(aliasService, request);
    if (aliasPlan.status === "not_requested") {
      return {
        requested: false,
        status: "not_requested",
      };
    }

    if (aliasPlan.status === "skipped_disabled") {
      return {
        requested: true,
        status: "skipped_disabled",
        providerKey: aliasPlan.providerKey,
      };
    }

    if (
      aliasPlan.status === "failed"
      && aliasPlan.failureReason
      && aliasPlan.failureMessage
      && aliasPlan.failureReason !== "alias_plan_unexpected_error"
    ) {
      return {
        requested: true,
        status: "failed",
        providerKey: aliasPlan.providerKey ?? "ddg",
        failureReason: aliasPlan.failureReason,
        failureMessage: aliasPlan.failureMessage,
      };
    }

    return {
      requested: true,
      status: "failed",
      providerKey: aliasPlan.providerKey ?? "ddg",
      failureReason: "alias_unexpected_error",
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export function persistAliasOutcomeOnSession(
  registry: MailRegistry,
  session: MailboxSession,
  aliasOutcome: MailAliasOutcome,
): MailboxSession {
  const metadata: Record<string, string> = {
    ...session.metadata,
    aliasRequested: String(aliasOutcome.requested),
    aliasStatus: aliasOutcome.status,
  };

  if (aliasOutcome.providerKey) {
    metadata.aliasProviderKey = aliasOutcome.providerKey;
  } else {
    delete metadata.aliasProviderKey;
  }

  if (aliasOutcome.alias?.emailAddress) {
    metadata.aliasEmailAddress = aliasOutcome.alias.emailAddress;
  } else {
    delete metadata.aliasEmailAddress;
  }

  if (aliasOutcome.alias?.createdAt) {
    metadata.aliasCreatedAt = aliasOutcome.alias.createdAt;
  } else {
    delete metadata.aliasCreatedAt;
  }

  if (aliasOutcome.failureReason) {
    metadata.aliasFailureReason = aliasOutcome.failureReason;
  } else {
    delete metadata.aliasFailureReason;
  }

  if (aliasOutcome.failureMessage) {
    metadata.aliasFailureMessage = aliasOutcome.failureMessage;
  } else {
    delete metadata.aliasFailureMessage;
  }

  const nextSession = {
    ...session,
    metadata,
  };
  registry.saveSession(nextSession);
  return nextSession;
}
