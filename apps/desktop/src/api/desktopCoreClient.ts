import type { InvokeCommand } from "./invokeCommand";

export type DesktopCoreRuntimeDto = {
  status: "ready";
  base_url: string;
  api_token: string;
  host_id: string;
};

export type ExportDiagnosticsRequest = {
  destination_dir?: string;
};

export type DesktopDiagnosticBundleDto = {
  bundle_path: string;
  generated_at_epoch_ms: number;
  included_log_files: number;
  redacted_line_count: number;
};

export function createDesktopCoreClient(invokeCommand: InvokeCommand) {
  return {
    getRuntime(): Promise<DesktopCoreRuntimeDto> {
      return invokeCommand<DesktopCoreRuntimeDto>("desktop_core_runtime");
    },
    exportDiagnostics(
      request?: ExportDiagnosticsRequest,
    ): Promise<DesktopDiagnosticBundleDto> {
      return invokeCommand<DesktopDiagnosticBundleDto>(
        "desktop_export_diagnostics",
        request ? { request } : undefined,
      );
    },
  };
}
