import { EasyEmailError } from "../domain/errors.js";
import { normalizeMailProviderTypeKey } from "../domain/models.js";
import type { MailRegistry } from "../domain/registry.js";
import type {
  EasyEmailSnapshot,
  MailProviderTypeKey,
} from "../domain/models.js";
import {
  MoemailClient,
  resolveMoemailConfig,
  type MoemailMailboxListingEntry,
} from "../providers/moemail/client.js";

const MOEMAIL_CAPACITY_RECOVERY_MARKERS = [
  "no available moemail credentials for generate",
  "moemail_capacity_exhausted",
  "\"code\":\"moemail_capacity_exhausted\"",
  "[code=moemail_capacity_exhausted]",
  "moemail_upstream_transient",
  "maximum mailbox",
  "max mailbox",
  "mailbox count limit",
  "最大邮箱数量限制",
] as const;
const M2U_CAPACITY_RECOVERY_MARKERS = [
  "m2u_capacity_failure",
  "m2u_transient_failure",
] as const;
const TEMPORAM_CAPACITY_RECOVERY_MARKERS = [
  "temporam_capacity_failure",
  "temporam_transient_failure",
] as const;

export interface MailboxCapacityRecoveryInput {
  failureCode?: string;
  detail?: string;
  providerTypeKey?: string;
  providerInstanceId?: string;
  staleAfterSeconds?: number;
  maxDeleteCount?: number;
  force?: boolean;
}

export interface MoemailMailboxCleanupResult {
  providerInstanceId: string;
  staleAfterSeconds: number;
  force: boolean;
  scannedCount: number;
  deletedCount: number;
  skippedCount: number;
  nextCursor?: string;
  deleted: Array<{ emailId: string; email: string; detail?: string }>;
  skipped: Array<{ emailId: string; email: string; reason: string }>;
}

export function inferMailboxCapacityRecoveryProviderType(
  input: Pick<MailboxCapacityRecoveryInput, "providerTypeKey" | "failureCode" | "detail">,
): MailProviderTypeKey | undefined {
  const normalizedProviderTypeKey = normalizeMailProviderTypeKey(input.providerTypeKey);
  if (normalizedProviderTypeKey) {
    return normalizedProviderTypeKey;
  }

  const combined = [
    input.failureCode?.trim(),
    input.detail?.trim(),
  ]
    .filter((item): item is string => Boolean(item))
    .join(" ")
    .toLowerCase();

  if (!combined) {
    return undefined;
  }

  if (MOEMAIL_CAPACITY_RECOVERY_MARKERS.some((marker) => combined.includes(marker))) {
    return "moemail";
  }
  if (M2U_CAPACITY_RECOVERY_MARKERS.some((marker) => combined.includes(marker))) {
    return "m2u";
  }
  if (TEMPORAM_CAPACITY_RECOVERY_MARKERS.some((marker) => combined.includes(marker))) {
    return "temporam";
  }

  return undefined;
}

