import {
  createValueCredentialSetFromFile,
  parseCredentialSetsJson,
  type CredentialSetDefinition,
} from "../../shared/index.js";
import type { ProviderInstance } from "../../domain/models.js";
import type { MoemailConfig } from "./types.js";

function readMetadata(instance: ProviderInstance, key: string): string | undefined {
  const value = instance.metadata[key];
  return value && value.trim() ? value.trim() : undefined;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function createInlineCredentialSet(apiKey: string | undefined): CredentialSetDefinition | undefined {
  if (!apiKey?.trim()) {
    return undefined;
  }
  return {
    id: "inline-default",
    displayName: "Inline MoEmail API Key",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 100,
    items: [{ id: "inline-key", label: "Inline Key", value: apiKey.trim(), metadata: {} }],
    metadata: {},
  };
}

export function resolveMoemailCredentialSets(
  instance: ProviderInstance,
): CredentialSetDefinition[] {
  const configured = parseCredentialSetsJson(readMetadata(instance, "credentialSetsJson"));
  if (configured.length > 0) {
    return configured;
  }

  const inlineSet = createInlineCredentialSet(readMetadata(instance, "apiKey"));
  const fileSet = createValueCredentialSetFromFile(readMetadata(instance, "keysFile"), {
    id: "keys-file",
    displayName: "MoEmail Keys File",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 80,
  });

  return [inlineSet, fileSet].filter(
    (item): item is CredentialSetDefinition => item !== undefined,
  );
}

export function resolveMoemailConfig(
  instance: ProviderInstance,
  credentialSets?: CredentialSetDefinition[],
  options: { namespace?: string } = {},
): MoemailConfig {
  return {
    instanceId: instance.id,
    namespace: options.namespace?.trim() || `mail:moemail:${instance.id}`,
    apiBase: readMetadata(instance, "apiBase") ?? "https://moemail.app",
    credentialSets: credentialSets && credentialSets.length > 0
      ? credentialSets
      : resolveMoemailCredentialSets(instance),
    preferredDomain: readMetadata(instance, "domain"),
    expiryTimeMs: parseOptionalInteger(readMetadata(instance, "expiryTimeMs")) ?? 3600000,
    webSessionToken: readMetadata(instance, "webSessionToken"),
    webCsrfToken: readMetadata(instance, "webCsrfToken"),
    webCallbackUrl: readMetadata(instance, "webCallbackUrl"),
    webReferer: readMetadata(instance, "webReferer"),
  };
}
