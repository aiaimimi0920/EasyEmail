import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type Page } from "./api";
import type { Contact } from "./contacts-api";

export function useContacts(enabled: boolean) {
  const [page, setPage] = useState<Page<Contact> | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const [query, setQuery] = useState(""), [revision, setRevision] = useState(0), generation = useRef(0);
  const path = `/contacts?limit=50&q=${encodeURIComponent(query)}`;
  useEffect(() => {
    if (!enabled) return;
    const current = ++generation.current, controller = new AbortController();
    setPending(true); setError("");
    api<Page<Contact>>(path, "GET", undefined, undefined, controller.signal).then(value => { if (current === generation.current) setPage(value); })
      .catch(failure => { if (current === generation.current) setError(errorMessage(failure)); })
      .finally(() => { if (current === generation.current) setPending(false); });
    return () => { generation.current++; controller.abort(); };
  }, [path, enabled, revision]);
  async function loadMore() {
    if (!enabled || pending || !page?.nextCursor) return;
    const current = ++generation.current; setPending(true); setError("");
    try {
      const next = await api<Page<Contact>>(`${path}&cursor=${encodeURIComponent(page.nextCursor)}`);
      if (current === generation.current) setPage(old => ({ ...next, items: [...(old?.items ?? []), ...next.items] }));
    } catch (failure) { if (current === generation.current) setError(errorMessage(failure)); }
    finally { if (current === generation.current) setPending(false); }
  }
  return { page, pending, error, query, search: (value: string) => { setQuery(value.trim()); setRevision(value => value + 1); },
    refresh: () => setRevision(value => value + 1), loadMore };
}
