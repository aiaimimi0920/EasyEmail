import {
  MAIL_PROVIDER_TYPES,
  createDefaultProviderInstances,
} from "../defaults/index.js";
import type { ProviderInstance } from "../domain/models.js";
import type { EasyEmailService } from "../service/easy-email-service.js";
import type { EasyEmailServiceRuntimeConfig } from "./config.js";

export function ensureDefaultProviderCatalog(service: EasyEmailService, now: Date): void {
  for (const providerType of MAIL_PROVIDER_TYPES) {
    if (!service.getProviderType(providerType.key)) {
      service.saveProviderType(providerType);
    }
  }

  for (const instance of createDefaultProviderInstances(now)) {
    if (!service.findInstanceById(instance.id)) {
      service.saveProviderInstance(instance);
    }
  }
}

export function configureDefaultStrategyProfile(
  service: EasyEmailService,
  config: EasyEmailServiceRuntimeConfig,
): void {
  const strategyProfileId = config.defaultStrategyProfileId?.trim();
  if (!strategyProfileId) {
    return;
  }

  const snapshot = service.getSnapshot();
  const strategyProfile = snapshot.strategies.find((item) => item.id === strategyProfileId);
  if (!strategyProfile) {
    console.warn(`[easy_email] Default strategy profile not found: ${strategyProfileId}`);
    return;
  }

  for (const providerType of snapshot.providerTypes) {
    if (providerType.defaultStrategyKey === strategyProfile.key) {
      continue;
    }
    service.saveProviderType({
      ...providerType,
      defaultStrategyKey: strategyProfile.key,
    });
  }
}

export function configureProviderAvailability(
  service: EasyEmailService,
  config: EasyEmailServiceRuntimeConfig,
): void {
  const enabled = config.enabledProviders;
  if (!enabled || enabled.length === 0) {
    return;
  }

  const enabledSet = new Set(enabled);
  for (const instance of service.listInstances()) {
    if (instance.runtimeKind !== "external") {
      continue;
    }

    const nextStatus = enabledSet.has(instance.providerTypeKey) ? "active" : "offline";
    if (nextStatus === instance.status) {
      continue;
    }

    service.saveProviderInstance({
      ...instance,
      status: nextStatus,
      updatedAt: new Date().toISOString(),
    });
  }
}

export function isExternalProviderEnabled(
  config: EasyEmailServiceRuntimeConfig,
  providerTypeKey: ProviderInstance["providerTypeKey"],
): boolean {
  const enabled = config.enabledProviders;
  if (!enabled || enabled.length === 0) {
    return true;
  }

  return enabled.includes(providerTypeKey);
}
