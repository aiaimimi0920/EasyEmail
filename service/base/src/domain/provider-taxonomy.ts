export const CLOUDFLARE_TEMP_EMAIL_PROVIDER_KEY = "cloudflare_temp_email" as const;

export type MailProviderTypeKey =
  | "gptmail"
  | "mailtm"
  | "mail2925"
  | "duckmail"
  | "m2u"
  | "moemail"
  | "im215"
  | "guerrillamail"
  | "tempmail-lol"
  | "temporam"
  | "etempmail"
  | typeof CLOUDFLARE_TEMP_EMAIL_PROVIDER_KEY;
export type MailProviderGroupKey = MailProviderTypeKey;
export type MailBusinessStrategyId =
  | "available-first"
  | "gptmail-first"
  | "cloudflare_temp_email-first"
  | "random";
export type MailAliasProviderKey = "ddg" | (string & {});

export type ProviderInstanceStatus = "active" | "cooling" | "provisioning" | "degraded" | "offline";
export type ProviderRuntimeKind = "external" | "cloudflare_temp_email-runtime";
export type CostTier = "free" | "paid";
export type ProvisionMode = "reuse-only" | "auto-create-if-missing" | "always-create-dedicated";
export type BindingMode = "shared-instance" | "dedicated-instance" | "instance-group";
export type StrategyKey = "free-first" | "dynamic-priority" | "random-priority" | "custom-priority";
export type MailboxSessionStatus = "open" | "resolved" | "expired";
export type MessageContentSource = "subject" | "html" | "text";
export type CodeSource = MessageContentSource;
export type ActionLinkSource = MessageContentSource;
export type MailboxRecoverabilityLevel = "unrecoverable" | "key_recoverable" | "recoverable";
export type MailboxRecoverabilityEvidenceStatus = "undetermined" | "verified";

export function isCloudflareTempEmailProviderKey(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === CLOUDFLARE_TEMP_EMAIL_PROVIDER_KEY;
}

export function normalizeMailProviderTypeKey(value: string | undefined): MailProviderTypeKey | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (
    normalized === CLOUDFLARE_TEMP_EMAIL_PROVIDER_KEY
    || normalized === "gptmail"
    || normalized === "mailtm"
    || normalized === "mail2925"
    || normalized === "duckmail"
    || normalized === "m2u"
    || normalized === "moemail"
    || normalized === "im215"
    || normalized === "guerrillamail"
    || normalized === "tempmail-lol"
    || normalized === "temporam"
    || normalized === "etempmail"
  ) {
    return normalized as MailProviderTypeKey;
  }

  return undefined;
}
