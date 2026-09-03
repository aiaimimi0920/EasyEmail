import {
  createBasicAuthCredentialSetFromFile,
  createBasicAuthCredentialSetFromLines,
  parseCredentialSetsJson,
  type CredentialSetDefinition,
} from "../../shared/index.js";
import type { ProviderInstance } from "../../domain/models.js";
import { sanitizeAliasSeparator } from "./alias.js";
import type { Mail2925Config } from "./types.js";

function readMetadata(instance: ProviderInstance, key: string): string | undefined {
  const value = instance.metadata[key];
  return value && value.trim() ? value.trim() : undefined;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function createInlineCredentialSet(
  account: string | undefined,
  password: string | undefined,
): CredentialSetDefinition | undefined {
  if (!account?.trim() || !password?.trim()) {
    return undefined;
  }

  return {
    id: "inline-default",
    displayName: "Inline 2925 Credentials",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 100,
    items: [{
      id: "inline-account",
      label: account.trim(),
      username: account.trim(),
      password: password.trim(),
      metadata: {},
    }],
    metadata: {},
  };
}

export function resolveMail2925CredentialSets(instance: ProviderInstance): CredentialSetDefinition[] {
  const configured = parseCredentialSetsJson(readMetadata(instance, "credentialSetsJson"));
  if (configured.length > 0) {
    return configured;
  }

  const inlineSet = createInlineCredentialSet(
    readMetadata(instance, "account") ?? readMetadata(instance, "username"),
    readMetadata(instance, "password"),
  );
  const textSet = createBasicAuthCredentialSetFromLines(readMetadata(instance, "accountsText"), {
    id: "accounts-lines",
    displayName: "2925 Credentials",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 90,
  });
  const fileSet = createBasicAuthCredentialSetFromFile(readMetadata(instance, "accountsFile"), {
    id: "accounts-file",
    displayName: "2925 Credentials File",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 80,
  });

  return [inlineSet, textSet, fileSet]
    .filter((item): item is CredentialSetDefinition => item !== undefined);
}

export function resolveMail2925Config(
  instance: ProviderInstance,
  credentialSets?: CredentialSetDefinition[],
): Mail2925Config {
  return {
    instanceId: instance.id,
    namespace: `mail:mail2925:${instance.id}`,
    apiBase: readMetadata(instance, "apiBase") ?? "https://mail.2925.com",
    credentialSets: credentialSets && credentialSets.length > 0
      ? credentialSets
      : resolveMail2925CredentialSets(instance),
    domain: readMetadata(instance, "domain") ?? "2925.com",
    folderName: readMetadata(instance, "folderName") ?? "Inbox",
    aliasSeparator: sanitizeAliasSeparator(readMetadata(instance, "aliasSeparator")),
    aliasSuffixLength: parseOptionalInteger(readMetadata(instance, "aliasSuffixLength")) ?? 10,
    timeoutSeconds: parseOptionalInteger(readMetadata(instance, "timeoutSeconds")) ?? 20,
    jwtToken: readMetadata(instance, "jwtToken") ?? readMetadata(instance, "webJwtToken"),
    deviceUid: readMetadata(instance, "deviceUid"),
    cookieHeader: readMetadata(instance, "cookieHeader"),
  };
}
