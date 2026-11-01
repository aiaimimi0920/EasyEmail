import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import type { NormalAccount } from "./normal-accounts";
import { readAgentSenderAccount } from "./agent-sender-options";

interface Attempt { kind: "start" | "disconnect"; accountId: string; revision: number; key: string }
export function GoogleAuthorization<A extends Omit<NormalAccount, "deleted">>({ account, disabled, canAct, onBusy, onAccount, scope = "normal" }: {
  account: A; disabled: boolean; canAct(): boolean; onBusy(value: boolean): void; onAccount(value: A): void; scope?: "normal" | "agent";
}) {
  const [pending, setPending] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [status, setStatus] = useState("unknown");
  const attempt = useRef<Attempt | null>(null), busy = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setError(""); setNotice(""); }, [account.id]);
  useEffect(() => {
    const controller = new AbortController(); setStatus("unknown");
    void api<{ state: string }>(`/${scope}-accounts/${account.id}/oauth/google/status`, "GET", undefined, undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) setStatus(result.state); }).catch(() => {});
    return () => controller.abort();
  }, [scope, account.id, account.revision, account.testError]);
  async function run(kind: Attempt["kind"]) {
    if (busy.current || (!attempt.current && (disabled || !canAct()))) return;
    if (!attempt.current && kind === "disconnect" && !window.confirm("仅在 EasyEmail 断开授权并停用 IMAP/SMTP？如需撤销 Google 权限，请另到 Google 账号的第三方连接页面操作。")) return;
    const current = attempt.current ?? { kind, accountId: account.id, revision: account.revision, key: crypto.randomUUID() };
    attempt.current = current; busy.current = true; setPending(true); setError(""); setNotice(""); onBusy(true);
    try {
      const result = await api<{ authorizationUrl?: string; account?: A }>(`/${scope}-accounts/${current.accountId}/oauth/google/${current.kind}`,
        "POST", { expectedRevision: current.revision }, { "idempotency-key": current.key });
      if (!alive.current) return;
      if (current.kind === "start") {
        const url = new URL(result.authorizationUrl ?? "");
        if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth") throw new Error("授权地址无效");
        window.location.assign(url.href); return;
      }
      if (!result.account || result.account.id !== current.accountId) throw new ApiError(502, "google_oauth_response_invalid");
      if (scope === "agent") readAgentSenderAccount(result.account, current.accountId);
      attempt.current = null; setUncertain(false); onAccount(result.account); setNotice("已在 EasyEmail 断开；尚未撤销 Google 端权限");
    } catch (failure) {
      if (!alive.current) return;
      setError(errorMessage(failure));
      if (!uncertain && failure instanceof ApiError && failure.status < 500) { attempt.current = null; setUncertain(false); }
      else setUncertain(true);
    } finally {
      busy.current = false; if (alive.current) { setPending(false); onBusy(!!attempt.current); }
    }
  }
  return <section aria-label="Google 邮箱授权"><h3>Google 授权</h3>
    <p>{({ active: "已保存 Google 授权", reauthorize: "需要重新授权", disconnected: "已断开", not_authorized: "尚未授权" }[status] ?? "授权状态待确认")}；无需提供 Google 密码</p>
    <button disabled={disabled || pending || uncertain} onClick={() => void run("start")}>{account.credentialConfigured ? "重新授权 Google" : "授权 Google 邮箱"}</button>
    <button className="danger" disabled={disabled || pending || uncertain} onClick={() => void run("disconnect")}>断开 Google 授权（仅本地）</button>
    {uncertain && <button disabled={pending} onClick={() => void run(attempt.current!.kind)}>核对原授权操作</button>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
