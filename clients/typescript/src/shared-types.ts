export type MailProviderTypeKey =
  | "cloudflare_temp_email"
  | "duckmail"
  | "etempmail"
  | "gptmail"
  | "guerrillamail"
  | "im215"
  | "m2u"
  | "mail2925"
  | "mailtm"
  | "moemail"
  | "tempmail-lol"
  | "temporam"
  | (string & {});

export type ProviderInstanceStatus = "active" | "cooling" | "provisioning" | "degraded" | "offline";
export type ProviderRuntimeKind = "external" | "cloudflare_temp_email-runtime" | (string & {});
export type CostTier = "free" | "paid";
export type ProvisionMode = "reuse-only" | "auto-create-if-missing" | "always-create-dedicated";
export type BindingMode = "shared-instance" | "dedicated-instance" | "instance-group";
export type StrategyKey = "free-first" | "dynamic-priority" | "random-priority" | "custom-priority";
export type MailboxSessionStatus = "open" | "resolved" | "expired";
export type MessageContentSource = "subject" | "html" | "text";
export type MailboxRecoverabilityLevel = "unrecoverable" | "key_recoverable" | "recoverable";
export type MailboxRecoverabilityEvidenceStatus = "undetermined" | "verified";
export type MailBusinessStrategyId =
  | "available-first"
  | "gptmail-first"
  | "cloudflare_temp_email-first"
  | "random"
  | (string & {});
