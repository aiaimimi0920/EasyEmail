import type {
  MailboxSession,
  ObservedMessage,
  ProviderCredentialSet,
  ProviderInstance,
  VerificationMailboxRequest,
} from "../domain/models.js";

export type MaybePromise<T> = T | Promise<T>;

export interface CreateMailboxSessionInput {
  request: VerificationMailboxRequest;
  instance: ProviderInstance;
  credentialSets: ProviderCredentialSet[];
  now: Date;
}

export interface SyncMailboxCodeInput {
  session: MailboxSession;
  instance: ProviderInstance;
  credentialSets: ProviderCredentialSet[];
  now: Date;
}

export interface ProbeProviderInstanceInput {
  instance: ProviderInstance;
  credentialSets: ProviderCredentialSet[];
  now: Date;
}

export interface ReleaseMailboxSessionInput {
  session: MailboxSession;
  instance: ProviderInstance;
  credentialSets: ProviderCredentialSet[];
  now: Date;
  reason?: string;
}

export interface ReleaseMailboxSessionResult {
  released: boolean;
  detail?: string;
}

export type MailboxRecoveryStrategy =
  | "account_restore"
  | "session_restore"
  | "recreate_same_address"
  | "not_supported";

export interface RecoverMailboxSessionInput {
  emailAddress: string;
  hostId?: string;
  instance: ProviderInstance;
  credentialSets: ProviderCredentialSet[];
  now: Date;
  session?: MailboxSession;
}

export interface RecoverMailboxSessionResult {
  strategy: MailboxRecoveryStrategy;
  session: MailboxSession;
  detail?: string;
}

export interface ProviderProbeResult {
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}

export interface MailProviderAdapter {
  readonly typeKey: ProviderInstance["providerTypeKey"];
  createMailboxSession(input: CreateMailboxSessionInput): MaybePromise<MailboxSession>;
  syncMailboxCode?(input: SyncMailboxCodeInput): Promise<ObservedMessage | undefined>;
  releaseMailboxSession?(input: ReleaseMailboxSessionInput): MaybePromise<ReleaseMailboxSessionResult | undefined>;
  recoverMailboxSession?(input: RecoverMailboxSessionInput): MaybePromise<RecoverMailboxSessionResult | undefined>;
  probeInstance(input: ProbeProviderInstanceInput): MaybePromise<ProviderProbeResult>;
}
