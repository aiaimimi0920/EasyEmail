declare const fetch: (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

import type { ProviderInstance } from "../../../domain/models.js";
import { fetchProviderResource } from "../../http-policy.js";
import { normalizeDomainArray, resolveCloudflareTempEmailConfig } from "./configuration.js";
import { requestJson } from "./http.js";
import { asRecord } from "./mail-content.js";

export async function probeCloudflareTempEmailInstance(instance: ProviderInstance): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  settings?: Record<string, unknown>;
  metadata?: Record<string, string>;
}> {
  const config = resolveCloudflareTempEmailConfig(instance);
  if (!config) {
    return {
      ok: false,
      detail: "Cloudflare Temp Email instance is missing baseUrl/connectionRef.",
      averageLatencyMs: instance.averageLatencyMs,
    };
  }

  const startedAt = Date.now();
  try {
    const healthResponse = await fetchProviderResource(`${config.baseUrl.replace(/\/$/, "")}/health_check`, {
      method: "GET",
      headers: {
        Accept: "text/plain, application/json, */*",
        ...(config.customAuth ? { "x-custom-auth": config.customAuth } : {}),
      },
    });
    if (healthResponse.status !== 200) {
      return {
        ok: false,
        detail: `Cloudflare Temp Email health_check returned ${healthResponse.status}.`,
        averageLatencyMs: Date.now() - startedAt,
      };
    }

    let settings: Record<string, unknown> | undefined;
    let metadata: Record<string, string> | undefined;
    try {
      const settingsResponse = await requestJson(config, "GET", "/open_api/settings");
      if (settingsResponse.status === 200) {
        settings = asRecord(settingsResponse.body);
        const defaultDomains = normalizeDomainArray(settings.defaultDomains);
        const availableDomains = defaultDomains.length > 0
          ? defaultDomains
          : normalizeDomainArray(settings.domains);
        const randomSubdomainDomains = normalizeDomainArray(settings.randomSubdomainDomains);
        metadata = {
          ...(availableDomains.length > 0
              ? {
                domains: availableDomains.join(","),
                domainsJson: JSON.stringify(availableDomains),
                providerDefaultDomains: availableDomains.join(","),
                providerDefaultDomainsJson: JSON.stringify(availableDomains),
              }
            : {}),
          ...(randomSubdomainDomains.length > 0
              ? {
                randomSubdomainDomains: randomSubdomainDomains.join(","),
                randomSubdomainDomainsJson: JSON.stringify(randomSubdomainDomains),
                providerRandomSubdomainDomains: randomSubdomainDomains.join(","),
                providerRandomSubdomainDomainsJson: JSON.stringify(randomSubdomainDomains),
              }
            : {}),
        };
        if (Object.keys(metadata).length === 0) {
          metadata = undefined;
        }
      }
    } catch {
      settings = undefined;
      metadata = undefined;
    }

    return {
      ok: true,
      detail: "Cloudflare Temp Email runtime responded successfully.",
      averageLatencyMs: Date.now() - startedAt,
      settings,
      metadata,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      averageLatencyMs: Date.now() - startedAt,
    };
  }
}
