import type {
  HostBinding,
  HostBindingQueryFilters,
  MailPersistenceStats,
  EasyEmailSnapshot,
  MailboxSession,
  MailboxSessionQueryFilters,
  ObservedMessage,
  ObservedMessageQueryFilters,
  ProviderInstance,
  ProviderInstanceQueryFilters,
} from "../domain/models.js";

function applyLimit<T>(items: T[], limit?: number): T[] {
  if (limit === undefined || Number.isFinite(limit) === false || limit < 0) {
    return items;
  }

  return items.slice(0, limit);
}

function sortAscending(left: string, right: string): number {
  return left.localeCompare(right);
}

function sortDescending(left: string, right: string): number {
  return right.localeCompare(left);
}

export function queryProviderInstancesFromSnapshot(
  snapshot: EasyEmailSnapshot,
  filters: ProviderInstanceQueryFilters = {},
): ProviderInstance[] {
  let items = snapshot.instances.filter((instance) => {
    if (filters.providerTypeKey && instance.providerTypeKey !== filters.providerTypeKey) {
      return false;
    }
    if (filters.status && instance.status !== filters.status) {
      return false;
    }
    if (filters.shared !== undefined && instance.shared !== filters.shared) {
      return false;
    }
    if (filters.groupKey && instance.groupKeys.includes(filters.groupKey) === false) {
      return false;
    }
    return true;
  });

  items = items.sort((left, right) => {
    const updatedAtOrder = sortDescending(left.updatedAt, right.updatedAt);
    return updatedAtOrder || sortAscending(left.id, right.id);
  });

  return applyLimit(items, filters.limit);
}

export function queryHostBindingsFromSnapshot(
  snapshot: EasyEmailSnapshot,
  filters: HostBindingQueryFilters = {},
): HostBinding[] {
  let items = snapshot.bindings.filter((binding) => {
    if (filters.hostId && binding.hostId !== filters.hostId) {
      return false;
    }
    if (filters.providerTypeKey && binding.providerTypeKey !== filters.providerTypeKey) {
      return false;
    }
    if (filters.instanceId && binding.instanceId !== filters.instanceId) {
      return false;
    }
    return true;
  });

  items = items.sort((left, right) => {
    const updatedAtOrder = sortDescending(left.updatedAt, right.updatedAt);
    if (updatedAtOrder) return updatedAtOrder;
    const hostOrder = sortAscending(left.hostId, right.hostId);
    return hostOrder || sortAscending(left.providerTypeKey, right.providerTypeKey);
  });

  return applyLimit(items, filters.limit);
}

export function queryMailboxSessionsFromSnapshot(
  snapshot: EasyEmailSnapshot,
  filters: MailboxSessionQueryFilters = {},
): MailboxSession[] {
  let items = snapshot.sessions.filter((session) => {
    if (filters.hostId && session.hostId !== filters.hostId) {
      return false;
    }
    if (filters.providerTypeKey && session.providerTypeKey !== filters.providerTypeKey) {
      return false;
    }
    if (filters.providerInstanceId && session.providerInstanceId !== filters.providerInstanceId) {
      return false;
    }
    if (filters.status && session.status !== filters.status) {
      return false;
    }
    return true;
  });

  items = items.sort((left, right) => {
    const createdAtOrder = filters.newestFirst
      ? sortDescending(left.createdAt, right.createdAt)
      : sortAscending(left.createdAt, right.createdAt);
    return createdAtOrder || sortAscending(left.id, right.id);
  });

  return applyLimit(items, filters.limit);
}

export function queryObservedMessagesFromSnapshot(
  snapshot: EasyEmailSnapshot,
  filters: ObservedMessageQueryFilters = {},
): ObservedMessage[] {
  let items = snapshot.messages.filter((message) => {
    if (filters.sessionId && message.sessionId !== filters.sessionId) {
      return false;
    }
    if (filters.providerInstanceId && message.providerInstanceId !== filters.providerInstanceId) {
      return false;
    }
    if (filters.extractedCodeOnly && !message.extractedCode) {
      return false;
    }
    return true;
  });

  items = items.sort((left, right) => {
    const observedAtOrder = filters.newestFirst
      ? sortDescending(left.observedAt, right.observedAt)
      : sortAscending(left.observedAt, right.observedAt);
    return observedAtOrder || sortAscending(left.id, right.id);
  });

  return applyLimit(items, filters.limit);
}

export function calculateMailPersistenceStats(snapshot: EasyEmailSnapshot): MailPersistenceStats {
  return {
    providerInstanceCount: snapshot.instances.length,
    hostBindingCount: snapshot.bindings.length,
    credentialSetCount: snapshot.credentialSets.length,
    credentialBindingCount: snapshot.credentialBindings.length,
    mailboxSessionCount: snapshot.sessions.length,
    observedMessageCount: snapshot.messages.length,
    resolvedSessionCount: snapshot.sessions.filter((session) => session.status === "resolved").length,
    extractedCodeMessageCount: snapshot.messages.filter((message) => Boolean(message.extractedCode)).length,
  };
}

