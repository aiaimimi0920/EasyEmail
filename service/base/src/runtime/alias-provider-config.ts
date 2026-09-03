import { readFileSync } from "node:fs";
import {
  createDdgMailAliasProvider,
  type MailAliasProvider,
} from "../alias/index.js";
import type { EasyEmailServiceRuntimeConfig } from "./config.js";

function parseDdgAliasTokens(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }

  return raw
    .split(/[\r\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item.startsWith("#") === false);
}

function loadDdgAliasTokensFromFile(path: string | undefined): string[] {
  if (!path?.trim()) {
    return [];
  }

  try {
    return parseDdgAliasTokens(readFileSync(path, { encoding: "utf-8" }));
  } catch {
    return [];
  }
}

function resolveDdgAliasTokens(provider: EasyEmailServiceRuntimeConfig["aliasEmail"]["providers"][number]): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const token of [
    ...(provider.tokens ?? []),
    ...parseDdgAliasTokens(provider.tokensText),
    ...loadDdgAliasTokensFromFile(provider.tokensFile),
  ]) {
    const normalized = token?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    tokens.push(normalized);
  }

  return tokens;
}

export function createAliasProvidersFromRuntimeConfig(config: EasyEmailServiceRuntimeConfig): MailAliasProvider[] {
  const providers: MailAliasProvider[] = [];

  for (const provider of config.aliasEmail.providers) {
    if (provider.key === "ddg") {
      providers.push(createDdgMailAliasProvider({
        enabled: provider.enabled,
        apiBaseUrl: provider.apiBaseUrl,
        tokens: resolveDdgAliasTokens(provider),
        dailyLimit: provider.dailyLimit,
        cooldownMs: provider.cooldownMs,
        stateFilePath: provider.stateFilePath,
      }));
    }
  }

  return providers;
}
