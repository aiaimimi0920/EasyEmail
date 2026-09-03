import { EasyEmailError } from "../domain/errors.js";
import type { MailRegistry } from "../domain/registry.js";
import type { MailProviderAdapter } from "../providers/contracts.js";
import type {
  MailboxSession,
  MailProviderTypeKey,
} from "../domain/models.js";

export interface MailboxReleaseResult {
  session: MailboxSession;
  providerInstanceId: string;
  providerTypeKey: MailboxSession["providerTypeKey"];
  released: boolean;
  detail?: string;
}

export async function releaseMailboxSession({
  sessionId,
  reason,
  now = new Date(),
  registry,
  adapterMap,
  syncOperationalState,
}: {
  sessionId: string;
  reason?: string;
  now?: Date;
  registry: MailRegistry;
  adapterMap: Map<MailProviderTypeKey, MailProviderAdapter>;
  syncOperationalState: (now?: Date) => void;
}): Promise<MailboxReleaseResult> {
  syncOperationalState(now);
  const session = registry.findSessionById(sessionId);
  if (!session) {
    throw new EasyEmailError("MAILBOX_SESSION_NOT_FOUND", `Unknown mailbox session: ${sessionId}.`);
  }

  const instance = registry.findInstanceById(session.providerInstanceId);
  if (!instance) {
    throw new EasyEmailError(
      "PROVIDER_INSTANCE_NOT_FOUND",
      `Unknown provider instance for mailbox session ${sessionId}: ${session.providerInstanceId}.`,
    );
  }

  const adapter = adapterMap.get(session.providerTypeKey);
  const credentialSets = registry.resolveCredentialSetsForInstance(instance.id, "poll");
  const releaseResult = adapter?.releaseMailboxSession
    ? await adapter.releaseMailboxSession({
      session,
      instance,
      credentialSets,
      now,
      reason,
    })
    : {
      released: false,
      detail: "provider_does_not_support_release",
    };

  const nextSession: MailboxSession = {
    ...session,
    status: session.status === "resolved" ? "resolved" : "expired",
    metadata: {
      ...session.metadata,
      releasedAt: now.toISOString(),
      ...(reason?.trim() ? { releaseReason: reason.trim() } : {}),
      releaseStatus: releaseResult?.released ? "released" : "skipped",
      ...(releaseResult?.detail ? { releaseDetail: releaseResult.detail } : {}),
    },
  };
  registry.saveSession(nextSession);

  return {
    session: nextSession,
    providerInstanceId: instance.id,
    providerTypeKey: session.providerTypeKey,
    released: Boolean(releaseResult?.released),
    detail: releaseResult?.detail,
  };
}
