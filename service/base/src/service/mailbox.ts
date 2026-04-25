import type { MailProviderAdapter } from "../providers/contracts.js";
import { MailboxBindingService } from "../dispatch/index.js";
import { extractAuthenticationLinksFromContent } from "../domain/auth-links.js";
import type {
  AuthenticationLinkResult,
  ObservedMessage,
  MailProviderTypeKey,
  MailboxPlanResult,
  VerificationCodeResult,
  VerificationMailboxOpenResult,
  VerificationMailboxRequest,
} from "../domain/models.js";
import { MailRegistry } from "../domain/registry.js";
import { extractEmailDomain } from "./outcomes.js";

function isTransientMailboxSyncError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("fetch failed")
    || normalized.includes("timeout")
    || normalized.includes("timed out")
    || normalized.includes("econnreset")
    || normalized.includes("socket hang up")
    || normalized.includes("network")
    || normalized.includes("cloudflare temp email listmails failed with status 500")
    || normalized.includes("cloudflare temp email getmail failed with status 500")
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function parseObservedAt(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveSessionNotBeforeAt(session: { createdAt: string; metadata: Record<string, string> }): number | undefined {
  return parseObservedAt(session.metadata.notBeforeAt) ?? parseObservedAt(session.createdAt);
}

function resolveSessionLastCodeObservedAt(session: { metadata: Record<string, string> }): number | undefined {
  return parseObservedAt(session.metadata.lastCodeObservedAt);
}

function normalizeSyncedMessageFreshness(
  session: { createdAt: string; metadata: Record<string, string> },
  synced: ObservedMessage,
): {
  normalized: ObservedMessage;
  accepted: boolean;
} {
  if (!synced.extractedCode) {
    return {
      normalized: synced,
      accepted: false,
    };
  }

  const observedAt = parseObservedAt(synced.observedAt);
  const notBeforeAt = resolveSessionNotBeforeAt(session);
  const lastCodeObservedAt = resolveSessionLastCodeObservedAt(session);
  const lastCodeMessageId = session.metadata.lastCodeMessageId?.trim();
  const isAfterMailboxOpen = notBeforeAt === undefined || (observedAt !== undefined && observedAt >= notBeforeAt);
  const isAfterLastResolvedCode = lastCodeObservedAt === undefined
    || (
      observedAt !== undefined
      && (observedAt > lastCodeObservedAt || (observedAt === lastCodeObservedAt && synced.id !== lastCodeMessageId))
    );

  if (!observedAt || !isAfterMailboxOpen || !isAfterLastResolvedCode) {
    return {
      normalized: {
        ...synced,
        extractedCode: undefined,
        extractedCandidates: undefined,
        codeSource: undefined,
      },
      accepted: false,
    };
  }

  return {
    normalized: synced,
    accepted: true,
  };
}

function enrichObservedMessageArtifacts(message: ObservedMessage): ObservedMessage {
  const actionLinks = Array.isArray(message.actionLinks) && message.actionLinks.length > 0
    ? [...message.actionLinks]
    : extractAuthenticationLinksFromContent({
      sender: message.sender,
      subject: message.subject,
      textBody: message.textBody,
      htmlBody: message.htmlBody,
    });

  return {
    ...message,
    ...(actionLinks.length > 0 ? { actionLinks } : {}),
  };
}

export function resolveMailboxOpenCandidateProviderTypeKeys(plan: MailboxPlanResult): MailProviderTypeKey[] {
  const excludedProviderTypeKeys = new Set(plan.request.excludedProviderTypeKeys ?? []);
  const orderedFromStrategy = plan.strategyMode?.providerGroupOrder.map((groupKey) => groupKey as MailProviderTypeKey) ?? [];
  const ordered = [plan.providerType.key, ...orderedFromStrategy];
  const deduped: MailProviderTypeKey[] = [];
  for (const item of ordered) {
    if (!excludedProviderTypeKeys.has(item) && !deduped.includes(item)) {
      deduped.push(item);
    }
  }
  return deduped;
}

export function shouldFallbackMailboxOpen(
  request: VerificationMailboxRequest,
  plan: MailboxPlanResult,
  attemptedProviderTypeKey: MailProviderTypeKey,
): boolean {
  if (request.providerTypeKey) {
    return false;
  }

  const order = plan.strategyMode?.providerGroupOrder ?? [];
  const index = order.indexOf(attemptedProviderTypeKey as typeof order[number]);
  return index >= 0 && index < order.length - 1;
}

export async function openMailboxWithPlan(input: {
  request: VerificationMailboxRequest;
  plan: MailboxPlanResult;
  now: Date;
  registry: MailRegistry;
  bindings: MailboxBindingService;
  adapterMap: Map<MailProviderTypeKey, MailProviderAdapter>;
}): Promise<VerificationMailboxOpenResult> {
  const { request, plan, now, registry, bindings, adapterMap } = input;
  const selectedProviderTypeKey = plan.providerType.key;
  const adapter = adapterMap.get(selectedProviderTypeKey);

  if (!adapter) {
    throw new Error(`No provider adapter is registered for ${selectedProviderTypeKey}.`);
  }

  const previewResolution = bindings.preview({
    hostId: request.hostId,
    providerTypeKey: selectedProviderTypeKey,
    instance: plan.instance,
    bindingMode: request.bindingMode,
    groupKey: request.groupKey,
    now,
  });

  const boundInstance = registry.findInstanceById(previewResolution.binding.instanceId) ?? plan.instance;
  const credentialSets = registry.resolveCredentialSetsForInstance(boundInstance.id, "generate");
  const session = await Promise.resolve(adapter.createMailboxSession({
    request: {
      ...request,
      providerTypeKey: selectedProviderTypeKey,
    },
    instance: boundInstance,
    credentialSets,
    now,
  }));

  const bindingResolution = bindings.bind({
    hostId: request.hostId,
    providerTypeKey: selectedProviderTypeKey,
    instance: boundInstance,
    bindingMode: request.bindingMode,
    groupKey: request.groupKey,
    now,
  });

  const selectedDomain = extractEmailDomain(session.emailAddress);
  const requestedDomain = request.requestedDomain?.trim().toLowerCase()
    || request.metadata?.requestedDomain?.trim().toLowerCase()
    || request.metadata?.mailcreateDomain?.trim().toLowerCase()
    || undefined;
  const domainSelectionMode = request.requestRandomSubdomain
    ? "random-subdomain"
    : "domain-pool";
  const providerSelections = request.providerGroupSelections?.join(",");
  const eligibleProviderGroups = plan.strategyMode?.eligibleProviderGroups?.join(",");
  const providerGroupOrder = plan.strategyMode?.providerGroupOrder?.join(",");
  const persistedSession = {
    ...session,
    metadata: {
      ...session.metadata,
      ...(selectedDomain ? { selectedDomain } : {}),
      ...(requestedDomain ? { requestedDomain } : {}),
      domainSelectionMode,
      notBeforeAt: session.createdAt,
      ...(request.providerRoutingProfileId ? { providerRoutingProfileId: request.providerRoutingProfileId } : {}),
      ...(request.providerStrategyModeId ? { providerStrategyModeId: request.providerStrategyModeId } : {}),
      ...(request.strategyProfileId ? { strategyProfileId: request.strategyProfileId } : {}),
      ...(providerSelections ? { providerGroupSelections: providerSelections } : {}),
      ...(eligibleProviderGroups ? { eligibleProviderGroups } : {}),
      ...(providerGroupOrder ? { providerGroupOrder } : {}),
    },
  };

  registry.saveSession(persistedSession);

  return {
    session: persistedSession,
    instance: boundInstance,
    binding: bindingResolution.binding,
    runtimePlan: plan.runtimePlan,
    strategyMode: plan.strategyMode,
  };
}

export async function readVerificationCodeFromProvider(input: {
  sessionId: string;
  registry: MailRegistry;
  adapterMap: Map<MailProviderTypeKey, MailProviderAdapter>;
  retryCount?: number;
  retryDelayMs?: number;
}): Promise<VerificationCodeResult | undefined> {
  const { sessionId, registry, adapterMap } = input;
  const session = registry.findSessionById(sessionId);
  if (!session) {
    return undefined;
  }

  const instance = registry.findInstanceById(session.providerInstanceId);
  if (!instance) {
    return undefined;
  }

  const adapter = adapterMap.get(session.providerTypeKey);
  if (!adapter?.syncMailboxCode) {
    return registry.findLatestVerificationCode(sessionId);
  }

  const credentialSets = registry.resolveCredentialSetsForInstance(instance.id, "poll");
  const maxRetries = Math.max(0, input.retryCount ?? (Number.parseInt(process.env.MAIL_CODE_SYNC_RETRIES ?? "2", 10) || 2));
  const retryDelayMs = Math.max(0, input.retryDelayMs ?? (Number.parseInt(process.env.MAIL_CODE_SYNC_RETRY_DELAY_MS ?? "1200", 10) || 1200));

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const synced = await adapter.syncMailboxCode({
        session,
        instance,
        credentialSets,
        now: new Date(),
      });

      if (synced) {
        const freshness = normalizeSyncedMessageFreshness(session, enrichObservedMessageArtifacts(synced));
        registry.saveMessage(freshness.normalized);
        if (freshness.accepted && freshness.normalized.extractedCode) {
          const updatedSession = {
            ...session,
            status: "resolved" as const,
            metadata: {
              ...session.metadata,
              lastCodeObservedAt: freshness.normalized.observedAt,
              lastCodeMessageId: freshness.normalized.id,
            },
          };
          registry.saveSession(updatedSession);
          return {
            sessionId,
            providerInstanceId: freshness.normalized.providerInstanceId,
            code: freshness.normalized.extractedCode,
            source: freshness.normalized.codeSource!,
            observedMessageId: freshness.normalized.id,
            receivedAt: freshness.normalized.observedAt,
            ...(freshness.normalized.extractedCandidates && freshness.normalized.extractedCandidates.length > 0
              ? { candidates: [...freshness.normalized.extractedCandidates] }
              : {}),
          };
        }
      }
    } catch (error) {
      if (!isTransientMailboxSyncError(error)) {
        throw error;
      }
      if (attempt >= maxRetries) {
        return undefined;
      }
      await sleep(retryDelayMs);
    }
  }

  return undefined;
}

