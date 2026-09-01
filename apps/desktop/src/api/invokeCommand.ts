export type InvokeCommand = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;
