import { loadEasyEmailServiceRuntimeConfigFromEnvironment, type EasyEmailRuntimeBootstrapEnvironment } from "./config.js";
import { startEasyEmailServiceRuntime, type StartedEasyEmailServiceRuntime } from "./runtime.js";

export async function startEasyEmailServiceFromConfig(
  env: EasyEmailRuntimeBootstrapEnvironment = process.env,
): Promise<StartedEasyEmailServiceRuntime> {
  const config = await loadEasyEmailServiceRuntimeConfigFromEnvironment(env);
  return startEasyEmailServiceRuntime({ config });
}
