import { Button, Checkbox, Field, Input, Notice, Panel, Textarea } from '@neuro/ui';
import { useId, useRef, useState, type FormEvent } from "react";
import { api, errorMessage, type Mailbox } from "./api";
import { MailboxLifecycle } from "./MailboxLifecycle";
import { MailboxRemoteDeletion } from "./MailboxRemoteDeletion";

export function MailboxSettings({ mailbox, onSaved }: { mailbox: Mailbox; onSaved: (box: Mailbox) => void }) {
  const [displayName, setDisplayName] = useState(mailbox.displayName);
  const [note, setNote] = useState(mailbox.note);
  const [favorite, setFavorite] = useState(mailbox.favorite);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const busy = useRef(false);
  const noteId = useId();

  async function patch(fields: Partial<Pick<Mailbox, "displayName" | "note" | "favorite" | "paused">>) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(""); setStatus("");
    try {
      const result = await api<{ mailbox: Mailbox }>(`/mailboxes/${mailbox.id}`, "PATCH", fields);
      onSaved(result.mailbox);
      if (fields.displayName !== undefined) setDisplayName(result.mailbox.displayName);
      setStatus(fields.paused === undefined ? "已保存" : result.mailbox.paused ? "已暂停平台同步" : "已恢复平台同步");
    } catch (failure) { setError(errorMessage(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  function save(event: FormEvent) { event.preventDefault(); void patch({ displayName, note, favorite }); }

  return <Panel className="card" aria-label="邮箱设置"><h2>邮箱设置</h2><code>{mailbox.address}</code>
    <form onSubmit={save}>
      <div className="row"><Field label="邮箱名称"><Input maxLength={80} value={displayName} disabled={pending} onChange={(event) => setDisplayName(event.target.value)} /></Field>
        <Checkbox checked={favorite} disabled={pending} onChange={(event) => setFavorite(event.target.checked)} label="收藏邮箱" /></div>
      <Field label="邮箱备注"><Textarea id={noteId} maxLength={1000} value={note} disabled={pending} onChange={(event) => setNote(event.target.value)} /></Field>
      <div className="row"><Button disabled={pending} type="submit" wrap>保存邮箱设置</Button>
        <Button type="button" disabled={pending} onClick={() => patch({ paused: !mailbox.paused })} variant="quiet" wrap>{mailbox.paused ? "恢复平台同步" : "暂停平台同步"}</Button></div>
    </form>
    {status && <Notice role="status" tone="info">{status}</Notice>}{error && <Notice role="alert" tone="danger">{error}</Notice>}
    <MailboxLifecycle mailbox={mailbox} onSaved={onSaved} />
    <MailboxRemoteDeletion mailbox={mailbox} onSaved={onSaved} />
  </Panel>;
}
