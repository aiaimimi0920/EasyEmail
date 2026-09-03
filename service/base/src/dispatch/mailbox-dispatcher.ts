import { EasyEmailError } from "../domain/errors.js";
import { normalizeMailProviderTypeKey } from "../domain/models.js";
import type {
  MailProviderTypeKey,
  MailStrategyModeResolution,
  MailboxPlanResult,
  StrategyProfile,
  VerificationMailboxRequest,
} from "../domain/models.js";
import { MailRegistry } from "../domain/registry.js";
import { getMailProviderTypeForGroup, resolveMailStrategyMode } from "../domain/strategy-mode.js";
import { CloudflareTempEmailRuntimeController } from "../providers/cloudflare_temp_email/control/index.js";
import { CloudflareTempEmailProvisioner } from "../providers/cloudflare_temp_email/provisioning/index.js";
import { createProviderRecoverabilityProfile } from "../service/mailbox-access-descriptor.js";
import { synchronizeProviderOperationalState } from "../service/provider-operational-state.js";
import type { DispatchStrategyRegistry } from "../strategies/index.js";
import { MailboxBindingService } from "./binding-service.js";
import { resolveRequestedDomain } from "./mailbox-dispatcher-policy.js";
import { MailboxProviderSelector } from "./mailbox-provider-selector.js";
import type { RoutingProfileLookup } from "./mailbox-provider-selector.js";

export interface MailboxDispatcherDependencies {
  registry: MailRegistry;
  bindings: MailboxBindingService;
  provisioner: CloudflareTempEmailProvisioner;
  runtimeController: CloudflareTempEmailRuntimeController;
  strategyRegistry: DispatchStrategyRegistry;
  defaultStrategyMode?: MailStrategyModeResolution;
  routingProfiles?: RoutingProfileLookup[];
}

export class MailboxDispatcher {
  private readonly registry: MailRegistry;

  private readonly bindings: MailboxBindingService;

  private readonly provisioner: CloudflareTempEmailProvisioner;

  private readonly runtimeController: CloudflareTempEmailRuntimeController;

  private readonly selector: MailboxProviderSelector;
  private readonly defaultStrategyMode?: MailStrategyModeResolution;
  private readonly routingProfiles = new Map<string, RoutingProfileLookup>();

  public constructor(deps: MailboxDispatcherDependencies) {
    this.registry = deps.registry;
    this.bindings = deps.bindings;
    this.provisioner = deps.provisioner;
    this.runtimeController = deps.runtimeController;
    this.selector = new MailboxProviderSelector(deps.registry, deps.strategyRegistry, deps.runtimeController);
    this.defaultStrategyMode = deps.defaultStrategyMode;
    for (const profile of deps.routingProfiles ?? []) {
      const normalizedId = profile.id.trim().toLowerCase();
      if (!normalizedId) {
        continue;
      }
      this.routingProfiles.set(normalizedId, {
        ...profile,
        id: normalizedId,
        providerSelections: profile.providerSelections ? [...profile.providerSelections] : undefined,
        healthGate: profile.healthGate ? { ...profile.healthGate } : undefined,
      });
    }
  }

