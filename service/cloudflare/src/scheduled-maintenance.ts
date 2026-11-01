import type { Env } from "./contracts";
import { cleanupIdentity } from "./rate-limits";
import { maintainGoogleOAuth } from "./google-oauth-maintenance";
import { expirePendingSends } from "./outgoing-store";
import { maintainNormalOutgoing } from "./normal-outgoing-store";
import { scheduledOutboxCleanup } from "./outbox-cleanup";
import { scheduledRetention } from "./retention-run";
import { maintainNormalInbox } from "./normal-inbox-cleanup";
import { maintainAgentInbox } from "./agent-inbox-cleanup";

export async function runScheduledMaintenance(env: Env, scheduledTime: number): Promise<void> {
  const steps: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ["cleanupIdentity", () => cleanupIdentity(env)],
    ["maintainGoogleOAuth", () => maintainGoogleOAuth(env)],
    ["expirePendingSends", () => expirePendingSends(env)],
    ["maintainNormalOutgoing", () => maintainNormalOutgoing(env)],
    ["scheduledOutboxCleanup", () => scheduledOutboxCleanup(env)],
    ["scheduledRetention", () => scheduledRetention(env, scheduledTime)],
    ["maintainNormalInbox", () => maintainNormalInbox(env)],
    ["maintainAgentInbox", () => maintainAgentInbox(env)],
  ];
  let failed = false;
  for (const [task, run] of steps) {
    try { await run(); }
    catch {
      failed = true;
      console.error(JSON.stringify({ event: "scheduled_maintenance_failed", task }));
    }
  }
  if (failed) throw new Error("scheduled_maintenance_failed");
}
