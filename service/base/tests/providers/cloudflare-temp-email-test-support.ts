import type { ProviderInstance } from "../../src/domain/models.js";

export function createCloudflareInstance(): ProviderInstance {
  return {
    id: "cloudflare_temp_email_shared_default",
    providerTypeKey: "cloudflare_temp_email",
    displayName: "Cloudflare Temp Email",
    status: "active",
    runtimeKind: "cloudflare_temp_email-runtime",
    connectorKind: "cloudflare_temp_email-connector",
    shared: true,
    costTier: "paid",
    healthScore: 1,
    averageLatencyMs: 0,
    connectionRef: "https://temp.example.test",
    hostBindings: [],
    groupKeys: [],
    metadata: {
      baseUrl: "https://temp.example.test",
    },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}
