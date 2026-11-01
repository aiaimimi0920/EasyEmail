import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorMessage, type Mailbox, type MailboxDeletion } from "./api";
import { mailboxExpired } from "./mailbox-expiry";

const STATES: Record<string, string> = {
  pending: "远端邮箱删除请求处理中", unknown: "远端邮箱删除结果未知，请核对原操作",
  deleted: "上游邮箱的 D1 数据已删除；平台缓存保留",
  absent: "上游地址已不存在；不能证明由本次删除；平台访问已释放",
  changed: "邮箱代际已变化，未删除替代邮箱；平台访问已释放",
};
export function MailboxRemoteDeletion({ mailbox, onSaved }: { mailbox: Mailbox; onSaved: (box: Mailbox) => void }) {
  const [deletion, setDeletion] = useState<MailboxDeletion | null>(null), [available, setAvailable] = useState(false);
  const [loaded, setLoaded] = useState(false), [confirming, setConfirming] = useState(false), [address, setAddress] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const active = useRef(false), busy = useRef(false), key = useRef(crypto.randomUUID());
  const endpoint = `/mailboxes/${mailbox.id}/remote-delete`;
  useEffect(() => {
    active.current = true; const controller = new AbortController();
    api<{ deletion: MailboxDeletion | null; available?: boolean }>(endpoint, "GET", undefined, undefined, controller.signal)
      .then((result) => { if (active.current) { setDeletion(result.deletion); setAvailable(result.available === true); setLoaded(true); } })
      .catch((failure) => { if (active.current) setError(errorMessage(failure)); });
    return () => { active.current = false; controller.abort(); };
  }, [endpoint]);
  async function change(action: "delete" | "check" | "refresh") {
    if (busy.current) return;
    busy.current = true; setPending(true); setError("");
    try {
      const result = await api<{ deletion: MailboxDeletion | null; available?: boolean }>(action === "check" ? `${endpoint}/check` : endpoint,
        action === "refresh" ? "GET" : "POST", action === "delete" ? { confirmAddress: address, confirmMailboxId: mailbox.id }
          : action === "check" ? {} : undefined, action === "delete" ? { "idempotency-key": key.current } : undefined);
      if (active.current) { setDeletion(result.deletion); setAvailable(result.available === true); setLoaded(true); setConfirming(false); setAddress(""); }
      const current = await api<{ mailbox: Mailbox }>(`/mailboxes/${mailbox.id}`);
      if (active.current) onSaved(current.mailbox);
    } catch (failure) { if (active.current) { setError(errorMessage(failure)); if (action === "delete") setLoaded(false); } }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); if (address === mailbox.address) void change("delete"); }
  const credentialGone = mailbox.releasedAt !== null || mailbox.expiredAt !== null;
  return <section aria-label="远端邮箱删除">
    {deletion && <p role="status">{STATES[deletion.state]}</p>}
    {deletion && ["pending", "unknown"].includes(deletion.state) && <>
      <button className="secondary" disabled={pending || credentialGone} onClick={() => change("check")}>核对远端邮箱结果</button>
      {credentialGone && <p role="status">平台凭据已清除，无法继续核对上游结果</p>}
    </>}
    {!deletion && loaded && available && !credentialGone && !mailboxExpired(mailbox) && !confirming &&
      <button className="secondary" disabled={pending} onClick={() => setConfirming(true)}>删除上游邮箱</button>}
    {!deletion && loaded && confirming && <form onSubmit={submit}>
      <p>永久删除此代际的上游地址及 D1 邮件数据，无法撤销；平台缓存保留，不清理外部 KV/S3 副本。</p>
      <label>确认删除上游邮箱的地址<input value={address} maxLength={320} autoComplete="off" disabled={pending}
        onChange={(event) => setAddress(event.target.value)} /></label>
      <div className="row"><button disabled={pending || address !== mailbox.address}>确认删除上游邮箱</button>
        <button type="button" className="secondary" disabled={pending} onClick={() => { setConfirming(false); setAddress(""); }}>取消删除上游邮箱</button></div>
    </form>}
    {!loaded && error && <button className="secondary" disabled={pending} onClick={() => change("refresh")}>刷新远端邮箱删除记录</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