  public resolveMailboxPlan(
    request: VerificationMailboxRequest,
    now: Date,
    persistProvisioning: boolean,
  ): MailboxPlanResult {
    synchronizeProviderOperationalState(this.registry, now);
    const normalizedRequest: VerificationMailboxRequest = {
      ...request,
      providerTypeKey: normalizeMailProviderTypeKey(request.providerTypeKey),
    };
    const excludedProviderTypeKeys = new Set(
      (normalizedRequest.excludedProviderTypeKeys ?? [])
        .map((item) => normalizeMailProviderTypeKey(item))
        .filter((item): item is MailProviderTypeKey => item !== undefined),
    );
    if (normalizedRequest.providerTypeKey && excludedProviderTypeKeys.has(normalizedRequest.providerTypeKey)) {
      throw new EasyEmailError(
        "PROVIDER_EXCLUDED",
        `Provider ${normalizedRequest.providerTypeKey} was explicitly excluded by the request.`,
      );
    }
    if (
      normalizedRequest.providerTypeKey
      && !this.selector.providerTypeMatchesRecoverabilityFilter(normalizedRequest.providerTypeKey, normalizedRequest, now)
    ) {
      throw new EasyEmailError(
        "PROVIDER_RECOVERABILITY_NOT_ELIGIBLE",
        `Provider ${normalizedRequest.providerTypeKey} does not match the requested recoverability filter.`,
      );
    }
    const requestRandomSubdomain = normalizedRequest.requestRandomSubdomain === true;

    if (!normalizedRequest.providerTypeKey) {
      if (requestRandomSubdomain) {
        return this.resolveMailboxPlanForProvider({
          ...normalizedRequest,
          providerTypeKey: "cloudflare_temp_email",
        }, now, persistProvisioning);
      }
      return this.resolveMailboxPlanByStrategy(normalizedRequest, now, persistProvisioning);
    }

    return this.resolveMailboxPlanForProvider(normalizedRequest as VerificationMailboxRequest & { providerTypeKey: MailProviderTypeKey }, now, persistProvisioning);
  }

  private resolveMailboxPlanForProvider(
    request: VerificationMailboxRequest & { providerTypeKey: MailProviderTypeKey },
    now: Date,
    persistProvisioning: boolean,
    strategyMode?: MailStrategyModeResolution,
  ): MailboxPlanResult {
    if (request.requestRandomSubdomain && request.providerTypeKey !== "cloudflare_temp_email") {
      throw new EasyEmailError(
        "RANDOM_SUBDOMAIN_UNSUPPORTED",
        `Provider ${request.providerTypeKey} does not support random subdomain mailbox creation.`,
      );
    }

    const providerType = this.registry.getProviderType(request.providerTypeKey);

    if (!providerType) {
      throw new EasyEmailError("PROVIDER_TYPE_NOT_FOUND", `Unknown mail provider type: ${request.providerTypeKey}.`);
    }

    const existingBinding =
      request.provisionMode === "always-create-dedicated"
        ? undefined
        : this.bindings.resolve(request.hostId, request.providerTypeKey, request.bindingMode);

    let instance = existingBinding;
    let strategyProfile: StrategyProfile | undefined;
    let requiresProvisioning = false;
    let runtimePlan = existingBinding?.providerTypeKey === "cloudflare_temp_email"
      ? this.selector.createRuntimePlanIfAvailable(existingBinding)
      : undefined;

    if (!instance) {
      if (providerType.key === "cloudflare_temp_email") {
        const provisionResult = persistProvisioning
          ? this.provisioner.resolveOrProvision(request, now)
          : this.provisioner.preview(request, now);

        instance = provisionResult.instance;
        requiresProvisioning = provisionResult.created;
        runtimePlan = this.runtimeController.createRuntimePlan(provisionResult.instance, provisionResult.template);
      } else {
        const externalSelection = this.selector.selectExternalInstance(
          providerType,
          request,
          now,
          strategyMode !== undefined,
        );
        instance = externalSelection.instance;
        strategyProfile = externalSelection.strategyProfile;
      }
    } else if (providerType.key !== "cloudflare_temp_email") {
      strategyProfile = this.selector.resolveStrategyProfile(providerType, request);
    }

    if (!instance) {
      throw new EasyEmailError("PROVIDER_SELECTION_FAILED", `Unable to resolve a provider instance for ${providerType.key}.`);
    }

    const bindingResolution = this.bindings.preview({
      hostId: request.hostId,
      providerTypeKey: request.providerTypeKey,
      instance,
      bindingMode: request.bindingMode,
      groupKey: request.groupKey,
      now,
    });

    return {
      request,
      providerType,
      instance,
      binding: bindingResolution.binding,
      strategyProfile,
      reusedExistingBinding: bindingResolution.reusedExistingBinding,
      requiresProvisioning,
      runtimePlan,
      strategyMode,
      recoverabilityProfile: createProviderRecoverabilityProfile(instance, now),
    };
  }

