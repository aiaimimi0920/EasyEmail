import type {
  MailBusinessStrategyDescriptor,
  MailBusinessStrategyId,
  MailProviderGroupDescriptor,
  MailProviderGroupKey,
  MailRoutingProfileDescriptor,
  MailProviderTypeKey,
  MailStrategyModeResolution,
  StrategyKey,
  StrategyProfile,
} from "./models.js";

export const MAIL_PROVIDER_GROUPS: MailProviderGroupDescriptor[] = [
  {
    key: "cloudflare_temp_email",
    displayName: "Cloudflare Temp Email",
    providerTypeKeys: ["cloudflare_temp_email"],
    description: "Node-managed Cloudflare temporary mailbox runtimes and connectors.",
  },
  {
    key: "mailtm",
    displayName: "Mail.tm",
    providerTypeKeys: ["mailtm"],
    description: "Mail.tm external inbox provider.",
  },
  {
    key: "m2u",
    displayName: "MailToYou",
    providerTypeKeys: ["m2u"],
    description: "MailToYou public temporary mailbox provider.",
  },
  {
    key: "mail2925",
    displayName: "2925 Mail",
    providerTypeKeys: ["mail2925"],
    description: "2925 Mail alias inbox provider backed by a reusable main account.",
  },
  {
    key: "moemail",
    displayName: "MoEmail",
    providerTypeKeys: ["moemail"],
    description: "MoEmail API-key temporary inbox provider.",
  },
  {
    key: "im215",
    displayName: "215.im",
    providerTypeKeys: ["im215"],
    description: "215.im / YYDS Mail API-key temporary inbox provider.",
  },
  {
    key: "duckmail",
    displayName: "DuckMail",
    providerTypeKeys: ["duckmail"],
    description: "DuckMail external inbox provider.",
  },
  {
    key: "guerrillamail",
    displayName: "GuerrillaMail",
    providerTypeKeys: ["guerrillamail"],
    description: "GuerrillaMail official anonymous temporary inbox provider.",
  },
  {
    key: "tempmail-lol",
    displayName: "Tempmail.lol",
    providerTypeKeys: ["tempmail-lol"],
    description: "Tempmail.lol external inbox provider.",
  },
  {
    key: "etempmail",
    displayName: "eTempMail",
    providerTypeKeys: ["etempmail"],
    description: "eTempMail cookie-backed temporary inbox provider.",
  },
  {
    key: "gptmail",
    displayName: "GPT Mail",
    providerTypeKeys: ["gptmail"],
    description: "GPT Mail external inbox provider.",
  },
];

const MAIL_PROVIDER_GROUP_SET = new Set<MailProviderGroupKey>(MAIL_PROVIDER_GROUPS.map((item) => item.key));
const MAIL_DEFAULT_PROVIDER_SELECTIONS = MAIL_PROVIDER_GROUPS.map((item) => item.key);

export const MAIL_ROUTING_PROFILES: MailRoutingProfileDescriptor[] = [
  {
    id: "default",
    displayName: "Default",
    description: "Use the service default provider strategy without additional routing restrictions.",
  },
  {
    id: "high-availability",
    displayName: "High Availability",
    description: "Prefer the currently most reliable providers for critical mailbox delivery workflows.",
    providerStrategyModeId: "available-first",
    providerSelections: ["m2u", "moemail", "etempmail"],
    healthGate: {
      minimumHealthScore: 0.6,
      maxConsecutiveFailures: 2,
      recentFailureWindowMs: 2 * 60 * 60 * 1000,
      recentFailurePenalty: 0.12,
    },
  },
  {
    id: "broad-coverage",
    displayName: "Broad Coverage",
    description: "Allow all currently supported provider groups and let the default strategy choose among them.",
    providerStrategyModeId: "available-first",
    providerSelections: [...MAIL_DEFAULT_PROVIDER_SELECTIONS],
  },
] as const;

function cloneMailRoutingProfile(profile: MailRoutingProfileDescriptor): MailRoutingProfileDescriptor {
  return {
    ...profile,
    providerSelections: profile.providerSelections ? [...profile.providerSelections] : undefined,
    healthGate: profile.healthGate ? { ...profile.healthGate } : undefined,
  };
}

const MAIL_FALLBACK_PROFILE_BY_MODE: Record<MailBusinessStrategyId, string> = {
  "available-first": "strategy_dynamic_priority",
  "gptmail-first": "strategy_dynamic_priority",
  "cloudflare_temp_email-first": "strategy_dynamic_priority",
  random: "strategy_random_priority",
};

