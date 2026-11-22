import { Button, Field, Input, Notice } from '@neuro/ui';
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorMessage, type Deletion } from "./api";

const STATES: Record<string, string> = { pending: "远端删除请求处理中", unknown: "远端删除结果未知，请核对原操作",
  deleted: "源邮件已删除；平台缓存保留", absent: "上游已无该邮件；不能证明由本次删除", changed: "源邮件版本已变化；未删除新版本" };

export function RemoteDeletion({ path, id, address, available }: { path: string; id: string; address: string; available: boolean }) {
  const [deletion, setDeletion] = useState<Deletion | null>(null), [loaded, setLoaded] = useState(false);
  const [confirming, setConfirming] = useState(false), [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const active = useRef(false), busy = useRef(false), key = useRef(crypto.randomUUID());
  const endpoint = `${path}/remote-delete`;
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    api<{ deletion: Deletion | null }>(endpoint, "GET", undefined, undefined, controller.signal)
      .then((result) => { if (active.current) { setDeletion(result.deletion); setLoaded(true); } })
      .catch((failure) => { if (active.current) setError(errorMessage(failure)); });
    return () => { active.current = false; controller.abort(); };
  }, [endpoint]);

  async function change(action: "delete" | "check" | "refresh") {
    if (busy.current) return;
    busy.current = true; setPending(true); setError("");
    try {
      const result = await api<{ deletion: Deletion | null }>(action === "check" ? `${endpoint}/check` : endpoint,
        action === "refresh" ? "GET" : "POST", action === "delete" ? { confirmAddress: confirmation, confirmMessageId: id }
          : action === "check" ? {} : undefined, action === "delete" ? { "idempotency-key": key.current } : undefined);
      if (active.current) { setDeletion(result.deletion); setLoaded(true); setConfirming(false); setConfirmation(""); }
    } catch (failure) {
      if (active.current) { setError(errorMessage(failure)); if (action === "delete") setLoaded(false); }
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); if (confirmation === address) void change("delete"); }
  return <section aria-label="远端邮件删除">
    {deletion && <Notice role="status" tone="info">{STATES[deletion.state]}</Notice>}
    {deletion && ["pending", "unknown"].includes(deletion.state) &&
      <Button disabled={pending} onClick={() => change("check")} variant="quiet" wrap>核对远端结果</Button>}
    {!deletion && available && loaded && !confirming &&
      <Button disabled={pending} onClick={() => setConfirming(true)} variant="quiet" wrap>删除上游邮件</Button>}
    {!deletion && confirming && loaded && <form onSubmit={submit}>
      <p>将永久删除此版本的源邮件，无法恢复；平台缓存保留。</p>
      <Field label="确认远端删除的邮箱地址"><Input value={confirmation} maxLength={320} autoComplete="off" disabled={pending} onChange={(event) => setConfirmation(event.target.value)} /></Field>
      <div className="row"><Button disabled={pending || confirmation !== address} type="submit" wrap>确认删除上游邮件</Button>
        <Button type="button" disabled={pending} onClick={() => { setConfirming(false); setConfirmation(""); }} variant="quiet" wrap>取消远端删除</Button></div>
    </form>}
    {!loaded && error && <Button disabled={pending} onClick={() => change("refresh")} variant="quiet" wrap>刷新删除记录</Button>}
    {error && <Notice role="alert" tone="danger">{error}</Notice>}
  </section>;
}