export async function readAuthenticationLinkFromProvider(input: {
  sessionId: string;
  registry: MailRegistry;
  adapterMap: Map<MailProviderTypeKey, MailProviderAdapter>;
  retryCount?: number;
  retryDelayMs?: number;
}): Promise<AuthenticationLinkResult | undefined> {
  const { sessionId, registry, adapterMap } = input;
  const session = registry.findSessionById(sessionId);
  if (!session) {
    return undefined;
  }

  const instance = registry.findInstanceById(session.providerInstanceId);
  if (!instance) {
    return undefined;
  }

  const adapter = adapterMap.get(session.providerTypeKey);
  if (!adapter?.syncMailboxCode) {
    return registry.findLatestAuthenticationLink(sessionId);
  }

  const credentialSets = registry.resolveCredentialSetsForInstance(instance.id, "poll");
  const maxRetries = Math.max(0, input.retryCount ?? (Number.parseInt(process.env.MAIL_CODE_SYNC_RETRIES ?? "2", 10) || 2));
  const retryDelayMs = Math.max(0, input.retryDelayMs ?? (Number.parseInt(process.env.MAIL_CODE_SYNC_RETRY_DELAY_MS ?? "1200", 10) || 1200));

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const synced = await adapter.syncMailboxCode({
        session,
        instance,
        credentialSets,
        now: new Date(),
      });

      if (synced) {
        registry.saveMessage(enrichObservedMessageArtifacts(synced));
      }
      return registry.findLatestAuthenticationLink(sessionId);
    } catch (error) {
      if (!isTransientMailboxSyncError(error)) {
        throw error;
      }
      if (attempt >= maxRetries) {
        return registry.findLatestAuthenticationLink(sessionId);
      }
      await sleep(retryDelayMs);
    }
  }

  return registry.findLatestAuthenticationLink(sessionId);
}
