import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, errorMessage } from "./api";
import type { NormalMail } from "./normal-inbox";
import { remoteFlagRejectedBeforeReservation, runRemoteFlag, type RemoteFlag, type RemoteFlagAttempt } from "./normal-remote-flags";

interface Controller {
  locked: boolean; revision: number;
  submit(message: NormalMail, flag: RemoteFlag, value: boolean, acknowledgedUnknownId: string | null): Promise<void>;
}
const Context = createContext<Controller | null>(null);
export function useNormalRemoteFlags() {
  const value = useContext(Context); if (!value) throw new Error("NormalRemoteFlagsProvider is required"); return value;
}
// Lives above every detail entry point. No local/session storage, automatic POST, or replacement key on failure.
export function NormalRemoteFlagsProvider({ children }: { children: ReactNode }) {
  const held = useRef<RemoteFlagAttempt | null>(null), busy = useRef(false), active = useRef(false), uncertain = useRef(false);
  const [attempt, setAttempt] = useState<RemoteFlagAttempt | null>(null), [pending, setPending] = useState(false), [revision, setRevision] = useState(0);
  const [error, setError] = useState(""), [status, setStatus] = useState("");
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function run(readOnly: boolean, requested?: RemoteFlagAttempt) {
    if (busy.current) return;
    const current = held.current ?? requested; if (!current) return;
    held.current = current; setAttempt(current); busy.current = true; setPending(true); setError(""); setStatus("");
    try {
      const operation = await runRemoteFlag(current, readOnly);
      if (!active.current) return;
      if (operation.state === "pending") { uncertain.current = true; setStatus("远端操作处理中，请只读核对原操作"); return; }
      held.current = null; setAttempt(null); uncertain.current = false; setRevision(value => value + 1);
      setStatus(operation.state === "confirmed" ? "服务器标记已确认" : operation.state === "unknown" ? "原远端操作结果未知，未自动重试" : "本次远端操作未派发");
      if (operation.state === "failed") setError(errorMessage(new ApiError(409, operation.error ?? "remote_flags_target_changed")));
    } catch (failure) {
      if (!active.current) return;
      setError(errorMessage(failure));
      if (!readOnly && !uncertain.current && remoteFlagRejectedBeforeReservation(failure)) {
        held.current = null; setAttempt(null); setRevision(value => value + 1);
      } else uncertain.current = true;
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  return <Context.Provider value={{ locked: attempt !== null, revision,
    submit: (message, flag, value, acknowledgedUnknownId) => run(false, { accountId: message.accountId, messageId: message.id, serverFolderId: message.serverFolderId, key: crypto.randomUUID(),
      body: { expectedRevision: message.accountRevision, epochId: message.epochId, flag, value, acknowledgedUnknownId } }) }}>
    {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
    {attempt && <section aria-label="待核对服务器标记"><p>原请求 <code data-testid="remote-flags-request-key">{attempt.key}</code></p>
      <div className="row"><button disabled={pending} onClick={() => void run(true)}>只读核对原远端操作</button>
        <button className="secondary" disabled={pending} onClick={() => void run(false)}>重送原请求（不重复执行）</button></div></section>}
    {children}
  </Context.Provider>;
}
