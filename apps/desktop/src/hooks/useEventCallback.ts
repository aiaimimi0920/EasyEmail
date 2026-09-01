import { useCallback, useLayoutEffect, useRef } from "react";

/** Returns a stable callback that delegates to the latest render's handler. */
export function useEventCallback<TArgs extends unknown[], TResult>(
  handler: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const handlerRef = useRef(handler);

  useLayoutEffect(() => {
    handlerRef.current = handler;
  });

  return useCallback((...args: TArgs) => handlerRef.current(...args), []);
}