const MAIL_FALLBACK_STRATEGY_KEY_BY_MODE: Record<MailBusinessStrategyId, StrategyKey> = {
  "available-first": "dynamic-priority",
  "gptmail-first": "dynamic-priority",
  "cloudflare_temp_email-first": "dynamic-priority",
  random: "random-priority",
};

export const MAIL_BUSINESS_STRATEGIES: MailBusinessStrategyDescriptor[] = [
  {
    id: "available-first",
    displayName: "Available First",
    description: "Dynamically choose among eligible mail providers using health, recent failures, cooldown, and latency.",
    fallbackProfileId: MAIL_FALLBACK_PROFILE_BY_MODE["available-first"],
    fallbackStrategyKey: MAIL_FALLBACK_STRATEGY_KEY_BY_MODE["available-first"],
  },
  {
    id: "gptmail-first",
    displayName: "GPT Mail First",
    description: "Prefer GPT Mail first, then free providers, then Cloudflare Temp Email.",
    providerGroupOrder: ["gptmail", "mailtm", "m2u", "mail2925", "guerrillamail", "moemail", "im215", "duckmail", "tempmail-lol", "etempmail", "cloudflare_temp_email"],
    fallbackProfileId: MAIL_FALLBACK_PROFILE_BY_MODE["gptmail-first"],
    fallbackStrategyKey: MAIL_FALLBACK_STRATEGY_KEY_BY_MODE["gptmail-first"],
  },
  {
    id: "cloudflare_temp_email-first",
    displayName: "Cloudflare Temp Email First",
    description: "Prefer Cloudflare Temp Email first, then free providers, then GPT Mail.",
    providerGroupOrder: ["cloudflare_temp_email", "mailtm", "m2u", "mail2925", "guerrillamail", "moemail", "im215", "duckmail", "tempmail-lol", "etempmail", "gptmail"],
    fallbackProfileId: MAIL_FALLBACK_PROFILE_BY_MODE["cloudflare_temp_email-first"],
    fallbackStrategyKey: MAIL_FALLBACK_STRATEGY_KEY_BY_MODE["cloudflare_temp_email-first"],
  },
  {
    id: "random",
    displayName: "Random",
    description: "Ignore weights and randomly choose among the enabled provider groups.",
    fallbackProfileId: MAIL_FALLBACK_PROFILE_BY_MODE.random,
    fallbackStrategyKey: MAIL_FALLBACK_STRATEGY_KEY_BY_MODE.random,
  },
];

const MAIL_STRATEGY_MAP = new Map<MailBusinessStrategyId, MailBusinessStrategyDescriptor>(
  MAIL_BUSINESS_STRATEGIES.map((item) => [item.id, item]),
);

export interface ResolveMailStrategyModeInput {
  modeId?: string;
  providerSelections?: string[];
  requestedProfileId?: string;
  strategies?: StrategyProfile[];
}

export function normalizeMailProviderGroupKey(value: string | undefined): MailProviderGroupKey | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (MAIL_PROVIDER_GROUP_SET.has(normalized as MailProviderGroupKey)) {
    return normalized as MailProviderGroupKey;
  }

  return undefined;
}

export function normalizeMailBusinessStrategyId(value: string | undefined): MailBusinessStrategyId | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (MAIL_STRATEGY_MAP.has(normalized as MailBusinessStrategyId)) {
    return normalized as MailBusinessStrategyId;
  }

  return undefined;
}

export function resolveMailRoutingProfile(value: string | undefined): MailRoutingProfileDescriptor | undefined {
  return resolveMailRoutingProfileFromProfiles(value, MAIL_ROUTING_PROFILES);
}

export function resolveMailRoutingProfileFromProfiles(
  value: string | undefined,
  profiles: MailRoutingProfileDescriptor[] = MAIL_ROUTING_PROFILES,
): MailRoutingProfileDescriptor | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return profiles.find((item) => item.id === normalized);
}

export function mergeMailRoutingProfiles(
  customProfiles: MailRoutingProfileDescriptor[] | undefined,
): MailRoutingProfileDescriptor[] {
  if (!customProfiles || customProfiles.length === 0) {
    return MAIL_ROUTING_PROFILES.map((profile) => cloneMailRoutingProfile(profile));
  }

  const merged = new Map<string, MailRoutingProfileDescriptor>(
    MAIL_ROUTING_PROFILES.map((profile) => [profile.id, cloneMailRoutingProfile(profile)]),
  );
  for (const profile of customProfiles) {
    if (!profile.id?.trim()) {
      continue;
    }
    merged.set(profile.id.trim().toLowerCase(), cloneMailRoutingProfile({
      ...profile,
      id: profile.id.trim().toLowerCase(),
    }));
  }
  return [...merged.values()];
}

