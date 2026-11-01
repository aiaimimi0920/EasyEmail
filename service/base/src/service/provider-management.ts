import { clamp, createId, type CredentialSetDefinition } from "../shared/index.js";
import { EasyEmailError } from "../domain/errors.js";
import { parseCloudflareSendTransport } from "../domain/cloudflare-send-policy.js";
import { normalizeMailProviderTypeKey } from "../domain/models.js";
import type { MailRegistry } from "../domain/registry.js";
import type { MailProviderAdapter } from "../providers/contracts.js";
import type {
  EasyEmailCatalog,
  HostBinding,
  MailProviderTypeKey,
  MailRoutingProfileDescriptor,
  MailStrategyModeResolution,
  ProviderCredentialBinding,
  ProviderCredentialSet,
  ProviderHealthProbeResult,
  ProviderInstance,
  ProviderTypeDefinition,
  RegisterCloudflareTempEmailRuntimeRequest,
  RegisterCloudflareTempEmailRuntimeResult,
  RuntimeTemplate,
  StrategyProfile,
} from "../domain/models.js";
import { CloudflareTempEmailRuntimeController } from "../providers/cloudflare_temp_email/control/index.js";
import { CloudflareTempEmailProvisioner } from "../providers/cloudflare_temp_email/provisioning/index.js";
import { createProviderRecoverabilityProfile } from "./mailbox-access-descriptor.js";
import { applyCredentialSetsToRegistry } from "./credentials.js";
import {
  MAIL_BUSINESS_STRATEGIES,
  MAIL_PROVIDER_GROUPS,
} from "../domain/strategy-mode.js";

const PROVIDER_PROBE_BATCH_SIZE = 3;

function isActiveProbeDisabled(instance: ProviderInstance): boolean {
  return instance.metadata.allowActiveProbe?.trim().toLowerCase() === "false";
}

export class EasyEmailProviderManagement {
  public constructor(
    private readonly registry: MailRegistry,
    private readonly adapterMap: Map<MailProviderTypeKey, MailProviderAdapter>,
    private readonly provisioner: CloudflareTempEmailProvisioner,
    private readonly runtimeController: CloudflareTempEmailRuntimeController,
    private readonly strictProviderMode: boolean,
    private readonly defaultStrategyMode: MailStrategyModeResolution | undefined,
    private readonly routingProfiles: MailRoutingProfileDescriptor[],
    private readonly syncOperationalState: (now?: Date) => void,
  ) {}

  public getCatalog(): EasyEmailCatalog {
    this.syncOperationalState();
    const now = new Date();
    return {
      providerTypes: this.registry.listProviderTypes(),
      runtimeTemplates: this.registry.listRuntimeTemplates(),
      strategyProfiles: this.registry.listStrategies(),
      providerRecoverabilityProfiles: this.registry
        .listInstances()
        .map((instance) => createProviderRecoverabilityProfile(instance, now)),
      providerGroups: MAIL_PROVIDER_GROUPS,
      businessStrategies: MAIL_BUSINESS_STRATEGIES,
      routingProfiles: this.routingProfiles.map((item) => ({
        ...item,
        providerSelections: item.providerSelections ? [...item.providerSelections] : undefined,
        healthGate: item.healthGate ? { ...item.healthGate } : undefined,
      })),
      defaultStrategyModeId: this.defaultStrategyMode?.modeId,
      defaultStrategyMode: this.defaultStrategyMode,
      supportsStrategyMode: true,
    };
  }

  public saveProviderType(providerType: ProviderTypeDefinition): void {
    this.registry.saveProviderType({
      ...providerType,
      key: normalizeMailProviderTypeKey(providerType.key) ?? providerType.key,
    });
  }

  public saveProviderInstance(instance: ProviderInstance): void {
    this.registry.saveInstance({
      ...instance,
      providerTypeKey: normalizeMailProviderTypeKey(instance.providerTypeKey) ?? instance.providerTypeKey,
    });
  }

  public saveStrategyProfile(profile: StrategyProfile): void {
    this.registry.saveStrategy(profile);
  }

  public saveRuntimeTemplate(template: RuntimeTemplate): void {
    this.registry.saveRuntimeTemplate(template);
  }

  public saveCredentialSet(credentialSet: ProviderCredentialSet): void {
    this.registry.saveCredentialSet(credentialSet);
  }

  public saveCredentialBinding(binding: ProviderCredentialBinding): void {
    this.registry.saveCredentialBinding(binding);
  }

  public saveBinding(binding: HostBinding): void {
    this.registry.saveBinding(binding);
  }

