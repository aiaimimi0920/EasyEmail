import { startEasyEmailServiceFromConfig } from "./from-config.js";
import { installRuntimeSignalShutdown } from "./signal-shutdown.js";

const starting = startEasyEmailServiceFromConfig();
const shutdown = installRuntimeSignalShutdown(starting);
try {
  const runtime = await starting;
  if (!shutdown.isStopping()) console.log(`[easy_email] HTTP server listening at ${runtime.server.baseUrl}`);
} catch {
  shutdown.dispose();
  console.error("easy_email_startup_failed");
  process.exitCode = 1;
}
