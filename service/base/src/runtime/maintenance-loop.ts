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
  let maintenanceRunning = false;
  let maintenanceQueued = false;
  let probeInFlight: Promise<ProviderHealthProbeResult[]> | null = null;

  const runMaintenanceTick = () => {
    const result = {
      expired: service.expireSessions(),
      cleanedSessions: service.cleanupSessions(options.keepRecentSessionCount),
      cleaned: service.cleanupMessages(options.keepRecentCount),
      refreshed: service.refreshHealth(),
    };

    return result;
  };

  const scheduleMaintenanceTick = () => {
    if (maintenanceRunning) {
      maintenanceQueued = true;
      return;
    }

    maintenanceRunning = true;
    try {
      do {
        maintenanceQueued = false;
        runMaintenanceTick();
      } while (maintenanceQueued);
    } catch (error) {
      console.error("[mail-maintenance-loop] maintenance tick failed", error);
    } finally {
      maintenanceRunning = false;
    }
  };

  const runProbeAll = (): Promise<ProviderHealthProbeResult[]> => {
    if (probeInFlight) {
      return probeInFlight;
    }

    probeInFlight = service.probeAllProviderInstances()
      .catch((error) => {
        console.error("[mail-maintenance-loop] provider probe failed", error);
        throw error;
      })
      .finally(() => {
        probeInFlight = null;
      });

    return probeInFlight;
  };

  // Always probe provider instances once on boot so configured providers
  // enter an operational state before external callers try to open mailboxes.
  void runProbeAll().catch(() => undefined);

  const maintenanceHandle = setInterval(() => {
    scheduleMaintenanceTick();
  }, options.intervalMs);

  const activeProbeHandle = options.activeProbeEnabled
    ? setInterval(() => {
        void runProbeAll().catch(() => undefined);
      }, options.activeProbeIntervalMs)
    : undefined;

  return {
    intervalMs: options.intervalMs,
    tick() {
      return runMaintenanceTick();
    },
    probeAll() {
      return runProbeAll();
    },
    stop() {
      clearInterval(maintenanceHandle);
      if (activeProbeHandle !== undefined) {
        clearInterval(activeProbeHandle);
      }
    },
  };
}
