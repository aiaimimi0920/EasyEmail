import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, errorMessage } from "./api";
import type { NormalMail } from "./normal-inbox";
import type { RemoteMutationAttempt, RemoteMutationBody } from "./normal-remote-mutation-model";
import { remoteMutationRejectedBeforeReservation, runRemoteMutation } from "./normal-remote-mutations";

interface Controller {
  locked: boolean; revision: number;
  submit(message: NormalMail, body: RemoteMutationBody, destinationName?: string): Promise<void>;
}
const Context = createContext<Controller | null>(null);
export function useNormalRemoteMutations() {
  const value = useContext(Context); if (!value) throw new Error("NormalRemoteMutationsProvider is required"); return value;
}
// The request owner outlives detail navigation. No persistence of mail data, automatic POST, replacement key, or unknown acknowledgement.
export function NormalRemoteMutationsProvider({ children }: { children: ReactNode }) {
  const held = useRef<RemoteMutationAttempt | null>(null), busy = useRef(false), active = useRef(false);
  const [attempt, setAttempt] = useState<RemoteMutationAttempt | null>(null), [pending, setPending] = useState(false), [revision, setRevision] = useState(0);
  const [error, setError] = useState(""), [status, setStatus] = useState("");
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function run(readOnly: boolean, requested?: RemoteMutationAttempt) {
    if (busy.current || (!readOnly && held.current)) return;
    const current = readOnly ? held.current : requested; if (!current) return;
    held.current = current; setAttempt(current); busy.current = true; setPending(true); setError(""); setStatus("");
    try {
      const operation = await runRemoteMutation(current, readOnly);
      if (!active.current) return;
      setRevision(value => value + 1);
      if (operation.state === "pending" || operation.state === "unknown") {
        setStatus(operation.state === "pending" ? "原服务器移动／删除仍在处理中，仅可只读核对" : "原服务器移动／删除结果未知，禁止重新执行"); return;
      }
      held.current = null; setAttempt(null);
      setStatus(operation.state === "confirmed" ? "服务器移动／删除已确认；平台缓存保留，目标邮件须另行显式同步" : "本次服务器移动／删除未派发");
      if (operation.state === "failed") setError(errorMessage(new ApiError(409, operation.error ?? "remote_mutation_target_changed")));
    } catch (failure) {
      if (!active.current) return;
      setError(errorMessage(failure));
      if (!readOnly && remoteMutationRejectedBeforeReservation(failure)) { held.current = null; setAttempt(null); }
      setRevision(value => value + 1);
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  return <Context.Provider value={{ locked: attempt !== null, revision,
    submit: (message, body, destinationName) => run(false, { accountId: message.accountId, messageId: message.id, serverFolderId: message.serverFolderId,
      uid: message.uid, key: crypto.randomUUID(), body: structuredClone(body), sourceName: message.serverFolderName || "INBOX", subject: message.subject, destinationName }) }}>
    {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
    {attempt && <section aria-label="待核对服务器移动或删除"><p>{attempt.subject || "（无主题）"} · {attempt.sourceName} → {attempt.body.action === "delete" ? "永久删除" : attempt.destinationName}</p>
      <p>原请求 <code data-testid="remote-mutation-request-key">{attempt.key}</code></p>
      <button disabled={pending} onClick={() => void run(true)}>只读核对原移动／删除</button></section>}
    {children}
  </Context.Provider>;
}
