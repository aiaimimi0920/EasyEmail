import { startEasyEmailServiceFromConfig } from "./from-config.js";
import type { EasyEmailRuntimeBootstrapEnvironment } from "./config.js";
import type { StartedEasyEmailServiceRuntime } from "./runtime.js";

export async function startEasyEmailServiceFromEnv(
  env: EasyEmailRuntimeBootstrapEnvironment = process.env,
): Promise<StartedEasyEmailServiceRuntime> {
  return startEasyEmailServiceFromConfig(env);
}
