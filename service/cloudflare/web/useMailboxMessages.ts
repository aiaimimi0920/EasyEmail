import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type MessageSummary, type Page } from "./api";

interface Inbox extends Page<MessageSummary> { sync: { syncedAt: number | null; error: string | null; nextPage: number | null } }
interface SyncResult { sync: { fetched: number; complete: boolean } }

export function useMailboxMessages(mailboxId: string, visible: boolean, query: string, revision: number) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [pending, setPending] = useState(false), [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(""), [status, setStatus] = useState("");
  const generation = useRef(0), path = `/mailboxes/${mailboxId}`;
  const filters = new URLSearchParams(query);
  filters.set("mailboxId", mailboxId); filters.set("folder", "all");
  const listPath = query ? `/messages?${filters}` : `${path}/messages`;

  async function firstPage(): Promise<Inbox> {
    if (!query) return api<Inbox>(listPath);
    const [page, metadata] = await Promise.all([
      api<Page<MessageSummary>>(listPath), api<Inbox>(`${path}/messages?limit=1`),
    ]);
    return { ...page, sync: metadata.sync };
  }

  useEffect(() => {
    const current = ++generation.current;
    setInbox(null); setError(""); setStatus(""); setSyncing(false); setPending(visible);
    if (visible) {
      firstPage().then(value => { if (current === generation.current) setInbox(value); })
        .catch(failure => { if (current === generation.current) setError(errorMessage(failure)); })
        .finally(() => { if (current === generation.current) setPending(false); });
    }
    return () => { generation.current++; };
  }, [listPath, visible, revision]);

  async function sync(page = 1) {
    if (pending || !visible) return;
    const current = ++generation.current;
    setPending(true); setSyncing(true); setError(""); setStatus("");
    try {
      const response = await api<SyncResult>(`${path}/sync`, "POST", { page });
      if (current !== generation.current) return;
      const next = await firstPage();
      if (current !== generation.current) return;
      setInbox(next);
      setStatus(`本页读取 ${response.sync.fetched} 封${response.sync.complete ? "，本轮已结束" : "，同步尚不完整"}`);
    } catch (failure) { if (current === generation.current) setError(errorMessage(failure)); }
    finally { if (current === generation.current) { setPending(false); setSyncing(false); } }
  }

  async function loadMore() {
    if (pending || !visible || !inbox?.nextCursor) return;
    const current = ++generation.current, old = inbox;
    setPending(true); setError("");
    try {
      const separator = query ? "&" : "?";
      const next = await api<Page<MessageSummary> & { sync?: Inbox["sync"] }>(`${listPath}${separator}cursor=${encodeURIComponent(old.nextCursor!)}`);
      if (current === generation.current) setInbox({ ...next, sync: next.sync ?? old.sync, items: [...old.items, ...next.items] });
    } catch (failure) { if (current === generation.current) setError(errorMessage(failure)); }
    finally { if (current === generation.current) setPending(false); }
  }

  return { inbox, setInbox, pending, syncing, error, status, sync, loadMore };
}
