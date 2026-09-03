import {
  createValueCredentialSetFromFile,
  createValueCredentialSetFromLines,
  parseCredentialSetsJson,
} from "../shared/index.js";
import type { EasyEmailService } from "../service/easy-email-service.js";
import type { EasyEmailServiceRuntimeConfig } from "./config.js";
import {
  buildProviderMetadataWithCredentials,
  resolveAndPersistCredentialSets,
} from "./provider-credential-config.js";

export function configureGptMailProviderInstance(
  service: EasyEmailService,
  config: EasyEmailServiceRuntimeConfig,
): void {
  const snapshot = service.getSnapshot();
  const instance = snapshot.instances.find((item) => item.id === "gptmail_shared_default");
  if (!instance) {
    return;
  }

  const configuredSets = parseCredentialSetsJson(config.gptmail.credentialSetsJson);
  const freeTextSet = createValueCredentialSetFromLines(config.gptmail.freeKeysText ?? config.gptmail.keysText, {
    id: "gptmail-free-lines",
    displayName: "GptMail Free Keys",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 190,
  });
  const freeInlineSet = createValueCredentialSetFromLines(config.gptmail.freeApiKey ?? config.gptmail.apiKey, {
    id: "gptmail-free-inline",
    displayName: "Inline GptMail Free Key",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 200,
  });
  const freeFileSet = createValueCredentialSetFromFile(config.gptmail.freeKeysFile ?? config.gptmail.keysFile, {
    id: "gptmail-free-file",
    displayName: "GptMail Free Keys File",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 180,
  });
  const paidTextSet = createValueCredentialSetFromLines(config.gptmail.paidKeysText, {
    id: "gptmail-paid-lines",
    displayName: "GptMail Paid Keys",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 90,
  });
  const paidInlineSet = createValueCredentialSetFromLines(config.gptmail.paidApiKey, {
    id: "gptmail-paid-inline",
    displayName: "Inline GptMail Paid Key",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 100,
  });
  const paidFileSet = createValueCredentialSetFromFile(config.gptmail.paidKeysFile, {
    id: "gptmail-paid-file",
    displayName: "GptMail Paid Keys File",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 80,
  });

  const effectiveSets = configuredSets.length > 0
    ? configuredSets
    : [
        freeInlineSet,
        freeTextSet,
        freeFileSet,
        paidInlineSet,
        paidTextSet,
        paidFileSet,
      ].filter((item) => item !== undefined);

  const { formalSets, now } = resolveAndPersistCredentialSets(service, snapshot, instance, effectiveSets);
  const metadata = buildProviderMetadataWithCredentials(instance, formalSets, {
    ...(config.gptmail.baseUrl ? { baseUrl: config.gptmail.baseUrl } : {}),
    ...(config.gptmail.prefix ? { prefix: config.gptmail.prefix } : {}),
    ...(config.gptmail.domain ? { domain: config.gptmail.domain } : {}),
    ...(config.gptmail.keysFile ? { keysFile: config.gptmail.keysFile } : {}),
    ...(config.gptmail.apiKey ? { apiKey: config.gptmail.apiKey } : {}),
  });

  service.saveProviderInstance({
    ...instance,
    metadata,
    updatedAt: now.toISOString(),
  });
}
