import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type Page } from "./api";
import type { AgentService, AgentServiceFilter } from "./agent-services-api";

export function useAgentServices(visible: boolean) {
  const [page, setPage] = useState<Page<AgentService> | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const [filter, setFilter] = useState<AgentServiceFilter>({ query: "", trust: "", status: "" }), [revision, setRevision] = useState(0);
  const generation = useRef(0), loadingMore = useRef(false);
  const query = new URLSearchParams({ limit: "25", q: filter.query });
  if (filter.trust) query.set("trustLevel", filter.trust);
  if (filter.status) query.set("status", filter.status);
  const path = `/agent-services?${query}`;
  useEffect(() => {
    if (!visible) return;
    const current = ++generation.current, controller = new AbortController();
    setPending(true); setError("");
    api<Page<AgentService>>(path, "GET", undefined, undefined, controller.signal)
      .then(value => { if (current === generation.current) setPage(value); })
      .catch(failure => { if (current === generation.current) setError(errorMessage(failure)); })
      .finally(() => { if (current === generation.current) setPending(false); });
    return () => { generation.current++; controller.abort(); };
  }, [path, visible, revision]);
  async function loadMore() {
    if (!visible || pending || loadingMore.current || !page?.nextCursor) return;
    const current = ++generation.current; loadingMore.current = true; setPending(true); setError("");
    try {
      const next = await api<Page<AgentService>>(`${path}&cursor=${encodeURIComponent(page.nextCursor)}`);
      if (current === generation.current) setPage(old => ({ ...next, items: [...(old?.items ?? []), ...next.items] }));
    } catch (failure) { if (current === generation.current) setError(errorMessage(failure)); }
    finally { loadingMore.current = false; if (current === generation.current) setPending(false); }
  }
  return { page, pending, error, loadMore, refresh: () => setRevision(value => value + 1),
    search: (value: AgentServiceFilter) => { setFilter({ ...value, query: value.query.trim() }); setRevision(value => value + 1); } };
}