function parseOptionalTimestamp(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function shouldCleanupMoemailMailboxEntry(
  entry: MoemailMailboxListingEntry,
  {
    nowMs,
    staleAfterMs,
    upstreamExpiryTimeMs,
  }: {
    nowMs: number;
    staleAfterMs: number;
    upstreamExpiryTimeMs: number;
  },
): { ok: boolean; reason: string } {
  const createdAtMs = parseOptionalTimestamp(entry.createdAt);
  if (createdAtMs !== undefined) {
    if (createdAtMs <= nowMs - staleAfterMs) {
      return { ok: true, reason: "age_threshold_reached" };
    }
    return { ok: false, reason: "not_old_enough" };
  }

  const expiresAtMs = parseOptionalTimestamp(entry.expiresAt);
  if (expiresAtMs !== undefined) {
    const remainingMs = expiresAtMs - nowMs;
    if (remainingMs <= Math.max(0, upstreamExpiryTimeMs - staleAfterMs)) {
      return { ok: true, reason: "remaining_lifetime_threshold_reached" };
    }
    return { ok: false, reason: "remaining_lifetime_too_high" };
  }

  return { ok: false, reason: "missing_timestamps" };
}

export async function cleanupMoemailMailboxes({
  registry,
  getSnapshot,
  staleAfterSeconds = 300,
  maxDeleteCount = 200,
  force = false,
  providerInstanceId,
  now = new Date(),
}: {
  registry: MailRegistry;
  getSnapshot: () => EasyEmailSnapshot;
  staleAfterSeconds?: number;
  maxDeleteCount?: number;
  force?: boolean;
  providerInstanceId?: string;
  now?: Date;
}): Promise<MoemailMailboxCleanupResult> {
  const moemailInstances = getSnapshot().instances.filter((item) => item.providerTypeKey === "moemail");
  if (moemailInstances.length <= 0) {
    throw new EasyEmailError("PROVIDER_INSTANCE_NOT_FOUND", "No MoEmail provider instance is registered.");
  }

  const normalizedProviderInstanceId = providerInstanceId?.trim();
  if (!normalizedProviderInstanceId && moemailInstances.length > 1) {
    throw new EasyEmailError(
      "PROVIDER_INSTANCE_ID_REQUIRED",
      "Multiple MoEmail provider instances are registered. Specify providerInstanceId.",
    );
  }

  const instance = normalizedProviderInstanceId
    ? moemailInstances.find((item) => item.id === normalizedProviderInstanceId)
    : moemailInstances[0];
  if (!instance) {
    throw new EasyEmailError(
      "PROVIDER_INSTANCE_NOT_FOUND",
      `Unknown provider instance: ${normalizedProviderInstanceId}.`,
    );
  }

  const credentialSets = registry.resolveCredentialSetsForInstance(instance.id, "poll");
  const moemailConfig = resolveMoemailConfig(instance, credentialSets, {
    namespace: `mail:moemail:maintenance:${instance.id}`,
  });
  if (moemailConfig.credentialSets.length <= 0) {
    throw new EasyEmailError("MOEMAIL_CONFIGURATION_MISSING", `MoEmail instance ${instance.id} is unavailable.`);
  }
  const client = new MoemailClient(moemailConfig);

  const forceCleanup = Boolean(force);
  const normalizedStaleAfterSeconds = forceCleanup ? 0 : Math.max(60, Math.trunc(staleAfterSeconds || 300));
  const staleAfterMs = normalizedStaleAfterSeconds * 1000;
  const normalizedMaxDeleteCount = Math.max(1, Math.trunc(maxDeleteCount || 200));
  const nowMs = now.getTime();

  let cursor: string | undefined;
  let scannedCount = 0;
  let deletedCount = 0;
  let skippedCount = 0;
  const deleted: Array<{ emailId: string; email: string; detail?: string }> = [];
  const skipped: Array<{ emailId: string; email: string; reason: string }> = [];

  for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
    const page = await client.listEmails(cursor, "poll");
    for (const entry of page.emails) {
      scannedCount += 1;

      const decision = forceCleanup
        ? { ok: true, reason: "force_cleanup" }
        : shouldCleanupMoemailMailboxEntry(entry, {
          nowMs,
          staleAfterMs,
          upstreamExpiryTimeMs: moemailConfig.expiryTimeMs,
        });
      if (!decision.ok) {
        skippedCount += 1;
        if (skipped.length < 50) {
          skipped.push({
            emailId: entry.emailId,
            email: entry.email,
            reason: decision.reason,
          });
        }
        continue;
      }

      if (deletedCount >= normalizedMaxDeleteCount) {
        skippedCount += 1;
        if (skipped.length < 50) {
          skipped.push({
            emailId: entry.emailId,
            email: entry.email,
            reason: "delete_limit_reached",
          });
        }
        continue;
      }

      try {
        const result = await client.deleteMailbox(entry.emailId, "poll", {
          fallbackToApiKeyAfterWebUnauthorized: true,
        });
        if (result.released) {
          deletedCount += 1;
          if (deleted.length < 50) {
            deleted.push({
              emailId: entry.emailId,
              email: entry.email,
              detail: result.detail,
            });
          }
          continue;
        }
        skippedCount += 1;
        if (skipped.length < 50) {
          skipped.push({
            emailId: entry.emailId,
            email: entry.email,
            reason: result.detail || "delete_skipped",
          });
        }
      } catch (error) {
        skippedCount += 1;
        if (skipped.length < 50) {
          skipped.push({
            emailId: entry.emailId,
            email: entry.email,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    cursor = page.nextCursor?.trim() || undefined;
    if (!cursor) {
      break;
    }
  }

  return {
    providerInstanceId: instance.id,
    staleAfterSeconds: normalizedStaleAfterSeconds,
    force: forceCleanup,
    scannedCount,
    deletedCount,
    skippedCount,
    nextCursor: cursor,
    deleted,
    skipped,
  };
}
