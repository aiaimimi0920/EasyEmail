import type {
  CredentialItemDefinition,
  CredentialItemStatus,
  CredentialSelectionStrategy,
  CredentialSetDefinition,
  CredentialUseCase,
} from "./credential-models.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function toStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      output[key] = item;
    }
  }
  return output;
}

function normalizeUseCases(value: unknown): CredentialUseCase[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const output: CredentialUseCase[] = [];
  for (const item of value) {
    if (item === "generate" || item === "poll" || item === "checkout") {
      output.push(item);
    }
  }
  return output;
}

function normalizeStrategy(value: unknown): CredentialSelectionStrategy | undefined {
  if (
    value === "first-active"
    || value === "round-robin"
    || value === "sticky-per-host"
  ) {
    return value;
  }
  return undefined;
}

function normalizeStatus(value: unknown): CredentialItemStatus | undefined {
  if (
    value === "active"
    || value === "cooling"
    || value === "rate-limited"
    || value === "exhausted"
    || value === "invalid"
    || value === "disabled"
  ) {
    return value;
  }
  return undefined;
}

function toInteger(value: unknown, fallback: number | undefined = undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function toCredentialItem(rawItem: unknown, index: number): CredentialItemDefinition | undefined {
  if (!isRecord(rawItem)) {
    return undefined;
  }

  const itemId = typeof rawItem.id === "string" && rawItem.id.trim()
    ? rawItem.id.trim()
    : `item-${index + 1}`;
  const label = typeof rawItem.label === "string" && rawItem.label.trim()
    ? rawItem.label.trim()
    : itemId;

  return {
    id: itemId,
    label,
    value: typeof rawItem.value === "string" && rawItem.value.trim() ? rawItem.value.trim() : undefined,
    username: typeof rawItem.username === "string" && rawItem.username.trim() ? rawItem.username.trim() : undefined,
    password: typeof rawItem.password === "string" && rawItem.password.trim() ? rawItem.password.trim() : undefined,
    usernameTemplate: typeof rawItem.usernameTemplate === "string" && rawItem.usernameTemplate.trim()
      ? rawItem.usernameTemplate.trim()
      : undefined,
    passwordTemplate: typeof rawItem.passwordTemplate === "string" && rawItem.passwordTemplate.trim()
      ? rawItem.passwordTemplate.trim()
      : undefined,
    priority: toInteger(rawItem.priority),
    weight: toInteger(rawItem.weight),
    status: normalizeStatus(rawItem.status),
    cooldownUntil: typeof rawItem.cooldownUntil === "string" && rawItem.cooldownUntil.trim()
      ? rawItem.cooldownUntil.trim()
      : undefined,
    metadata: toStringMap(rawItem.metadata),
  };
}

export function parseCredentialSetsJson(raw: string | undefined): CredentialSetDefinition[] {
  if (!raw?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const source = Array.isArray(parsed) ? parsed : [parsed];
    const sets: CredentialSetDefinition[] = [];

    for (const rawSet of source) {
      if (!isRecord(rawSet)) {
        continue;
      }

      const itemsSource = Array.isArray(rawSet.items) ? rawSet.items : [];
      const items: CredentialItemDefinition[] = itemsSource
        .map((rawItem, index) => toCredentialItem(rawItem, index))
        .filter(isDefined);

      if (items.length === 0) {
        continue;
      }

      const setId = typeof rawSet.id === "string" && rawSet.id.trim()
        ? rawSet.id.trim()
        : `set-${sets.length + 1}`;
      const useCases = normalizeUseCases(rawSet.useCases);

      sets.push({
        id: setId,
        displayName: typeof rawSet.displayName === "string" && rawSet.displayName.trim()
          ? rawSet.displayName.trim()
          : setId,
        useCases: useCases.length > 0 ? useCases : ["generate", "poll", "checkout"],
        strategy: normalizeStrategy(rawSet.strategy) ?? "round-robin",
        priority: toInteger(rawSet.priority, 0),
        items,
        metadata: toStringMap(rawSet.metadata),
      });
    }

    return sets;
  } catch {
    return [];
  }
}
