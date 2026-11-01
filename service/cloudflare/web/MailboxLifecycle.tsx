import { useRef, useState, type FormEvent } from "react";
import { api, dateText, errorMessage, type Mailbox } from "./api";
import { mailboxExpired, useMailboxExpiry } from "./mailbox-expiry";

export function MailboxLifecycle({ mailbox, onSaved }: { mailbox: Mailbox; onSaved: (box: Mailbox) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [address, setAddress] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  useMailboxExpiry([mailbox]);
  const expired = mailboxExpired(mailbox);
  async function change(action: "disable" | "enable" | "release") {
    if (busy.current) return;
    busy.current = true; setPending(true); setError("");
    try {
      const result = await api<{ mailbox: Mailbox }>(`/mailboxes/${mailbox.id}/lifecycle`, "POST",
        { action, ...(action === "release" ? { confirmAddress: address } : {}) });
      onSaved(result.mailbox); setConfirming(false); setAddress("");
    } catch (failure) { setError(errorMessage(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  function release(event: FormEvent) { event.preventDefault(); if (address === mailbox.address) void change("release"); }
  return <section aria-label="邮箱生命周期">
    {mailbox.expiresAt !== null && <p>平台期限：{dateText(mailbox.expiresAt)}</p>}
    {expired && <p role="status">平台访问已到期；不能恢复外部操作，历史缓存仍可读和整理</p>}
    {mailbox.releasedAt !== null ? <p role="status">已释放平台访问；历史缓存保留</p> : <>
      <div className="row">
        <button className="secondary" disabled={pending || expired} onClick={() => change(mailbox.disabled ? "enable" : "disable")}>{mailbox.disabled ? "启用邮箱" : "停用邮箱"}</button>
        <button className="secondary" disabled={pending || confirming} onClick={() => setConfirming(true)}>释放平台访问</button>
      </div>
      {mailbox.disabled && <p role="status">已停用外部操作；历史缓存可读</p>}
      {confirming && <form onSubmit={release}>
        <p>仅清除平台凭据，不删除上游邮箱。平台不会保留可恢复的凭据；供应商支持时，须重新提供有效邮箱凭据验证恢复，地址本身不能恢复访问。历史缓存和发送记录保留，进行中的请求可能完成。已发出的远端删除不会取消，清除凭据后可能无法核对结果。</p>
        <label>确认释放的邮箱地址<input value={address} disabled={pending} onChange={(event) => setAddress(event.target.value)} autoComplete="off" /></label>
        <div className="row"><button disabled={pending || address !== mailbox.address}>确认释放平台访问</button>
          <button type="button" className="secondary" disabled={pending} onClick={() => { setConfirming(false); setAddress(""); }}>取消释放</button></div>
      </form>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
