import type {
  MailboxSessionStatus,
  MailProviderTypeKey,
  ProviderInstanceStatus,
} from "./models.js";

export interface ProviderInstanceQueryFilters {
  providerTypeKey?: MailProviderTypeKey;
  status?: ProviderInstanceStatus;
  shared?: boolean;
  groupKey?: string;
  limit?: number;
}

export interface HostBindingQueryFilters {
  hostId?: string;
  providerTypeKey?: MailProviderTypeKey;
  instanceId?: string;
  limit?: number;
}

export interface MailboxSessionQueryFilters {
  hostId?: string;
  providerTypeKey?: MailProviderTypeKey;
  providerInstanceId?: string;
  status?: MailboxSessionStatus;
  limit?: number;
  newestFirst?: boolean;
}

export interface ObservedMessageQueryFilters {
  sessionId?: string;
  providerInstanceId?: string;
  extractedCodeOnly?: boolean;
  sync?: boolean;
  limit?: number;
  newestFirst?: boolean;
}

export interface MailPersistenceStats {
  providerInstanceCount: number;
  hostBindingCount: number;
  credentialSetCount: number;
  credentialBindingCount: number;
  mailboxSessionCount: number;
  observedMessageCount: number;
  resolvedSessionCount: number;
  extractedCodeMessageCount: number;
}
