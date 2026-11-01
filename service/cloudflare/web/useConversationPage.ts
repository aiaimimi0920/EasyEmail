import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type Page } from "./api";

export function useConversationPage<T>(path: string, revision: number) {
  const [page, setPage] = useState<Page<T> | null>(null), [pending, setPending] = useState(true), [error, setError] = useState("");
  const generation = useRef(0), busy = useRef(false);
  useEffect(() => {
    const current = ++generation.current, controller = new AbortController();
    busy.current = true; setPending(true); setError(""); setPage(null);
    api<Page<T>>(path, "GET", undefined, undefined, controller.signal).then(value => { if (current === generation.current) setPage(value); })
      .catch(failure => { if (current === generation.current) setError(errorMessage(failure)); })
      .finally(() => { if (current === generation.current) { busy.current = false; setPending(false); } });
    return () => { generation.current++; controller.abort(); };
  }, [path, revision]);
  async function loadMore() {
    if (busy.current || !page?.nextCursor) return;
    const current = ++generation.current; busy.current = true; setPending(true); setError("");
    try {
      const next = await api<Page<T>>(`${path}&cursor=${encodeURIComponent(page.nextCursor)}`);
      if (current === generation.current) setPage(old => ({ ...next, items: [...(old?.items ?? []), ...next.items] }));
    } catch (failure) { if (current === generation.current) setError(errorMessage(failure)); }
    finally { if (current === generation.current) { busy.current = false; setPending(false); } }
  }
  return { page, pending, error, loadMore };
}