  public replaceCredentialBindingsForInstance(
    providerInstanceId: string,
    bindings: ProviderCredentialBinding[],
  ): void {
    this.registry.deleteCredentialBindingsForInstance(providerInstanceId);
    for (const binding of bindings) {
      this.registry.saveCredentialBinding(binding);
    }
  }

  public applyCredentialSets(
    providerInstanceId: string,
    credentialSets: CredentialSetDefinition[],
    now: Date = new Date(),
  ): {
    instance: ProviderInstance;
    credentialSets: ProviderCredentialSet[];
    credentialBindings: ProviderCredentialBinding[];
  } {
    const instance = this.registry.findInstanceById(providerInstanceId);
    if (!instance) {
      throw new EasyEmailError("PROVIDER_INSTANCE_NOT_FOUND", `Unknown provider instance: ${providerInstanceId}.`);
    }

    return applyCredentialSetsToRegistry(this.registry, instance, credentialSets, now);
  }

  public async registerCloudflareTempEmailRuntime(
    request: RegisterCloudflareTempEmailRuntimeRequest,
    now: Date = new Date(),
  ): Promise<RegisterCloudflareTempEmailRuntimeResult> {
    const sendTransport = parseCloudflareSendTransport(request.sendTransport);
    const template = this.resolveCloudflareTempEmailTemplate(request.templateId);
    const requestedInstanceId = request.instanceId?.trim() || undefined;
    const existing = requestedInstanceId ? this.registry.findInstanceById(requestedInstanceId) : undefined;
    const instanceId = existing?.id ?? requestedInstanceId ?? createId("mailinst", now);
    const created = existing === undefined;
    const createdAt = existing?.createdAt || now.toISOString();

    const instance: ProviderInstance = {
      id: instanceId,
      providerTypeKey: "cloudflare_temp_email",
      displayName: request.displayName?.trim() || existing?.displayName || `${template.displayName} ${instanceId.slice(-4)}`,
      status: existing?.status ?? "active",
      runtimeKind: "cloudflare_temp_email-runtime",
      connectorKind: request.connectorKind?.trim() || existing?.connectorKind || "cloudflare_temp_email-connector",
      shared: request.shared ?? existing?.shared ?? template.sharedByDefault,
      costTier: existing?.costTier ?? "paid",
      healthScore: existing?.healthScore ?? 1,
      averageLatencyMs: existing?.averageLatencyMs ?? 250,
      connectionRef: request.connectionRef?.trim() || request.baseUrl.trim(),
      hostBindings: existing?.hostBindings ? [...existing.hostBindings] : [],
      groupKeys: request.groupKeys ? [...request.groupKeys] : (existing?.groupKeys ? [...existing.groupKeys] : []),
      metadata: {
        ...(existing?.metadata ?? {}),
        templateId: template.id,
        roleKey: template.roleKey,
        domain: request.domain?.trim() || existing?.metadata.domain || template.metadata.domain || "cloudflare-temp-email.local",
        deploymentTarget: request.deploymentTarget?.trim()
          || existing?.metadata.deploymentTarget
          || template.metadata.deploymentTarget
          || "worker-node",
        baseUrl: request.baseUrl.trim(),
        strictMode: String(this.strictProviderMode),
        ...(sendTransport !== undefined ? { sendTransport } : {}),
        ...(request.customAuth !== undefined
          ? { customAuth: request.customAuth.trim() }
          : (existing?.metadata.customAuth ? { customAuth: existing.metadata.customAuth } : {})),
        ...(request.adminAuth !== undefined
          ? { adminAuth: request.adminAuth.trim() }
          : (existing?.metadata.adminAuth ? { adminAuth: existing.metadata.adminAuth } : {})),
        ...(request.domains && request.domains.length > 0
          ? {
              domains: request.domains
                .map((item) => item.trim().toLowerCase())
                .filter(Boolean)
                .join(","),
              domainsJson: JSON.stringify(
                request.domains
                  .map((item) => item.trim().toLowerCase())
                  .filter(Boolean),
              ),
            }
          : {}),
        ...(request.randomSubdomainDomains && request.randomSubdomainDomains.length > 0
          ? {
              randomSubdomainDomains: request.randomSubdomainDomains
                .map((item) => item.trim().toLowerCase())
                .filter(Boolean)
                .join(","),
              randomSubdomainDomainsJson: JSON.stringify(
                request.randomSubdomainDomains
                  .map((item) => item.trim().toLowerCase())
                  .filter(Boolean),
              ),
            }
          : {}),
      },
      createdAt,
      updatedAt: now.toISOString(),
    };

    this.registry.saveInstance(instance);
    const health = await this.probeProviderInstance(instance.id, now);
    const savedInstance = this.registry.findInstanceById(instance.id) ?? instance;
    const runtimePlan = this.runtimeController.createRuntimePlan(savedInstance, template);

    return {
      instance: savedInstance,
      health,
      runtimePlan,
      created,
    };
  }

