import { normalizeMailProviderTypeKey } from "../domain/models.js";
import {
  normalizeMailBusinessStrategyId,
  resolveMailRoutingProfileFromProfiles,
} from "../domain/strategy-mode.js";
import type {
  MailboxRecoverabilityLevel,
  MailProviderTypeKey,
  MailRoutingProfileDescriptor,
  VerificationMailboxRequest,
} from "../domain/models.js";

function parseStringList(value: string | undefined): string[] {
  const raw = value?.trim();
  if (!raw) {
    return [];
  }
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
      }
    } catch {
      // Fall back to comma-separated parsing below.
    }
  }
  return raw
    .replace(/[;\r\n|]/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeDomainValue(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized.includes("@")) {
    return undefined;
  }
  return normalized;
}

function normalizeEmailAddressValue(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return undefined;
  }
  const [localPart, domain, ...rest] = normalized.split("@");
  if (!localPart || !domain || rest.length > 0) {
    return undefined;
  }
  return `${localPart}@${domain}`;
}

function normalizeExcludedDomains(
  values: string[] | undefined,
  metadata: Record<string, string> | undefined,
  avoidDomains: string[] | undefined = undefined,
): string[] {
  const normalized: string[] = [];
  for (const item of [
    ...(values ?? []),
    ...(avoidDomains ?? []),
    ...parseStringList(metadata?.excludedDomains),
    ...parseStringList(metadata?.excludedDomain),
  ]) {
    const domain = normalizeDomainValue(item);
    if (domain && !normalized.includes(domain)) {
      normalized.push(domain);
    }
  }
  return normalized;
}

function normalizeExcludedEmailAddresses(
  values: string[] | undefined,
  metadata: Record<string, string> | undefined,
  avoidEmailAddresses: string[] | undefined = undefined,
): string[] {
  const normalized: string[] = [];
  for (const item of [
    ...(values ?? []),
    ...(avoidEmailAddresses ?? []),
    ...parseStringList(metadata?.excludedEmailAddresses),
    ...parseStringList(metadata?.excludedEmails),
    ...parseStringList(metadata?.excludedEmail),
  ]) {
    const emailAddress = normalizeEmailAddressValue(item);
    if (emailAddress && !normalized.includes(emailAddress)) {
      normalized.push(emailAddress);
    }
  }
  return normalized;
}

