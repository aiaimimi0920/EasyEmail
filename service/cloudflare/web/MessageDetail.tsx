import { Button, Notice } from '@neuro/ui';
import { useEffect, useRef, useState } from "react";
import { api, dateText, errorMessage, type Compose, type Message, type MessageState } from "./api";
import { SafeMailBody } from "./SafeMailBody";
import { AttachmentList } from "./AttachmentList";
import { MessageLifecycle } from "./MessageLifecycle";
import { RemoteDeletion } from "./RemoteDeletion";
import { MessageLabels } from "./MessageLabels";
import { MessageFolder } from "./MessageFolder";

export function MessageDetail({ mailboxId, id, onStateChanged, onRemoved, onCompose, onLabelsChanged }: {
  mailboxId: string; id: string; onStateChanged: (state: MessageState) => void; onRemoved: () => void; onCompose: Compose;
  onLabelsChanged?: () => void;
}) {
  const [message, setMessage] = useState<Message | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const busy = useRef(false);
  const path = `/mailboxes/${mailboxId}/messages/${id}`;

  useEffect(() => {
    let current = true;
    active.current = true;
    api<{ message: Message }>(path).then((value) => { if (current) setMessage(value.message); })
      .catch((failure) => { if (current) setError(errorMessage(failure)); });
    return () => { current = false; active.current = false; };
  }, [path]);

  async function patch(fields: Partial<Omit<MessageState, "id">>) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError("");
    try {
      const result = await api<{ state: MessageState }>(path, "PATCH", fields);
      if (active.current) { setMessage((old) => old ? { ...old, ...result.state } : old); onStateChanged(result.state); }
    } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }

  return <article className="message-detail" aria-label="邮件详情">
    {error && <Notice role="alert" tone="danger">{error}</Notice>}
    {!message && !error && <Notice role="status" tone="info">读取邮件…</Notice>}
    {message && <>
      <h3>{message.subject || "（无主题）"}</h3><p className="message-addresses">{message.sender} → {message.recipient}</p>
      <small>{dateText(message.receivedAt)}</small>
      <div className="row">
        <Button disabled={!message.replyAddress} onClick={() => onCompose(mailboxId, message)} variant="quiet" wrap>回复</Button>
        <Button disabled={pending} onClick={() => patch({ isRead: !message.isRead })} variant="quiet" wrap>{message.isRead ? "标为未读" : "标为已读"}</Button>
        <Button disabled={pending} onClick={() => patch({ starred: !message.starred })} variant="quiet" wrap>{message.starred ? "取消星标" : "加星标"}</Button>
        <Button disabled={pending} onClick={() => patch({ archived: !message.archived })} variant="quiet" wrap>{message.archived ? "移回收件箱" : "归档"}</Button>
      </div>
      <SafeMailBody key={path} text={message.textBody} html={message.htmlBody} />
      <MessageLabels key={`labels-${path}`} path={path} id={id} onChanged={onLabelsChanged} />
      <MessageFolder key={`folder-${path}`} path={path} id={id} onChanged={onLabelsChanged} />
      <AttachmentList key={`attachments-${path}`} path={path} items={message.attachments} truncated={message.attachmentsTruncated} />
      <MessageLifecycle key={`lifecycle-${path}`} path={path} id={id} trashed={message.trashedAt !== null} onRemoved={onRemoved} />
      <RemoteDeletion key={`remote-${path}`} path={path} id={id} address={message.recipient} available={message.remoteDeleteAvailable} />
    </>}
  </article>;
}
