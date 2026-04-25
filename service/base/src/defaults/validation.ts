import { EasyEmailError } from "../domain/errors.js";
import type {
  ProviderInstance,
  ProviderTypeDefinition,
  RuntimeTemplate,
  StrategyProfile,
} from "../domain/models.js";
import { normalizeMailProviderTypeKey } from "../domain/models.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new EasyEmailError("MAIL_DATA_INVALID", `${label} must be an object.`);
  }

  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new EasyEmailError("MAIL_DATA_INVALID", `${label} must be a string.`);
  }

  return value;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new EasyEmailError("MAIL_DATA_INVALID", `${label} must be a boolean.`);
  }

  return value;
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new EasyEmailError("MAIL_DATA_INVALID", `${label} must be a number.`);
  }

  return value;
}

function expectStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new EasyEmailError("MAIL_DATA_INVALID", `${label} must be a string array.`);
  }

  return [...value];
}

function expectStringMap(value: unknown, label: string): Record<string, string> {
  const record = expectRecord(value, label);
  const output: Record<string, string> = {};

  for (const [key, item] of Object.entries(record)) {
    output[key] = expectString(item, `${label}.${key}`);
  }

  return output;
}

export function toProviderTypeDefinition(value: unknown, label: string): ProviderTypeDefinition {
  const record = expectRecord(value, label);
  const providerTypeKey = normalizeMailProviderTypeKey(expectString(record.key, `${label}.key`));
  if (!providerTypeKey) {
    throw new EasyEmailError("MAIL_DATA_INVALID", `${label}.key is not a supported provider type.`);
  }

  return {
    key: providerTypeKey,
    displayName: expectString(record.displayName, `${label}.displayName`),
    description: expectString(record.description, `${label}.description`),
    supportsDynamicProvisioning: expectBoolean(record.supportsDynamicProvisioning, `${label}.supportsDynamicProvisioning`),
    defaultStrategyKey: expectString(record.defaultStrategyKey, `${label}.defaultStrategyKey`) as ProviderTypeDefinition["defaultStrategyKey"],
    tags: expectStringArray(record.tags, `${label}.tags`),
  };
}

export function toStrategyProfile(value: unknown, label: string): StrategyProfile {
  const record = expectRecord(value, label);

  return {
    id: expectString(record.id, `${label}.id`),
    key: expectString(record.key, `${label}.key`) as StrategyProfile["key"],
    displayName: expectString(record.displayName, `${label}.displayName`),
    description: expectString(record.description, `${label}.description`),
    preferredInstanceIds: record.preferredInstanceIds === undefined
      ? undefined
      : expectStringArray(record.preferredInstanceIds, `${label}.preferredInstanceIds`),
    metadata: expectStringMap(record.metadata ?? {}, `${label}.metadata`),
  };
}

export function toRuntimeTemplate(value: unknown, label: string): RuntimeTemplate {
  const record = expectRecord(value, label);
  const providerTypeKey = normalizeMailProviderTypeKey(expectString(record.providerTypeKey, `${label}.providerTypeKey`));
  if (providerTypeKey !== "cloudflare_temp_email") {
    throw new EasyEmailError("MAIL_DATA_INVALID", `${label}.providerTypeKey must resolve to cloudflare_temp_email.`);
  }

  return {
    id: expectString(record.id, `${label}.id`),
    providerTypeKey,
    displayName: expectString(record.displayName, `${label}.displayName`),
    description: expectString(record.description, `${label}.description`),
    roleKey: expectString(record.roleKey, `${label}.roleKey`),
    sharedByDefault: expectBoolean(record.sharedByDefault, `${label}.sharedByDefault`),
    metadata: expectStringMap(record.metadata ?? {}, `${label}.metadata`),
  };
}

export function toProviderInstance(value: unknown, label: string): ProviderInstance {
  const record = expectRecord(value, label);
  const providerTypeKey = normalizeMailProviderTypeKey(expectString(record.providerTypeKey, `${label}.providerTypeKey`));
  if (!providerTypeKey) {
    throw new EasyEmailError("MAIL_DATA_INVALID", `${label}.providerTypeKey is not a supported provider type.`);
  }

  return {
    id: expectString(record.id, `${label}.id`),
    providerTypeKey,
    displayName: expectString(record.displayName, `${label}.displayName`),
    status: expectString(record.status, `${label}.status`) as ProviderInstance["status"],
    runtimeKind: expectString(record.runtimeKind, `${label}.runtimeKind`) as ProviderInstance["runtimeKind"],
    connectorKind: expectString(record.connectorKind, `${label}.connectorKind`),
    shared: expectBoolean(record.shared, `${label}.shared`),
    costTier: expectString(record.costTier, `${label}.costTier`) as ProviderInstance["costTier"],
    healthScore: expectNumber(record.healthScore, `${label}.healthScore`),
    averageLatencyMs: expectNumber(record.averageLatencyMs, `${label}.averageLatencyMs`),
    connectionRef: expectString(record.connectionRef, `${label}.connectionRef`),
    hostBindings: expectStringArray(record.hostBindings ?? [], `${label}.hostBindings`),
    groupKeys: expectStringArray(record.groupKeys ?? [], `${label}.groupKeys`),
    metadata: expectStringMap(record.metadata ?? {}, `${label}.metadata`),
    createdAt: expectString(record.createdAt ?? "", `${label}.createdAt`),
    updatedAt: expectString(record.updatedAt ?? "", `${label}.updatedAt`),
  };
}