function normalizeExcludedProviderTypeKeys(
  values: MailProviderTypeKey[] | undefined,
  avoidProviderTypeKeys: MailProviderTypeKey[] | undefined,
): MailProviderTypeKey[] | undefined {
  const normalized: MailProviderTypeKey[] = [];
  for (const item of [
    ...(values ?? []),
    ...(avoidProviderTypeKeys ?? []),
  ]) {
    const providerTypeKey = normalizeMailProviderTypeKey(item);
    if (providerTypeKey && !normalized.includes(providerTypeKey)) {
      normalized.push(providerTypeKey);
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeRecoverabilityLevels(
  values: MailboxRecoverabilityLevel[] | undefined,
): MailboxRecoverabilityLevel[] | undefined {
  const normalized: MailboxRecoverabilityLevel[] = [];
  for (const value of values ?? []) {
    const item = String(value ?? "").trim().toLowerCase();
    if (
      (item === "unrecoverable" || item === "key_recoverable" || item === "recoverable")
      && !normalized.includes(item)
    ) {
      normalized.push(item);
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeMailboxRequest(
  request: VerificationMailboxRequest,
  routingProfiles: MailRoutingProfileDescriptor[],
): VerificationMailboxRequest {
  const routingProfile = !request.providerTypeKey
    ? resolveMailRoutingProfileFromProfiles(request.providerRoutingProfileId, routingProfiles)
    : undefined;
  const requestedDomain = request.requestedDomain?.trim().toLowerCase()
    || request.metadata?.requestedDomain?.trim().toLowerCase()
    || request.metadata?.mailcreateDomain?.trim().toLowerCase()
    || undefined;
  const requestedLocalPart = request.requestedLocalPart?.trim()
    || request.metadata?.requestedLocalPart?.trim()
    || request.metadata?.customLocalPart?.trim()
    || request.metadata?.mailcreateLocalPart?.trim()
    || request.metadata?.localPart?.trim()
    || request.metadata?.prefix?.trim()
    || undefined;
  const turnstileToken = request.turnstileToken?.trim()
    || request.metadata?.turnstileToken?.trim()
    || request.metadata?.cfTurnstileResponse?.trim()
    || request.metadata?.["cf-turnstile-response"]?.trim()
    || request.metadata?.turnstileResponse?.trim()
    || undefined;
  const excludedDomains = normalizeExcludedDomains(
    request.excludedDomains,
    request.metadata,
    request.avoid?.domains,
  );
  const excludedEmailAddresses = normalizeExcludedEmailAddresses(
    request.excludedEmailAddresses,
    request.metadata,
    request.avoid?.emailAddresses,
  );
  const excludedProviderTypeKeys = normalizeExcludedProviderTypeKeys(
    request.excludedProviderTypeKeys,
    request.avoid?.providerTypeKeys,
  );
  const avoidReason = request.avoid?.reason?.trim();
  const avoidScope = request.avoid?.scope === "attempt" ? "attempt" : undefined;
  const metadata: Record<string, string> = {
    ...(request.metadata ?? {}),
  };

  if (requestedDomain) {
    metadata.requestedDomain = requestedDomain;
  } else {
    delete metadata.requestedDomain;
  }

  if (request.requestRandomSubdomain === true) {
    metadata.requestRandomSubdomain = "true";
  } else {
    delete metadata.requestRandomSubdomain;
  }

  if (excludedDomains.length > 0) {
    metadata.excludedDomains = excludedDomains.join(",");
  } else {
    delete metadata.excludedDomains;
  }

  if (excludedEmailAddresses.length > 0) {
    metadata.excludedEmailAddresses = excludedEmailAddresses.join(",");
  } else {
    delete metadata.excludedEmailAddresses;
  }

  if (avoidReason) {
    metadata.avoidReason = avoidReason;
  } else {
    delete metadata.avoidReason;
  }

  if (avoidScope) {
    metadata.avoidScope = avoidScope;
  } else {
    delete metadata.avoidScope;
  }

  if (requestedLocalPart) {
    metadata.requestedLocalPart = requestedLocalPart;
  } else {
    delete metadata.requestedLocalPart;
  }

  delete metadata.turnstileToken;
  delete metadata.turnstileResponse;
  delete metadata.cfTurnstileResponse;
  delete metadata["cf-turnstile-response"];
  delete metadata.customLocalPart;
  delete metadata.mailcreateLocalPart;
  delete metadata.localPart;
  delete metadata.prefix;
  delete metadata.excludedDomain;
  delete metadata.excludedEmails;
  delete metadata.excludedEmail;

  return {
    ...request,
    providerRoutingProfileId: routingProfile?.id ?? request.providerRoutingProfileId?.trim() ?? undefined,
    requestedDomain,
    requestedLocalPart,
    turnstileToken,
    requestRandomSubdomain: request.requestRandomSubdomain === true,
    providerTypeKey: normalizeMailProviderTypeKey(request.providerTypeKey),
    providerStrategyModeId: normalizeMailBusinessStrategyId(
      request.providerStrategyModeId ?? routingProfile?.providerStrategyModeId,
    ),
    excludedProviderTypeKeys,
    excludedDomains,
    excludedEmailAddresses,
    providerGroupSelections: (request.providerGroupSelections ?? routingProfile?.providerSelections)
      ?.map((item) => normalizeMailProviderTypeKey(item))
      .filter((item): item is MailProviderTypeKey => item !== undefined),
    strategyProfileId: request.strategyProfileId ?? routingProfile?.strategyProfileId,
    recoverabilityLevels: normalizeRecoverabilityLevels(request.recoverabilityLevels),
    includeUndeterminedRecoverability: request.includeUndeterminedRecoverability === true,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}