export function parseMailStrategyModeJson(
  raw: string | undefined,
  strategies?: StrategyProfile[],
): MailStrategyModeResolution | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as {
      modeId?: string;
      providerSelections?: string[];
      strategyProfileId?: string;
    };
    return resolveMailStrategyMode({
      modeId: parsed.modeId,
      providerSelections: parsed.providerSelections,
      requestedProfileId: parsed.strategyProfileId,
      strategies,
    });
  } catch {
    return undefined;
  }
}

export function resolveMailStrategyMode(input: ResolveMailStrategyModeInput = {}): MailStrategyModeResolution {
  const warnings: string[] = [];
  const explain: string[] = [];
  const selections = uniqueMailProviderGroups(input.providerSelections ?? []);
  const eligibleProviderGroups = selections.length > 0 ? selections : [...MAIL_DEFAULT_PROVIDER_SELECTIONS];

  if (selections.length === 0) {
    explain.push("No explicit mail provider selections were supplied; using all provider groups.");
  }

  const normalizedModeId = normalizeMailBusinessStrategyId(input.modeId);
  const modeId = normalizedModeId ?? "available-first";
  if (input.modeId && !normalizedModeId) {
    warnings.push(`Unknown mail strategy mode "${input.modeId}" was ignored; falling back to "available-first".`);
  }

  const strategy = MAIL_STRATEGY_MAP.get(modeId)!;
  const providerGroupOrder = orderMailProviderGroups(modeId, eligibleProviderGroups);
  const availableProfiles = input.strategies;
  const requestedProfile = input.requestedProfileId?.trim() || undefined;
  const matchedProfile = requestedProfile
    ? availableProfiles?.find((item) => item.id === requestedProfile)
    : undefined;
  const strategyProfileId = matchedProfile?.id ?? requestedProfile ?? strategy.fallbackProfileId;
  const strategyKey = matchedProfile?.key ?? strategy.fallbackStrategyKey;

  if (requestedProfile && !matchedProfile && availableProfiles && availableProfiles.length > 0) {
    warnings.push(`Mail strategy profile "${requestedProfile}" was not found; continuing with fallback semantics.`);
  }

  explain.push(`Mode "${modeId}" applies only when the caller does not pin providerTypeKey or a mailbox domain.`);
  explain.push(`Eligible provider groups: ${eligibleProviderGroups.join(", ")}.`);
  explain.push(`Eligible provider groups are filtered first; runtime availability scoring decides the actual route.`);
  explain.push(`Provider group order fallback: ${providerGroupOrder.join(" -> ")}.`);
  if (modeId === "available-first") {
    explain.push("Available-first is dynamic-dominant and reorders eligible providers at runtime using provider success-weight, cooldown, latency, and health.");
  }
  if (modeId === "random") {
    explain.push("Random mode shuffles eligible providers for each mailbox allocation.");
  }
  if (strategyProfileId) {
    explain.push(`Fallback instance profile: ${strategyProfileId}${strategyKey ? ` (${strategyKey})` : ""}.`);
  }

  return {
    service: "mail",
    modeId,
    providerSelections: eligibleProviderGroups,
    eligibleProviderGroups,
    providerGroupOrder,
    strategyProfileId,
    strategyKey,
    warnings,
    explain,
  };
}

export function getMailProviderTypeForGroup(groupKey: MailProviderGroupKey): MailProviderTypeKey {
  return groupKey;
}

function orderMailProviderGroups(
  modeId: MailBusinessStrategyId,
  eligibleProviderGroups: MailProviderGroupKey[],
): MailProviderGroupKey[] {
  const preferredOrder = MAIL_STRATEGY_MAP.get(modeId)?.providerGroupOrder;
  if (!preferredOrder || preferredOrder.length === 0) {
    return [...eligibleProviderGroups];
  }

  const preferred = preferredOrder.filter((item) => eligibleProviderGroups.includes(item));
  const remainder = eligibleProviderGroups.filter((item) => !preferred.includes(item));
  return [...preferred, ...remainder];
}

function uniqueMailProviderGroups(values: string[]): MailProviderGroupKey[] {
  const next: MailProviderGroupKey[] = [];
  for (const value of values) {
    const normalized = normalizeMailProviderGroupKey(value);
    if (normalized && !next.includes(normalized)) {
      next.push(normalized);
    }
  }
  return next;
}
