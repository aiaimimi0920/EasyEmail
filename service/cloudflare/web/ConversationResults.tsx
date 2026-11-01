import { useState } from "react";
import { dateText, type Compose } from "./api";
import { conversationKey, conversationMemberQuery, type Conversation } from "./conversations-api";
import { useConversationPage } from "./useConversationPage";
import { ConversationMembers } from "./ConversationMembers";

const basis = { headers: "邮件头关联", subject: "主题分组", single: "独立邮件" };
export function ConversationResults({ query, revision, refresh, onCompose }: { query: string; revision: number; refresh: () => void; onCompose: Compose }) {
  const list = useConversationPage<Conversation>(`/conversations?${query}`, revision), [selected, setSelected] = useState<Conversation | null>(null);
  return <section aria-label="会话列表">
    <button type="button" className="secondary" disabled={list.pending} onClick={refresh}>刷新会话列表</button>
    <p role="status">{list.pending ? "读取会话…" : `已加载 ${list.page?.items.length ?? 0} 个会话`}</p>
    {list.error && <p role="alert">{list.error}</p>}
    <ul>{list.page?.items.map(item => <li key={conversationKey(item)}><div>
      <button type="button" className="secondary" disabled={list.pending} onClick={() => setSelected(item)}>打开会话 {item.latest.subject || "（无主题）"}</button>
      <small>{item.messageCount} 封 · {item.unreadCount} 封未读{item.starred ? " · 星标" : ""} · {basis[item.basis]}{item.limited ? " · 部分邮件头不可用" : ""}</small>
      <small>{item.latest.mailboxDisplayName || item.latest.mailboxAddress} · {dateText(item.latest.receivedAt)}</small>
      {item.latest.sourceKind === "normal" && item.latest.serverFolderId && <small>{item.latest.serverFolderName || "服务器文件夹"}</small>}
    </div></li>)}</ul>
    {!list.pending && list.page?.items.length === 0 && <p>暂无匹配的会话</p>}
    {list.page?.nextCursor && <button disabled={list.pending} onClick={list.loadMore}>加载更多会话</button>}
    {selected && <ConversationMembers key={`${conversationKey(selected)}-${query}`} id={selected.id} query={conversationMemberQuery(selected, query)} revision={revision} refresh={refresh}
      onCompose={onCompose} onClose={() => setSelected(null)} />}
  </section>;
}
