import { useCallback, useRef, useState } from "react";
import { api, ApiError, errorMessage, type Mailbox } from "./api";
import type { Creation } from "./creation-api";

interface Attempt { body: Record<string, string>; key: string; uncertain: boolean }

export function useMailboxCreation(onCreated: (mailbox: Mailbox) => void) {
  const attempt = useRef<Attempt | null>(null), initialRecovery = useRef(false);
  const [creation, setCreation] = useState<Creation | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [unresolved, setUnresolved] = useState(""), [refresh, setRefresh] = useState(0);
  const [ready, setReady] = useState(false);

  const remember = useCallback((row: Creation) => {
    setCreation(row);
    setUnresolved(`创建结果待确认：${row.state} · ${row.providerId ?? "供应商待核对"} · ${row.address ?? "地址待确认"}（${row.requestKey}）`);
  }, []);
  const recover = useCallback((row: Creation | null) => {
    if (initialRecovery.current) return;
    initialRecovery.current = true;
    setReady(true);
    if (row && !attempt.current) remember(row);
  }, [remember]);

  function clear() { attempt.current = null; setCreation(null); setUnresolved(""); }

  async function apply(row: Creation) {
    if (row.state !== "complete") return remember(row);
    const result = await api<{ mailbox: Mailbox }>(`/mailboxes/${row.mailboxId}`);
    clear(); onCreated(result.mailbox);
  }

  async function select(row: Creation) {
    const locked = attempt.current?.key ?? creation?.requestKey;
    if (locked && locked !== row.requestKey) return;
    setPending(true); setError("");
    try {
      const latest = (await api<{ creation: Creation }>(`/mailbox-creations/${row.id}`)).creation;
      await apply(latest);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); setRefresh((value) => value + 1); }
  }

  async function create(body: Record<string, string>) {
    if (creation) return select(creation);
    setPending(true); setError("");
    initialRecovery.current = true;
    attempt.current ??= { body, key: crypto.randomUUID(), uncertain: false };
    const current = attempt.current;
    try {
      const result = await api<{ mailbox?: Mailbox; creation?: { mailboxId: string } }>("/mailboxes", "POST", current.body, { "idempotency-key": current.key });
      if (result.mailbox) { clear(); onCreated(result.mailbox); }
      else {
        current.uncertain = true;
        if (!result.creation) throw new Error("Missing creation result");
        await apply((await api<{ creation: Creation }>(`/mailbox-creations/${result.creation.mailboxId}`)).creation);
      }
    } catch (failure) {
      setError(errorMessage(failure));
      if (!current.uncertain && failure instanceof ApiError && failure.status < 500) clear();
      else { current.uncertain = true; setUnresolved(`请检查本次创建结果（${current.key}）`); }
    } finally { setPending(false); setRefresh((value) => value + 1); }
  }

  async function acknowledge(confirmAddress: string, acknowledgeUncertain: boolean) {
    if (!creation) return;
    setPending(true); setError("");
    try {
      await api(`/mailbox-creations/${creation.id}/acknowledge`, "POST", { [creation.address === null ? "confirmRequestKey" : "confirmAddress"]: confirmAddress, acknowledgeUncertain });
      clear();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); setRefresh((value) => value + 1); }
  }

  return { creation, pending, error, unresolved, refresh, ready, recover, select, create, acknowledge,
    lockedKey: attempt.current?.key ?? creation?.requestKey, refreshHistory: () => setRefresh((value) => value + 1) };
}
