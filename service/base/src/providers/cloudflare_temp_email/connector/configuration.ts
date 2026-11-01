import type { ProviderInstance } from "../../../domain/models.js";
import { parseCloudflareSendTransport } from "../../../domain/cloudflare-send-policy.js";
import type { CloudflareTempEmailConfig } from "./models.js";

function readMetadata(instance: ProviderInstance, key: string): string | undefined {
  const value = instance.metadata[key];
  return value && value.trim() ? value.trim() : undefined;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeDomainArray(input: unknown): string[] {
  const domains = new Set<string>();
  if (!Array.isArray(input)) {
    return [];
  }

  for (const item of input) {
    const domain = typeof item === "string" ? item.trim().toLowerCase() : "";
    if (domain) {
      domains.add(domain);
    }
  }

  return [...domains];
}

function parseDomainListFromMetadata(
  instance: ProviderInstance,
  options: {
    jsonKey: string;
    listKey: string;
    singularKey?: string;
  },
): string[] {
  const domains = new Set<string>();
  const rawDomainsJson = readMetadata(instance, options.jsonKey);
  if (rawDomainsJson) {
    try {
      for (const item of normalizeDomainArray(JSON.parse(rawDomainsJson) as unknown)) {
        domains.add(item);
      }
    } catch {
      // Ignore malformed stored domain metadata and fall back to list/singular values.
    }
  }

  const rawList = readMetadata(instance, options.listKey);
  if (rawList) {
    for (const item of rawList.split(/[,\r\n;]+/)) {
      const domain = item.trim().toLowerCase();
      if (domain) {
        domains.add(domain);
      }
    }
  }

  const singular = options.singularKey ? readMetadata(instance, options.singularKey) : undefined;
  if (singular?.trim()) {
    domains.add(singular.trim().toLowerCase());
  }

  return [...domains];
}

function parseDomainList(instance: ProviderInstance): string[] {
  const providerDefaults = parseDomainListFromMetadata(instance, {
    jsonKey: "providerDefaultDomainsJson",
    listKey: "providerDefaultDomains",
  });
  if (providerDefaults.length > 0) {
    return providerDefaults;
  }

  return parseDomainListFromMetadata(instance, {
    jsonKey: "domainsJson",
    listKey: "domains",
    singularKey: "domain",
  });
}

function parseRandomSubdomainDomainList(instance: ProviderInstance): string[] {
  const providerDomains = parseDomainListFromMetadata(instance, {
    jsonKey: "providerRandomSubdomainDomainsJson",
    listKey: "providerRandomSubdomainDomains",
  });
  if (providerDomains.length > 0) {
    return providerDomains;
  }

  return parseDomainListFromMetadata(instance, {
    jsonKey: "randomSubdomainDomainsJson",
    listKey: "randomSubdomainDomains",
  });
}

export function parseDomainWeights(instance: ProviderInstance): Record<string, number> {
  const raw = readMetadata(instance, "registrationStatsJson");
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const domains = parsed.domains;
    if (!domains || typeof domains !== "object" || Array.isArray(domains)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(domains as Record<string, unknown>).map(([key, value]) => {
        const record = value && typeof value === "object" && Array.isArray(value) === false
          ? value as Record<string, unknown>
          : {};
        const successCount = Math.max(0, Number.parseInt(String(record.successCount ?? "0"), 10) || 0);
        const failureCount = Math.max(0, Number.parseInt(String(record.failureCount ?? "0"), 10) || 0);
        const weight = (successCount + 1) / (successCount + failureCount + 2);
        return [key.trim().toLowerCase(), weight];
      }),
    );
  } catch {
    return {};
  }
}

function pickWeightedDomain(domains: string[], weights: Record<string, number>): string | undefined {
  if (domains.length === 0) {
    return undefined;
  }

  const normalized = domains.map((domain) => ({
    domain,
    weight: Math.max(0.05, weights[domain] ?? 0.5),
  }));
  const totalWeight = normalized.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    return normalized[0]?.domain;
  }

  let cursor = Math.random() * totalWeight;
  for (const item of normalized) {
    cursor -= item.weight;
    if (cursor <= 0) {
      return item.domain;
    }
  }

  return normalized[normalized.length - 1]?.domain;
}

function resolveDomainFamilyKey(domain: string): string {
  const labels = domain.split(".").filter(Boolean);
  if (labels.length >= 4) {
    return labels.slice(1).join(".");
  }
  return domain;
}

export function pickWeightedDomainFamily(domains: string[], weights: Record<string, number>): string | undefined {
  if (domains.length === 0) {
    return undefined;
  }

  const families = new Map<string, string[]>();
  for (const domain of domains) {
    const familyKey = resolveDomainFamilyKey(domain);
    const familyDomains = families.get(familyKey) ?? [];
    familyDomains.push(domain);
    families.set(familyKey, familyDomains);
  }

  if (families.size <= 1) {
    return pickWeightedDomain(domains, weights);
  }

  const familyEntries = [...families.entries()].map(([familyKey, familyDomains]) => {
    const averageWeight = familyDomains.reduce((sum, item) => sum + Math.max(0.05, weights[item] ?? 0.5), 0) / familyDomains.length;
    return {
      familyKey,
      domains: familyDomains,
      weight: Math.max(0.05, averageWeight),
    };
  });
  const totalWeight = familyEntries.reduce((sum, item) => sum + item.weight, 0);
  if (!(totalWeight > 0)) {
    return pickWeightedDomain(domains, weights);
  }

  let cursor = Math.random() * totalWeight;
  let selectedFamily = familyEntries[familyEntries.length - 1];
  for (const familyEntry of familyEntries) {
    cursor -= familyEntry.weight;
    if (cursor <= 0) {
      selectedFamily = familyEntry;
      break;
    }
  }

  return pickWeightedDomain(selectedFamily?.domains ?? domains, weights);
}

export function resolveCloudflareTempEmailConfig(instance: ProviderInstance): CloudflareTempEmailConfig | undefined {
  const metadataBaseUrl = readMetadata(instance, "baseUrl");
  const connectionBaseUrl = instance.connectionRef.startsWith("http://") || instance.connectionRef.startsWith("https://")
    ? instance.connectionRef
    : undefined;
  const baseUrl = metadataBaseUrl ?? connectionBaseUrl;
  if (!baseUrl) {
    return undefined;
  }

  return {
    baseUrl,
    customAuth: readMetadata(instance, "customAuth"),
    adminAuth: readMetadata(instance, "adminAuth"),
    sendTransport: parseCloudflareSendTransport(instance.metadata.sendTransport),
    domain: readMetadata(instance, "domain"),
    domains: parseDomainList(instance),
    randomSubdomainDomains: parseRandomSubdomainDomainList(instance),
    timeoutSeconds: parseOptionalInteger(readMetadata(instance, "timeoutSeconds")) ?? 30,
  };
}
