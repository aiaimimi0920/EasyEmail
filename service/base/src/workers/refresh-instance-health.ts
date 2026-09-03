import { MailRegistry } from "../domain/registry.js";

export interface HealthRefreshRecord {
  instanceId: string;
  previousHealthScore: number;
  nextHealthScore: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Provider health is an operational signal, not a lifetime success counter.
// Old mailbox sessions must not keep a provider degraded after a fresh probe
// has established that it is reachable again.
const HEALTH_SESSION_WINDOW_MS = 60 * 60 * 1000;

export function refreshInstanceHealth(registry: MailRegistry, now: Date = new Date()): HealthRefreshRecord[] {
  const records: HealthRefreshRecord[] = [];

  for (const instance of registry.listInstances()) {
    const relatedSessions = registry.listSessions()
      .filter((session) => session.providerInstanceId === instance.id)
      .filter((session) => session.status === "resolved" || session.status === "expired")
      // Explicit cleanup/release is not a provider failure. Providers without
      // a release endpoint retain an `expired` session status, so use the
      // release marker to keep those maintenance operations out of health.
      .filter((session) => !session.metadata.releasedAt)
      .filter((session) => {
        const createdAt = Date.parse(session.createdAt);
        return Number.isFinite(createdAt) && now.getTime() - createdAt <= HEALTH_SESSION_WINDOW_MS;
      });

    // An open session has not produced an outcome yet. Likewise, an instance
    // with no recent terminal sessions should retain the score from its last
    // probe instead of being recalculated from historical data.
    if (relatedSessions.length === 0) {
      continue;
    }

    const resolvedCount = relatedSessions.filter((session) => session.status === "resolved").length;
    const expiredCount = relatedSessions.filter((session) => session.status === "expired").length;
    const total = relatedSessions.length;
    const successRate = total === 0 ? instance.healthScore : resolvedCount / total;
    const penalty = total === 0 ? 0 : expiredCount / total / 2;
    const nextHealthScore = clamp(Number((successRate - penalty).toFixed(2)), 0.1, 1);

    if (nextHealthScore === instance.healthScore) {
      continue;
    }

    registry.saveInstance({
      ...instance,
      healthScore: nextHealthScore,
      status: instance.status === "cooling"
        ? "cooling"
        : (nextHealthScore < 0.3 ? "degraded" : instance.status),
      updatedAt: new Date().toISOString(),
    });

    records.push({
      instanceId: instance.id,
      previousHealthScore: instance.healthScore,
      nextHealthScore,
    });
  }

  return records;
}
