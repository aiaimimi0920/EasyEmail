import { createContext, useContext, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { api, errorMessage } from "./api";
import type { NormalAccount } from "./normal-accounts";
import { normalInboxPath } from "./normal-inbox";

export type ReplyGuard = MutableRefObject<(() => boolean) | null>;
export interface NormalReplyIntent {
  nonce: string; account: NormalAccount;
  reply: { accountId: string; accountRevision: number; messageId: string; serverFolderId?: string; to: string; subject: string; threading: "available" | "unavailable" };
}
interface ReplyContext {
  guard: ReplyGuard; request: NormalReplyIntent | null; pending: boolean;
  reject: () => void; open: (accountId: string, messageId: string, serverFolderId?: string) => Promise<void>;
}
const Context = createContext<ReplyContext | null>(null);
export function useNormalReply() {
  const value = useContext(Context); if (!value) throw new Error("NormalReplyProvider is required"); return value;
}
export function NormalReplyProvider({ children, onOpen }: { children: ReactNode; onOpen: () => void }) {
  const guard = useRef<(() => boolean) | null>(null), active = useRef<AbortController | null>(null);
  const [request, setRequest] = useState<NormalReplyIntent | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const reject = () => setError("请先处理普通邮箱的未决操作或未保存内容");
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  async function open(accountId: string, messageId: string, serverFolderId = "") {
    if (active.current) return;
    if (!guard.current?.()) { reject(); return; }
    const controller = new AbortController(); active.current = controller; setPending(true); setError("");
    try {
      const preview = await api<Omit<NormalReplyIntent, "nonce">>(`${normalInboxPath(accountId, serverFolderId)}/messages/${messageId}/reply`, "GET", undefined, undefined, controller.signal);
      if (controller.signal.aborted) return;
      if (!guard.current?.()) { reject(); return; }
      if (preview.account.id !== accountId || preview.reply.accountId !== accountId || preview.reply.messageId !== messageId
        || (preview.reply.serverFolderId ?? "") !== serverFolderId || preview.account.revision !== preview.reply.accountRevision) throw new Error("invalid reply preview");
      setRequest({ nonce: crypto.randomUUID(), ...preview }); onOpen();
    } catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (active.current === controller) { active.current = null; setPending(false); } }
  }
  return <Context.Provider value={{ guard, request, pending, reject, open }}>
    {error && <p role="alert">{error}</p>}{pending && <p role="status">正在读取回复来源…</p>}{children}
  </Context.Provider>;
}
export function NormalReplyButton({ accountId, messageId, serverFolderId, disabled }: { accountId: string; messageId: string; serverFolderId?: string; disabled: boolean }) {
  const reply = useNormalReply();
  return <button className="secondary" disabled={disabled || reply.pending} onClick={() => void reply.open(accountId, messageId, serverFolderId)}>回复</button>;
}
