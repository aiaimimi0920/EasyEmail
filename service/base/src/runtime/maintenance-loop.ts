import type { EasyEmailService } from "../service/easy-email-service.js";
import type { ProviderHealthProbeResult } from "../domain/models.js";

export interface MailMaintenanceLoop {
  intervalMs: number;
  tick(): ReturnType<EasyEmailService["runMaintenance"]>;
  probeAll(): Promise<ProviderHealthProbeResult[]>;
  stop(): void;
}

export interface MailMaintenanceLoopOptions {
  intervalMs: number;
  keepRecentCount: number;
  keepRecentSessionCount: number;
  activeProbeEnabled: boolean;
  activeProbeIntervalMs: number;
}

export function startMailMaintenanceLoop(
  service: EasyEmailService,
  options: MailMaintenanceLoopOptions,
): MailMaintenanceLoop {
  // Always probe provider instances once on boot so configured providers
  // enter an operational state before external callers try to open mailboxes.
  void service.probeAllProviderInstances().catch(() => undefined);

  const maintenanceHandle = setInterval(() => {
    service.expireSessions();
    service.cleanupSessions(options.keepRecentSessionCount);
    service.cleanupMessages(options.keepRecentCount);
    service.refreshHealth();
  }, options.intervalMs);

  const activeProbeHandle = options.activeProbeEnabled
    ? setInterval(() => {
        void service.probeAllProviderInstances().catch(() => undefined);
      }, options.activeProbeIntervalMs)
    : undefined;

  return {
    intervalMs: options.intervalMs,
    tick() {
      return {
        expired: service.expireSessions(),
        cleanedSessions: service.cleanupSessions(options.keepRecentSessionCount),
        cleaned: service.cleanupMessages(options.keepRecentCount),
        refreshed: service.refreshHealth(),
      };
    },
    probeAll() {
      return service.probeAllProviderInstances();
    },
    stop() {
      clearInterval(maintenanceHandle);
      if (activeProbeHandle !== undefined) {
        clearInterval(activeProbeHandle);
      }
    },
  };
}