  private resolveMailboxPlanByStrategy(
    request: VerificationMailboxRequest,
    now: Date,
    persistProvisioning: boolean,
  ): MailboxPlanResult {
    const routingProfile = this.resolveRoutingProfile(request.providerRoutingProfileId);
    const strategyMode = resolveMailStrategyMode({
      modeId: request.providerStrategyModeId
        ?? routingProfile?.providerStrategyModeId
        ?? this.defaultStrategyMode?.modeId,
      providerSelections: request.providerGroupSelections
        ?? routingProfile?.providerSelections
        ?? this.defaultStrategyMode?.providerSelections,
      requestedProfileId: request.strategyProfileId
        ?? routingProfile?.strategyProfileId
        ?? this.defaultStrategyMode?.strategyProfileId,
      strategies: this.registry.listStrategies(),
    });
    const effectiveStrategyMode = this.filterStrategyModeByRequestedDomain(strategyMode, request);
    const preferredProviderType = request.preferredInstanceId
      ? this.registry.findInstanceById(request.preferredInstanceId)?.providerTypeKey
      : undefined;
    const providerTypeOrder = this.selector.buildProviderTypeOrder(
      effectiveStrategyMode,
      request,
      now,
      preferredProviderType,
      routingProfile,
    );
    const runtimeStrategyMode: MailStrategyModeResolution = {
      ...effectiveStrategyMode,
      providerGroupOrder: providerTypeOrder,
      eligibleProviderGroups: effectiveStrategyMode.eligibleProviderGroups.filter((group) => {
        const providerTypeKey = getMailProviderTypeForGroup(group);
        return providerTypeOrder.includes(providerTypeKey);
      }),
    };
    let lastError: EasyEmailError | undefined;

    for (const providerTypeKey of providerTypeOrder) {
      try {
        return this.resolveMailboxPlanForProvider({
          ...request,
          providerTypeKey,
          strategyProfileId: request.strategyProfileId ?? runtimeStrategyMode.strategyProfileId,
        }, now, persistProvisioning, runtimeStrategyMode);
      } catch (error) {
        if (this.isRecoverableStrategyError(error)) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new EasyEmailError(
      "PROVIDER_SELECTION_FAILED",
      `No mail provider route could be resolved for strategy mode "${strategyMode.modeId}".`,
    );
  }

  private filterStrategyModeByRequestedDomain(
    strategyMode: MailStrategyModeResolution,
    request: VerificationMailboxRequest,
  ): MailStrategyModeResolution {
    const requestedDomain = resolveRequestedDomain(request);
    if (!requestedDomain) {
      return strategyMode;
    }

    const compatibleSelections = strategyMode.providerSelections.filter((group) => {
      const providerTypeKey = getMailProviderTypeForGroup(group);
      return this.selector.providerTypeSupportsRequestedDomain(providerTypeKey, request, requestedDomain);
    });
    if (compatibleSelections.length === 0 || compatibleSelections.length === strategyMode.providerSelections.length) {
      return strategyMode;
    }

    const compatibleSet = new Set(compatibleSelections);
    return {
      ...strategyMode,
      providerSelections: compatibleSelections,
      eligibleProviderGroups: strategyMode.eligibleProviderGroups.filter((group) => compatibleSet.has(group)),
      providerGroupOrder: strategyMode.providerGroupOrder.filter((group) => compatibleSet.has(group)),
      explain: [
        ...strategyMode.explain,
        `requestedDomain=${requestedDomain} narrowed provider groups to ${compatibleSelections.join(",")}`,
      ],
    };
  }


  private resolveRoutingProfile(id: string | undefined): RoutingProfileLookup | undefined {
    const normalized = id?.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }

    return this.routingProfiles.get(normalized);
  }

  private isRecoverableStrategyError(error: unknown): error is EasyEmailError {
    return error instanceof EasyEmailError && [
      "PROVIDER_INSTANCE_UNAVAILABLE",
      "CLOUDFLARE_TEMP_EMAIL_INSTANCE_UNAVAILABLE",
      "PROVIDER_SELECTION_FAILED",
    ].includes(error.code);
  }
}
