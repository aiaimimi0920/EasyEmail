import {
  createValueCredentialSetFromFile,
  parseCredentialSetsJson,
  type CredentialSetDefinition,
} from "../../shared/index.js";
import type { ProviderInstance } from "../../domain/models.js";
import { parseOptionalInteger, readMetadata } from "./protocol-values.js";

export interface Im215Config {
  instanceId: string;
  namespace: string;
  apiBase: string;
  credentialSets: CredentialSetDefinition[];
  preferredDomain?: string;
  autoDomainStrategy?: string;
  timeoutSeconds: number;
}

export function createInlineCredentialSet(apiKey: string | undefined): CredentialSetDefinition | undefined {
  if (!apiKey?.trim()) {
    return undefined;
  }
  return {
    id: "inline-default",
    displayName: "Inline 215.im API Key",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 100,
    items: [{ id: "inline-key", label: "Inline Key", value: apiKey.trim(), metadata: {} }],
    metadata: {},
  };
}

export function resolveIm215CredentialSets(instance: ProviderInstance): CredentialSetDefinition[] {
  const configured = parseCredentialSetsJson(readMetadata(instance, "credentialSetsJson"));
  if (configured.length > 0) {
    return configured;
  }

  const inlineSet = createInlineCredentialSet(readMetadata(instance, "apiKey"));
  const fileSet = createValueCredentialSetFromFile(readMetadata(instance, "keysFile"), {
    id: "keys-file",
    displayName: "215.im Keys File",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 80,
  });

  return [inlineSet, fileSet].filter((item): item is CredentialSetDefinition => item !== undefined);
}

export function resolveIm215Config(
  instance: ProviderInstance,
  credentialSets?: CredentialSetDefinition[],
): Im215Config {
  return {
    instanceId: instance.id,
    namespace: `mail:im215:${instance.id}`,
    apiBase: readMetadata(instance, "apiBase") ?? "https://maliapi.215.im/v1",
    credentialSets: credentialSets && credentialSets.length > 0
      ? credentialSets
      : resolveIm215CredentialSets(instance),
    preferredDomain: readMetadata(instance, "domain"),
    autoDomainStrategy: readMetadata(instance, "autoDomainStrategy"),
    timeoutSeconds: parseOptionalInteger(readMetadata(instance, "timeoutSeconds")) ?? 20,
  };
}