  public async probeProviderInstance(
    instanceId: string,
    now: Date = new Date(),
  ): Promise<ProviderHealthProbeResult> {
    this.syncOperationalState(now);
    const instance = this.registry.findInstanceById(instanceId);
    if (!instance) {
      throw new EasyEmailError("PROVIDER_INSTANCE_NOT_FOUND", `Unknown provider instance: ${instanceId}.`);
    }

    const probe = await this.executeProviderProbe(instance);
    const nextHealthScore = probe.ok
      ? clamp(Math.max(instance.healthScore, 0.85), 0.1, 1)
      : clamp(Math.min(instance.healthScore, 0.25), 0.1, 1);
    const nextStatus = probe.ok ? "active" : "degraded";
    const metadata = { ...instance.metadata, ...(probe.metadata ?? {}) };
    if (probe.ok) delete metadata.errorClass;

    const nextInstance: ProviderInstance = {
      ...instance,
      status: nextStatus,
      healthScore: nextHealthScore,
      averageLatencyMs: probe.averageLatencyMs,
      updatedAt: now.toISOString(),
      metadata,
    };
    this.registry.saveInstance(nextInstance);
    this.syncOperationalState(now);
    const effectiveInstance = this.registry.findInstanceById(instanceId) ?? nextInstance;

    return {
      instanceId: effectiveInstance.id,
      providerTypeKey: effectiveInstance.providerTypeKey,
      ok: probe.ok,
      status: effectiveInstance.status,
      healthScore: effectiveInstance.healthScore,
      averageLatencyMs: effectiveInstance.averageLatencyMs,
      checkedAt: now.toISOString(),
      detail: probe.detail,
    };
  }

  public async probeAllProviderInstances(now: Date = new Date()): Promise<ProviderHealthProbeResult[]> {
    this.syncOperationalState(now);
    const instances = this.registry.listInstances().filter((instance) => !isActiveProbeDisabled(instance));
    const settled: PromiseSettledResult<ProviderHealthProbeResult>[] = [];
    for (let index = 0; index < instances.length; index += PROVIDER_PROBE_BATCH_SIZE) {
      const batch = instances.slice(index, index + PROVIDER_PROBE_BATCH_SIZE);
      settled.push(...await Promise.allSettled(
        batch.map((instance) => this.probeProviderInstance(instance.id, now)),
      ));
    }

    return settled.map((outcome, index) => {
      if (outcome.status === "fulfilled") {
        return outcome.value;
      }
      const instance = instances[index]!;
      const error = outcome.reason;
      return {
        instanceId: instance.id,
        providerTypeKey: instance.providerTypeKey,
        ok: false,
        status: "degraded" as const,
        healthScore: clamp(Math.min(instance.healthScore, 0.25), 0.1, 1),
        averageLatencyMs: instance.averageLatencyMs,
        checkedAt: now.toISOString(),
        detail: error instanceof Error ? error.message : String(error),
      };
    });
  }

  private resolveCloudflareTempEmailTemplate(templateId?: string): RuntimeTemplate {
    if (templateId) {
      const matched = this.registry.findRuntimeTemplateById(templateId);
      if (matched?.providerTypeKey === "cloudflare_temp_email") {
        return matched;
      }
    }

    const fallback = this.registry.listRuntimeTemplates().find(
      (template) => template.providerTypeKey === "cloudflare_temp_email",
    );
    if (!fallback) {
      throw new EasyEmailError(
        "CLOUDFLARE_TEMP_EMAIL_TEMPLATE_MISSING",
        "No Cloudflare Temp Email runtime template is registered.",
      );
    }

    return fallback;
  }

  private async executeProviderProbe(instance: ProviderInstance): Promise<{
    ok: boolean;
    detail: string;
    averageLatencyMs: number;
    metadata?: Record<string, string>;
  }> {
    const adapter = this.adapterMap.get(instance.providerTypeKey);
    if (adapter) {
      const credentialSets = this.registry.resolveCredentialSetsForInstance(instance.id, "poll");
      return await adapter.probeInstance({
        instance,
        credentialSets,
        now: new Date(),
      });
    }

    return {
      ok: false,
      detail: `No probe is available for ${instance.providerTypeKey}.`,
      averageLatencyMs: instance.averageLatencyMs,
    };
  }
}
