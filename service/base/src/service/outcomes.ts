import { EasyEmailError } from "../domain/errors.js";
import type {
  MailboxOutcomeReport,
  MailboxOutcomeReportResult,
  MailboxSession,
  ProviderInstance,
} from "../domain/models.js";
import { MailRegistry } from "../domain/registry.js";
import {
  adjustOutcomeWeightedHealthScore,
  extractEmailDomain,
  parseProviderPerformanceStats,
  updateProviderDomainPerformanceStats,
  updateProviderPerformanceStats,
} from "./outcome-performance.js";
import type {
  DomainPerformanceStats,
  ProviderPerformanceStats,
} from "./outcome-performance.js";
import {
  classifyMailboxFailure,
  normalizeDomainMetadataValue,
  normalizeEmailMetadataValue,
  parseConsecutiveFailureCount,
  putOptionalBooleanMetadata,
  putOptionalMetadata,
  putOptionalNumberMetadata,
  resolveFailureCooldownUntil,
  trimMetadataValue,
} from "./outcome-policy.js";
import type { MailboxFailureClass } from "./outcome-policy.js";
import {
  clearProviderInstanceCriticalFailures,
  markProviderInstanceCriticalFailure,
  synchronizeProviderOperationalState,
} from "./provider-operational-state.js";

export { extractEmailDomain, parseProviderPerformanceStats, classifyMailboxFailure };
export type { DomainPerformanceStats, ProviderPerformanceStats, MailboxFailureClass };

function supportsCredentialRuntimeCooldown(registry: MailRegistry, instance: ProviderInstance): boolean {
  return registry.resolveCredentialSetsForInstance(instance.id, "generate").length > 0
    || registry.resolveCredentialSetsForInstance(instance.id, "poll").length > 0;
}

function applyProviderCriticalFailureState(
  registry: MailRegistry,
  instance: ProviderInstance,
  failureClass: MailboxFailureClass,
  now: Date,
): ProviderInstance {
  if (supportsCredentialRuntimeCooldown(registry, instance)) {
    return clearProviderInstanceCriticalFailures(instance, now);
  }

  if (failureClass !== "capacity") {
    return clearProviderInstanceCriticalFailures(instance, now);
  }

  return markProviderInstanceCriticalFailure(instance, {
    reason: "provider_capacity_exhausted",
    now,
  }).instance;
}

export function recordMailboxOpenFailure(
  registry: MailRegistry,
  instance: ProviderInstance,
  error: unknown,
  now: Date,
): void {
  const observedAt = now.toISOString();
  const failureReason = error instanceof Error ? error.message : String(error);
  const failureClass = classifyMailboxFailure(failureReason);
  const stats = updateProviderPerformanceStats(
    parseProviderPerformanceStats(instance.metadata.registrationStatsJson),
    {
      success: false,
      observedAt,
      domain: extractEmailDomain(instance.metadata.domain),
    },
  );
  const consecutiveFailureCount = parseConsecutiveFailureCount(instance.metadata.consecutiveFailureCount) + 1;
  const nextInstance: ProviderInstance = {
    ...instance,
    status: instance.status === "offline" ? "offline" : "degraded",
    healthScore: adjustOutcomeWeightedHealthScore(instance.healthScore, false),
    updatedAt: observedAt,
    metadata: {
      ...instance.metadata,
      registrationStatsJson: JSON.stringify(stats),
      lastRegistrationOutcome: "failure",
      lastRegistrationOutcomeAt: observedAt,
      lastRegistrationFailureReason: failureReason,
      lastFailureClass: failureClass,
      consecutiveFailureCount: String(consecutiveFailureCount),
      cooldownUntil: resolveFailureCooldownUntil(failureClass, now),
    },
  };
  const cooledInstance = applyProviderCriticalFailureState(registry, nextInstance, failureClass, now);
  registry.saveInstance(cooledInstance);
  synchronizeProviderOperationalState(registry, now);
}

