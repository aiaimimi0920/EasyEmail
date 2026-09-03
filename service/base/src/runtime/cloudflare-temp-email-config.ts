import type {
  ProviderInstance,
  RegisterCloudflareTempEmailRuntimeRequest,
} from "../domain/models.js";
import type { EasyEmailService } from "../service/easy-email-service.js";
import type { EasyEmailServiceRuntimeConfig } from "./config.js";

export async function configureCloudflareTempEmailProviderInstance(
  service: EasyEmailService,
  config: EasyEmailServiceRuntimeConfig,
): Promise<void> {
  const request = buildCloudflareTempEmailRegistrationRequest(config);
  if (!request) {
    return;
  }

  await service.registerCloudflareTempEmailRuntime(request);
  reconcileCloudflareTempEmailSharedInstances(service, request, new Date());
}

function buildCloudflareTempEmailRegistrationRequest(
  config: EasyEmailServiceRuntimeConfig,
): RegisterCloudflareTempEmailRuntimeRequest | undefined {
  const baseUrl = config.cloudflareTempEmail.baseUrl?.trim();
  if (!baseUrl) {
    return undefined;
  }

  const inferredDomain = (() => {
    try {
      return new URL(baseUrl).hostname || undefined;
    } catch {
      return undefined;
    }
  })();

  return {
    instanceId: config.cloudflareTempEmail.instanceId,
    templateId: config.cloudflareTempEmail.templateId,
    displayName: config.cloudflareTempEmail.displayName,
    baseUrl,
    customAuth: config.cloudflareTempEmail.apiKey,
    adminAuth: config.cloudflareTempEmail.adminAuth,
    domain: config.cloudflareTempEmail.domain?.trim() || config.cloudflareTempEmail.domains?.[0]?.trim() || inferredDomain,
    domains: config.cloudflareTempEmail.domains,
    randomSubdomainDomains: config.cloudflareTempEmail.randomSubdomainDomains,
    deploymentTarget: config.cloudflareTempEmail.deploymentTarget,
    shared: config.cloudflareTempEmail.shared,
    groupKeys: config.cloudflareTempEmail.groupKeys,
    connectionRef: baseUrl,
  };
}

function reconcileCloudflareTempEmailSharedInstances(
  service: EasyEmailService,
  request: RegisterCloudflareTempEmailRuntimeRequest,
  now: Date,
): void {
  const canonical = resolveCanonicalCloudflareTempEmailSharedInstance(service, request);
  if (!canonical) {
    return;
  }

  const timestamp = now.toISOString();
  const normalizedBaseUrl = normalizeCloudflareTempEmailBaseUrl(request.baseUrl);
  const normalizedDomain = normalizeCloudflareTempEmailDomain(request.domain);

  for (const instance of service.listInstances()) {
    if (
      instance.providerTypeKey !== "cloudflare_temp_email"
      || instance.shared !== true
      || instance.id === canonical.id
      || matchesCloudflareTempEmailSharedInstance(instance, normalizedBaseUrl, normalizedDomain) === false
    ) {
      continue;
    }

    if (instance.status === "offline") {
      continue;
    }

    service.saveProviderInstance({
      ...instance,
      status: "offline",
      updatedAt: timestamp,
    });
  }

  for (const binding of service.listBindings()) {
    if (
      binding.providerTypeKey !== "cloudflare_temp_email"
      || binding.bindingMode !== "shared-instance"
      || binding.instanceId === canonical.id
    ) {
      continue;
    }

    service.saveBinding({
      ...binding,
      instanceId: canonical.id,
      updatedAt: timestamp,
    });
  }
}

function resolveCanonicalCloudflareTempEmailSharedInstance(
  service: EasyEmailService,
  request: RegisterCloudflareTempEmailRuntimeRequest,
): ProviderInstance | undefined {
  const requestedInstanceId = request.instanceId?.trim();
  if (requestedInstanceId) {
    const exact = service.findInstanceById(requestedInstanceId);
    if (exact?.providerTypeKey === "cloudflare_temp_email" && exact.shared) {
      return exact;
    }
  }

  const normalizedBaseUrl = normalizeCloudflareTempEmailBaseUrl(request.baseUrl);
  const normalizedDomain = normalizeCloudflareTempEmailDomain(request.domain);
  const candidates = service.listInstances()
    .filter((instance) => (
      instance.providerTypeKey === "cloudflare_temp_email"
      && instance.shared
      && matchesCloudflareTempEmailSharedInstance(instance, normalizedBaseUrl, normalizedDomain)
    ))
    .sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === "active" ? -1 : 1;
      }
      if (right.healthScore !== left.healthScore) {
        return right.healthScore - left.healthScore;
      }
      if (left.averageLatencyMs !== right.averageLatencyMs) {
        return left.averageLatencyMs - right.averageLatencyMs;
      }
      if (right.updatedAt !== left.updatedAt) {
        return right.updatedAt.localeCompare(left.updatedAt);
      }
      return left.id.localeCompare(right.id);
    });

  return candidates[0];
}

function matchesCloudflareTempEmailSharedInstance(
  instance: ProviderInstance,
  normalizedBaseUrl: string | undefined,
  normalizedDomain: string | undefined,
): boolean {
  if (instance.providerTypeKey !== "cloudflare_temp_email" || instance.shared !== true) {
    return false;
  }

  const instanceBaseUrl = normalizeCloudflareTempEmailBaseUrl(instance.metadata.baseUrl);
  const instanceDomain = normalizeCloudflareTempEmailDomain(instance.metadata.domain);

  if (normalizedBaseUrl && instanceBaseUrl === normalizedBaseUrl) {
    return true;
  }

  if (normalizedDomain && instanceDomain === normalizedDomain) {
    return true;
  }

  return false;
}

function normalizeCloudflareTempEmailBaseUrl(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.replace(/\/+$/, "").toLowerCase();
}

function normalizeCloudflareTempEmailDomain(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}
