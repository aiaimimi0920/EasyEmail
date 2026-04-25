import { createId } from "../../../shared/index.js";
import { EasyEmailError } from "../../../domain/errors.js";
import type {
  ProviderInstance,
  RuntimeTemplate,
  VerificationMailboxRequest,
} from "../../../domain/models.js";
import { MailRegistry } from "../../../domain/registry.js";

export interface ProvisionCloudflareTempEmailResult {
  instance: ProviderInstance;
  created: boolean;
  template: RuntimeTemplate;
}

interface CloudflareTempEmailProvisionSeed {
  domain?: string;
  deploymentTarget?: string;
  baseUrl?: string;
  customAuth?: string;
  domains?: string;
  domainsJson?: string;
  randomSubdomainDomains?: string;
  randomSubdomainDomainsJson?: string;
}

export class CloudflareTempEmailProvisioner {
  public constructor(private readonly registry: MailRegistry) {}

  public preview(request: VerificationMailboxRequest, now: Date): ProvisionCloudflareTempEmailResult {
    return this.resolveInternal(request, now, false);
  }

  public resolveOrProvision(request: VerificationMailboxRequest, now: Date): ProvisionCloudflareTempEmailResult {
    return this.resolveInternal(request, now, true);
  }

  private resolveInternal(
    request: VerificationMailboxRequest,
    now: Date,
    persist: boolean,
  ): ProvisionCloudflareTempEmailResult {
    const preferredInstance = request.preferredInstanceId
      ? this.registry.findInstanceById(request.preferredInstanceId)
      : undefined;

    if (
      preferredInstance?.providerTypeKey === "cloudflare_temp_email"
      && preferredInstance.status !== "offline"
      && preferredInstance.status !== "cooling"
    ) {
      return {
        instance: preferredInstance,
        created: false,
        template: this.resolveTemplate(request),
      };
    }

    const sharedCandidates = this.registry.listActiveInstancesByType("cloudflare_temp_email").filter((instance) => {
      if (request.groupKey && instance.groupKeys.includes(request.groupKey) === false) {
        return false;
      }

      return request.bindingMode === "dedicated-instance" ? false : instance.shared;
    });
    const reusableSharedCandidates = sharedCandidates
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

    if (request.provisionMode !== "always-create-dedicated" && reusableSharedCandidates.length > 0) {
      return {
        instance: reusableSharedCandidates[0],
        created: false,
        template: this.resolveTemplate(request),
      };
    }

    if (request.provisionMode === "reuse-only") {
      throw new EasyEmailError(
        "CLOUDFLARE_TEMP_EMAIL_INSTANCE_UNAVAILABLE",
        "No reusable cloudflare_temp_email mail instance is available for the requested binding.",
      );
    }

    const template = this.resolveTemplate(request);
    const instance = this.buildProvisionedInstance(request, template, now);

    if (persist) {
      this.registry.saveInstance(instance);
    }

    return {
      instance,
      created: true,
      template,
    };
  }

