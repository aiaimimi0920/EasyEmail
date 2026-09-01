import type { InvokeCommand } from "./invokeCommand";

export type DesktopCoreRuntimeDto = {
  status: "ready";
  base_url: string;
  api_token: string;
};

export function createDesktopCoreClient(invokeCommand: InvokeCommand) {
  return {
    getRuntime(): Promise<DesktopCoreRuntimeDto> {
      return invokeCommand<DesktopCoreRuntimeDto>("desktop_core_runtime");
    },
  };
}