export function reportMailboxOutcomeToRegistry(
  registry: MailRegistry,
  report: MailboxOutcomeReport,
  now: Date,
): MailboxOutcomeReportResult {
  const session = registry.findSessionById(report.sessionId);
  if (!session) {
    throw new EasyEmailError("MAILBOX_SESSION_NOT_FOUND", `Unknown mailbox session: ${report.sessionId}.`);
  }

  const instance = registry.findInstanceById(session.providerInstanceId);
  if (!instance) {
    throw new EasyEmailError(
      "PROVIDER_INSTANCE_NOT_FOUND",
      `Unknown provider instance for mailbox session ${report.sessionId}: ${session.providerInstanceId}.`,
    );
  }

  const observedAt = report.observedAt?.trim() || now.toISOString();
  const selectedDomain = session.metadata.selectedDomain || extractEmailDomain(session.emailAddress);
  const attributionKind = trimMetadataValue(report.attribution?.kind);
  const isMailboxDomainRisk = !report.success && attributionKind === "mailbox_domain_risk";
  const stats = (isMailboxDomainRisk ? updateProviderDomainPerformanceStats : updateProviderPerformanceStats)(
    parseProviderPerformanceStats(instance.metadata.registrationStatsJson),
    {
      success: report.success,
      observedAt,
      domain: selectedDomain,
    },
  );
  const failureReason = report.failureReason?.trim();
  const failureClass = classifyMailboxFailure(failureReason);
  const businessFlow = trimMetadataValue(report.businessFlow);
  const retryLayer = trimMetadataValue(report.retryLayer);
  const attributionStrength = trimMetadataValue(report.attribution?.strength);
  const attributionProviderTypeKey = trimMetadataValue(report.attribution?.providerTypeKey)?.toLowerCase();
  const attributionDomain = normalizeDomainMetadataValue(report.attribution?.domain);
  const attributionEmailAddress = normalizeEmailMetadataValue(report.attribution?.emailAddress);
  const policyAvoidInCurrentAttempt = report.policy?.avoidInCurrentAttempt;
  const policyGlobalBlacklist = report.policy?.globalBlacklist;
  const policyCooldownSeconds = report.policy?.cooldownSeconds;

  const nextInstanceMetadata: Record<string, string> = {
    ...instance.metadata,
    registrationStatsJson: JSON.stringify(stats),
  };
  if (!isMailboxDomainRisk) {
    nextInstanceMetadata.lastRegistrationOutcome = report.success ? "success" : "failure";
    nextInstanceMetadata.lastRegistrationOutcomeAt = observedAt;
    if (failureReason) {
      nextInstanceMetadata.lastRegistrationFailureReason = failureReason;
    }
    if (report.success) {
      nextInstanceMetadata.consecutiveFailureCount = "0";
      nextInstanceMetadata.cooldownUntil = "";
      nextInstanceMetadata.lastFailureClass = "";
    } else {
      nextInstanceMetadata.lastFailureClass = failureClass;
      nextInstanceMetadata.consecutiveFailureCount = String(
        parseConsecutiveFailureCount(instance.metadata.consecutiveFailureCount) + 1,
      );
      nextInstanceMetadata.cooldownUntil = resolveFailureCooldownUntil(failureClass, now);
    }
    putOptionalMetadata(nextInstanceMetadata, "lastRegistrationBusinessFlow", businessFlow);
    putOptionalMetadata(nextInstanceMetadata, "lastRegistrationRetryLayer", retryLayer);
    putOptionalMetadata(nextInstanceMetadata, "lastRegistrationAttributionStrength", attributionStrength);
    putOptionalMetadata(nextInstanceMetadata, "lastRegistrationAttributionKind", attributionKind);
    putOptionalMetadata(nextInstanceMetadata, "lastRegistrationAttributionProviderTypeKey", attributionProviderTypeKey);
    putOptionalMetadata(nextInstanceMetadata, "lastRegistrationAttributionDomain", attributionDomain);
    putOptionalMetadata(nextInstanceMetadata, "lastRegistrationAttributionEmailAddress", attributionEmailAddress);
    putOptionalBooleanMetadata(
      nextInstanceMetadata,
      "lastRegistrationPolicyAvoidInCurrentAttempt",
      policyAvoidInCurrentAttempt,
    );
    putOptionalBooleanMetadata(nextInstanceMetadata, "lastRegistrationPolicyGlobalBlacklist", policyGlobalBlacklist);
    putOptionalNumberMetadata(nextInstanceMetadata, "lastRegistrationPolicyCooldownSeconds", policyCooldownSeconds);
  }

  const nextInstance: ProviderInstance = {
    ...instance,
    status: isMailboxDomainRisk
      ? instance.status
      : report.success
        ? "active"
        : (instance.status === "offline" ? "offline" : "degraded"),
    healthScore: isMailboxDomainRisk
      ? instance.healthScore
      : adjustOutcomeWeightedHealthScore(instance.healthScore, report.success),
    updatedAt: observedAt,
    metadata: nextInstanceMetadata,
  };
  const cooledInstance = isMailboxDomainRisk
    ? nextInstance
    : report.success
      ? clearProviderInstanceCriticalFailures(nextInstance, now)
      : applyProviderCriticalFailureState(registry, nextInstance, failureClass, now);
  registry.saveInstance(cooledInstance);
  synchronizeProviderOperationalState(registry, now);

  const nextSessionMetadata: Record<string, string> = {
    ...session.metadata,
    registrationOutcome: report.success ? "success" : "failure",
    registrationOutcomeAt: observedAt,
    ...(selectedDomain ? { selectedDomain } : {}),
    ...(report.failureReason?.trim()
      ? { registrationFailureReason: report.failureReason.trim() }
      : {}),
    ...(report.registrationMode?.trim()
      ? { registrationMode: report.registrationMode.trim() }
      : {}),
    ...(report.source?.trim()
      ? { registrationOutcomeSource: report.source.trim() }
      : {}),
  };
  putOptionalMetadata(nextSessionMetadata, "registrationBusinessFlow", businessFlow);
  putOptionalMetadata(nextSessionMetadata, "registrationRetryLayer", retryLayer);
  putOptionalMetadata(nextSessionMetadata, "registrationAttributionStrength", attributionStrength);
  putOptionalMetadata(nextSessionMetadata, "registrationAttributionKind", attributionKind);
  putOptionalMetadata(nextSessionMetadata, "registrationAttributionProviderTypeKey", attributionProviderTypeKey);
  putOptionalMetadata(nextSessionMetadata, "registrationAttributionDomain", attributionDomain);
  putOptionalMetadata(nextSessionMetadata, "registrationAttributionEmailAddress", attributionEmailAddress);
  putOptionalBooleanMetadata(
    nextSessionMetadata,
    "registrationPolicyAvoidInCurrentAttempt",
    policyAvoidInCurrentAttempt,
  );
  putOptionalBooleanMetadata(nextSessionMetadata, "registrationPolicyGlobalBlacklist", policyGlobalBlacklist);
  putOptionalNumberMetadata(nextSessionMetadata, "registrationPolicyCooldownSeconds", policyCooldownSeconds);

  const nextSession: MailboxSession = {
    ...session,
    metadata: nextSessionMetadata,
  };
  registry.saveSession(nextSession);

  return {
    session: nextSession,
    instance: registry.findInstanceById(cooledInstance.id) ?? cooledInstance,
    providerTypeKey: cooledInstance.providerTypeKey,
    providerInstanceId: cooledInstance.id,
    healthScore: (registry.findInstanceById(cooledInstance.id) ?? cooledInstance).healthScore,
    selectedDomain,
  };
}
