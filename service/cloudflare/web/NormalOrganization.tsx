import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api, ApiError, errorMessage } from "./api";
import type { OrganizationPatch, OrganizationResult } from "./labels-api";
import { useOrganizationGate } from "./OrganizationGate";
import { normalInboxPath } from "./normal-inbox";
import { checkedNormalOrganization } from "./normal-organization-receipt";

export type NormalPatch = OrganizationPatch;
interface Attempt { accountId: string; serverFolderId?: string; key: string; body: NormalPatch & { messageIds: string[] } }
interface Controller { locked: boolean; revision: number; submit: (accountId: string, messageIds: string[], patch: NormalPatch, serverFolderId?: string) => Promise<void> }
const Context = createContext<Controller | null>(null);
export function useNormalOrganization() {
  const value = useContext(Context); if (!value) throw new Error("NormalOrganizationProvider is required"); return value;
}
export function NormalOrganizationProvider({ children }: { children: ReactNode }) {
  const gate = useOrganizationGate(), owner = useId();
  const [attempt, setAttempt] = useState<Attempt | null>(null), [pending, setPending] = useState(false), [revision, setRevision] = useState(0);
  const [error, setError] = useState(""), [status, setStatus] = useState("");
  const held = useRef<Attempt | null>(null), uncertain = useRef(false), busy = useRef(false), active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; gate.release(owner); }; }, [gate.release, owner]);
  async function run(readOnly: boolean, requested?: Attempt) {
    if (busy.current) return;
    const current = held.current ?? requested; if (!current) return;
    if (!gate.acquire(owner)) return;
    held.current = current; setAttempt(current); busy.current = true; setPending(true); setError(""); setStatus("");
    const base = normalInboxPath(current.accountId, current.serverFolderId);
    try {
      const result = readOnly ? await api<OrganizationResult>(`${base}/organization-operations/${current.key}`)
        : await api<OrganizationResult>(`${base}/messages/organize`, "POST", current.body, { "idempotency-key": current.key });
      checkedNormalOrganization(result.operation, current.accountId, current.serverFolderId, current.key, current.body.messageIds.length);
      if (active.current) {
        held.current = null; uncertain.current = false; setAttempt(null); gate.release(owner); setRevision(value => value + 1);
        setStatus(`已整理 ${result.operation.messageCount} 封普通邮件${readOnly || result.replayed ? "（已核对原操作）" : ""}`);
      }
    } catch (failure) {
      if (active.current) {
        setError(errorMessage(failure));
        if (!readOnly && !uncertain.current && failure instanceof ApiError && failure.status < 500 && failure.status !== 429) {
          held.current = null; setAttempt(null); gate.release(owner); setRevision(value => value + 1);
        } else uncertain.current = true;
      }
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  return <Context.Provider value={{ locked: attempt !== null || (gate.owner !== null && gate.owner !== owner), revision: revision + gate.revision,
    submit: (accountId, messageIds, patch, serverFolderId) => run(false, { accountId, serverFolderId, key: crypto.randomUUID(), body: { ...patch, messageIds: [...messageIds],
      ...(patch.addLabelIds ? { addLabelIds: [...patch.addLabelIds] } : {}), ...(patch.removeLabelIds ? { removeLabelIds: [...patch.removeLabelIds] } : {}) } }) }}>
    {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
    {attempt && <div className="row" aria-label="待核对普通整理">
      <button disabled={pending} onClick={() => void run(true)}>核对原普通整理</button>
      <button disabled={pending} onClick={() => void run(false)}>重试原普通整理</button></div>}
    {children}
  </Context.Provider>;
}
