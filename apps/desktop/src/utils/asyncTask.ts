export function createNonOverlappingAsyncRunner<TArgs extends unknown[]>(
  task: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<boolean> {
  let running = false;

  return async (...args: TArgs) => {
    if (running) {
      return false;
    }

    running = true;
    try {
      await task(...args);
      return true;
    } finally {
      running = false;
    }
  };
}