  private buildProvisionedInstance(
    request: VerificationMailboxRequest,
    template: RuntimeTemplate,
    now: Date,
  ): ProviderInstance {
    const instanceId = createId("mailinst", now);
    const shared = request.bindingMode !== "dedicated-instance" && template.sharedByDefault;
    const createdAt = now.toISOString();
    const seed = this.resolveProvisionSeed();
    const resolvedDomain = this.resolveProvisionValue(
      template.metadata.domain,
      seed.domain,
      `${instanceId}.mail.local`,
    );
    const resolvedDeploymentTarget = this.resolveProvisionValue(
      template.metadata.deploymentTarget,
      seed.deploymentTarget,
      "worker-node",
    );
    const resolvedBaseUrl = this.resolveProvisionValue(template.metadata.baseUrl, seed.baseUrl);
    const resolvedCustomAuth = this.resolveProvisionValue(template.metadata.customAuth, seed.customAuth);
    return {
      id: instanceId,
      providerTypeKey: "cloudflare_temp_email",
      displayName: `${template.displayName} ${instanceId.slice(-4)}`,
      status: "active",
      runtimeKind: "cloudflare_temp_email-runtime",
      connectorKind: "cloudflare_temp_email-connector",
      shared,
      costTier: "paid",
      healthScore: 1,
      averageLatencyMs: 250,
      connectionRef: resolvedBaseUrl || `cloudflare_temp_email://${instanceId}`,
      hostBindings: [],
      groupKeys: request.groupKey ? [request.groupKey] : [],
      metadata: {
        templateId: template.id,
        roleKey: template.roleKey,
        domain: resolvedDomain,
        deploymentTarget: resolvedDeploymentTarget,
        ...(resolvedBaseUrl ? { baseUrl: resolvedBaseUrl } : {}),
        ...(resolvedCustomAuth ? { customAuth: resolvedCustomAuth } : {}),
        ...(seed.domains ? { domains: seed.domains } : {}),
        ...(seed.domainsJson ? { domainsJson: seed.domainsJson } : {}),
        ...(seed.randomSubdomainDomains ? { randomSubdomainDomains: seed.randomSubdomainDomains } : {}),
        ...(seed.randomSubdomainDomainsJson ? { randomSubdomainDomainsJson: seed.randomSubdomainDomainsJson } : {}),
      },
      createdAt,
      updatedAt: createdAt,
    };
  }

  private resolveTemplate(request: VerificationMailboxRequest): RuntimeTemplate {
    if (request.runtimeTemplateId) {
      const matched = this.registry.findRuntimeTemplateById(request.runtimeTemplateId);

      if (matched) {
        return matched;
      }
    }

    const fallback = this.registry.listRuntimeTemplates().find((template) => template.providerTypeKey === "cloudflare_temp_email");

    if (!fallback) {
      throw new EasyEmailError("CLOUDFLARE_TEMP_EMAIL_TEMPLATE_MISSING", "No cloudflare_temp_email runtime template is registered.");
    }

    return fallback;
  }

  private resolveProvisionSeed(): CloudflareTempEmailProvisionSeed {
    const candidates = this.registry.listActiveInstancesByType("cloudflare_temp_email")
      .filter((instance) => {
        const baseUrl = this.normalizeMetadataValue(instance.metadata.baseUrl);
        return baseUrl !== undefined;
      })
      .sort((left, right) => {
        if (left.shared !== right.shared) {
          return left.shared ? -1 : 1;
        }
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

    const seed = candidates[0];
    if (!seed) {
      return {};
    }

    return {
      domain: this.normalizeMetadataValue(seed.metadata.domain),
      deploymentTarget: this.normalizeMetadataValue(seed.metadata.deploymentTarget),
      baseUrl: this.normalizeMetadataValue(seed.metadata.baseUrl),
      customAuth: this.normalizeMetadataValue(seed.metadata.customAuth),
      domains: this.normalizeMetadataValue(seed.metadata.domains),
      domainsJson: this.normalizeMetadataValue(seed.metadata.domainsJson),
      randomSubdomainDomains: this.normalizeMetadataValue(seed.metadata.randomSubdomainDomains),
      randomSubdomainDomainsJson: this.normalizeMetadataValue(seed.metadata.randomSubdomainDomainsJson),
    };
  }

  private resolveProvisionValue(...values: Array<string | undefined>): string | undefined {
    for (const value of values) {
      const normalized = this.normalizeMetadataValue(value);
      if (normalized !== undefined) {
        return normalized;
      }
    }
    return undefined;
  }

  private normalizeMetadataValue(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    if (!normalized) {
      return undefined;
    }
    if (
      normalized === "mail.internal.local"
      || normalized === "mail.dedicated.local"
    ) {
      return undefined;
    }
    return normalized;
  }
}

