import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import type { NormalAccount } from "./normal-accounts";
import { normalInboxPath, normalMessages, type NormalMail, type NormalMailPage, type NormalSyncRequest } from "./normal-inbox";
import { checkedNormalSync, normalSyncRejectedBeforeReservation } from "./normal-sync-receipt";

export function useNormalInbox(account: NormalAccount, visible: boolean, folder = "inbox", revision = 0, folderId = "", remoteRevision = 0, serverFolderId = "") {
  const [page, setPage] = useState<NormalMailPage | null>(null), [message, setMessage] = useState<NormalMail | null>(null);
  const [history, setHistory] = useState<NormalSyncRequest[]>([]), [result, setResult] = useState<NormalSyncRequest | null>(null);
  const [pending, setPending] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState("");
  const [reading, setReading] = useState(false), [pageIds, setPageIds] = useState<string[]>([]), [listRevision, setListRevision] = useState(0);
  const operation = useRef<{ key: string; revision: number } | null>(null), busy = useRef(false), generation = useRef(0);
  const reader = useRef<AbortController | null>(null), detail = useRef<AbortController | null>(null), mounted = useRef(true);
  const selected = useRef<string | null>(null);
  const path = `${normalInboxPath(account.id)}${serverFolderId ? `/server-folders/${serverFolderId}` : ""}`;
  async function refresh() {
    const current = ++generation.current, controller = new AbortController(); reader.current?.abort(); reader.current = controller;
    detail.current?.abort(); selected.current = null; setMessage(null); setReading(true); setPageIds([]); setListRevision(value => value + 1);
    try {
      const [next, requests] = await Promise.all([normalMessages(account.id, "", controller.signal, folder, folderId, serverFolderId),
        api<{ items: NormalSyncRequest[] }>(`${path}/sync-requests`, "GET", undefined, undefined, controller.signal)]);
      if (controller.signal.aborted || current !== generation.current || !mounted.current) return;
      setPage(next); setPageIds(next.items.map(item => item.id)); setHistory(requests.items);
    } catch (failure) { if (!controller.signal.aborted && mounted.current) setError(errorMessage(failure)); }
    finally { if (reader.current === controller) { reader.current = null; if (mounted.current) setReading(false); } }
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; reader.current?.abort(); detail.current?.abort(); };
  }, []);
  useEffect(() => {
    generation.current++;
    selected.current = null; setPage(null); setPageIds([]); setMessage(null); setError(""); setReading(false);
    if (visible) void refresh();
    return () => { generation.current++; reader.current?.abort(); detail.current?.abort(); };
  }, [visible, account.id, account.revision, folder, revision, folderId, serverFolderId]);
  useEffect(() => { if (visible && selected.current) void open(selected.current); }, [remoteRevision]);
  async function more() {
    if (!page?.nextCursor || busy.current || reader.current) return;
    const current = ++generation.current, controller = new AbortController(); reader.current = controller; setReading(true); setError("");
    try { const next = await normalMessages(account.id, page.nextCursor, controller.signal, folder, folderId, serverFolderId);
      if (!controller.signal.aborted && current === generation.current && mounted.current) {
        setPage({ ...next, items: [...page.items, ...next.items] }); setPageIds(next.items.map(item => item.id));
      } }
    catch (failure) { if (!controller.signal.aborted && current === generation.current && mounted.current) setError(errorMessage(failure)); }
    finally { if (reader.current === controller) { reader.current = null; if (mounted.current) setReading(false); } }
  }
  async function open(id: string) {
    selected.current = id;
    const controller = new AbortController(); detail.current?.abort(); detail.current = controller;
    setMessage(null); setError("");
    try { const next = await api<{ message: NormalMail }>(`${path}/messages/${id}`, "GET", undefined, undefined, controller.signal);
      if (!controller.signal.aborted && mounted.current) setMessage(next.message); }
    catch (failure) { if (!controller.signal.aborted && mounted.current) setError(errorMessage(failure)); }
  }
  async function synchronize(reconcile = false) {
    if (busy.current) return;
    operation.current ??= { key: crypto.randomUUID(), revision: account.revision };
    const current = operation.current; busy.current = true; setPending(true); setError("");
    try {
      const response = reconcile ? await api<{ request: unknown }>(`${path}/sync-requests/${current.key}`)
        : await api<{ request: unknown }>(`${path}/sync`, "POST", { expectedRevision: current.revision }, { "idempotency-key": current.key });
      if (!mounted.current) return;
      const receipt = checkedNormalSync(response.request, account.id, current.revision, current.key, serverFolderId);
      setResult(receipt);
      if (receipt.state === "pending") setUncertain(true);
      else {
        operation.current = null; setUncertain(false);
        if (receipt.state === "failed") setError(errorMessage(new ApiError(503, receipt.errorCode ?? "normal_sync_interrupted")));
        await refresh();
      }
    } catch (failure) {
      if (!mounted.current) return;
      setError(errorMessage(failure));
      if (!reconcile && !uncertain && normalSyncRejectedBeforeReservation(failure)) { operation.current = null; setUncertain(false); }
      else setUncertain(true);
    } finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  return { page, pageIds, listRevision, reading, message, history, result, pending, uncertain, error, refresh, more, open, synchronize };
}
