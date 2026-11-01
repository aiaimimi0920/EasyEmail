import { dateText } from "./api";
import type { UnifiedMessageSummary } from "./normal-inbox";
import { canOrganizeMessage, messageSelectionKey } from "./mixed-organization-plan";

export function MessageList<T extends UnifiedMessageSummary>({ items, pending, onOpen, selection, onSelect, selectionKey }: {
  items: T[]; pending: boolean; onOpen: (message: T) => void;
  selection?: string[]; onSelect?: (id: string, checked: boolean) => void;
  selectionKey?: (message: T) => string;
}) {
  return <>
    <ul>{items.map((item) => { const id = selectionKey ? selectionKey(item) : item.id; return <li key={messageSelectionKey(item)}>
      {onSelect && canOrganizeMessage(item) && (selectionKey || item.sourceKind !== "normal") && <label className="check"><input type="checkbox" aria-label={`选择邮件 ${item.subject || "（无主题）"}`}
        checked={selection?.includes(id) ?? false} disabled={pending || (!selection?.includes(id) && (selection?.length ?? 0) >= 50)}
        onChange={event => onSelect(id, event.target.checked)} /></label>}
      <div><button className="secondary" disabled={pending} onClick={() => onOpen(item)}>{item.subject || "（无主题）"}</button>
        <small>{item.sender} · {dateText(item.receivedAt)} · {item.sourceKind === "normal" ? `普通邮箱 · 平台${item.platformState.isRead ? "已读" : "未读"}${item.platformState.starred ? " · 星标" : ""}${item.platformState.archived ? " · 已归档" : ""}${item.platformState.trashedAt !== null ? " · 回收站" : ""}`
          : `${item.isRead ? "已读" : "未读"}${item.starred ? " · 星标" : ""}${item.archived ? " · 已归档" : ""}`}</small>
        {item.mailboxAddress && <small>{item.mailboxDisplayName || item.mailboxAddress}{item.sourceKind === "normal" ? ` · ${item.mailboxAddress}` : ` · ${item.providerId}`}</small>}
        {item.sourceKind === "normal" && item.serverFolderId && <small>{item.serverFolderName || "服务器文件夹"}</small>}
      </div>
    </li>; })}</ul>
    {items.length === 0 && <p>暂无匹配的缓存邮件</p>}
  </>;
}
