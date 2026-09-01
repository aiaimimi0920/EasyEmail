import type { InvokeCommand } from "./invokeCommand";

export type AppHealthDto = {
  status: string;
  anonymous_account_id: string;
  normal_account_count: number;
};

export function createAppClient(invokeCommand: InvokeCommand) {
  return {
    getHealth(): Promise<AppHealthDto> {
      return invokeCommand<AppHealthDto>("health_check");
    },
  };
}
