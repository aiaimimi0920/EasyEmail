import { MailRegistry } from "../domain/registry.js";

export interface HealthRefreshRecord {
  instanceId: string;
  previousHealthScore: number;
  nextHealthScore: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function refreshInstanceHealth(registry: MailRegistry): HealthRefreshRecord[] {
  const records: HealthRefreshRecord[] = [];

  for (const instance of registry.listInstances()) {
    const relatedSessions = registry.listSessions().filter((session) => session.providerInstanceId === instance.id);
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
