import { useState } from "react";
import type { Compose } from "./api";
import type { UnifiedMessageSummary } from "./normal-inbox";
import { NormalMessageDetail } from "./NormalMessageDetail";
import { MessageDetail } from "./MessageDetail";
import { MessageList } from "./MessageList";
import { useConversationPage } from "./useConversationPage";

export function ConversationMembers({ id, query, revision, refresh, onCompose, onClose }: {
  id: string; query: string; revision: number; refresh: () => void; onCompose: Compose; onClose: () => void;
}) {
  const list = useConversationPage<UnifiedMessageSummary>(`/conversations/${id}/messages?${query}`, revision);
  const [selected, setSelected] = useState<UnifiedMessageSummary | null>(null);
  return <section aria-label="会话邮件"><h3>会话邮件</h3>
    <button type="button" className="secondary" onClick={onClose}>关闭会话</button>
    {list.error && <p role="alert">{list.error}</p>}
    <p role="status">{list.pending ? "读取会话邮件…" : `已加载 ${list.page?.items.length ?? 0} 封会话邮件`}</p>
    {list.page && <MessageList items={list.page.items} pending={list.pending} onOpen={setSelected} />}
    {list.page?.nextCursor && <button disabled={list.pending} onClick={list.loadMore}>加载更多会话邮件</button>}
    {selected?.sourceKind === "normal" ? <NormalMessageDetail key={`normal:${selected.accountId}:${selected.serverFolderId || "inbox"}:${selected.id}:${revision}`} {...selected} />
      : selected && <MessageDetail key={`temporary:${selected.id}-${revision}`} mailboxId={selected.mailboxId} id={selected.id} onCompose={onCompose}
      onStateChanged={refresh} onLabelsChanged={refresh} onRemoved={() => { setSelected(null); refresh(); }} />}
  </section>;
}
