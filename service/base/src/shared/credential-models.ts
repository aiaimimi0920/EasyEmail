export type CredentialUseCase = "generate" | "poll" | "checkout";

export type CredentialSelectionStrategy = "first-active" | "round-robin" | "sticky-per-host";
export type CredentialCooldownMode = "duration" | "until-reset-window";
export const CRITICAL_CREDENTIAL_FAILURE_THRESHOLD = 3;

export type CredentialItemStatus =
  | "active"
  | "cooling"
  | "rate-limited"
  | "exhausted"
  | "invalid"
  | "disabled";

export interface CredentialItemDefinition {
  id: string;
  label: string;
  value?: string;
  username?: string;
  password?: string;
  usernameTemplate?: string;
  passwordTemplate?: string;
  priority?: number;
  weight?: number;
  status?: CredentialItemStatus;
  cooldownUntil?: string;
  metadata?: Record<string, string>;
}

export interface CredentialSetDefinition {
  id: string;
  displayName: string;
  useCases: CredentialUseCase[];
  strategy?: CredentialSelectionStrategy;
  priority?: number;
  items: CredentialItemDefinition[];
  metadata?: Record<string, string>;
}

export interface CredentialSelection {
  set: CredentialSetDefinition;
  item: CredentialItemDefinition;
}

export interface CredentialSummary {
  setCount: number;
  itemCount: number;
  activeCount: number;
  coolingCount: number;
  rateLimitedCount: number;
  exhaustedCount: number;
  invalidCount: number;
  disabledCount: number;
  labels: string[];
}

export interface CredentialAvailabilitySummary {
  configuredCount: number;
  availableCount: number;
  coolingCount: number;
  rateLimitedCount: number;
  exhaustedCount: number;
  invalidCount: number;
  disabledCount: number;
  resetWindowCoolingCount: number;
  timedCoolingCount: number;
}

