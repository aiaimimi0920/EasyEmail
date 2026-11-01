import { useState } from "react";
import type { NormalAccount } from "./normal-accounts";
import type { NormalAggregateSummary, NormalMailSummary } from "./normal-inbox";
import type { Label } from "./labels-api";
import type { Folder } from "./folders-api";
import type { OrganizationController } from "./useOrganization";
import { useNormalOrganization } from "./NormalOrganization";
import { BatchOrganization } from "./BatchOrganization";
import { MessageList } from "./MessageList";

export function NormalInboxMessages({ account, items, pageIds, labels, folders, disabled, onOpen, serverFolderId }: {
  account: NormalAccount; items: NormalMailSummary[]; pageIds: string[]; labels: Label[]; folders: Folder[];
  disabled: boolean; onOpen: (id: string) => void; serverFolderId?: string;
}) {
  const action = useNormalOrganization(), [selection, setSelection] = useState<string[]>([]), [error, setError] = useState("");
  const locked = disabled || action.locked;
  const controller: OrganizationController = { locked, pending: false, error: "", status: "", key: undefined, submit: async (ids, patch) => {
    if (locked || !ids?.length || !patch) return;
    if (ids.length > 50 || ids.some(id => !items.some(item => item.id === id && item.accountId === account.id && item.serverFolderId === serverFolderId))) {
      setError("选择的邮件已变化，请刷新列表"); return;
    }
    if (patch.trashed === true && !window.confirm(`将选择的 ${ids.length} 封邮件移到平台回收站？不会删除服务器上的邮件。`)) return;
    setError(""); await action.submit(account.id, ids, patch, serverFolderId);
  } };
  const messages: NormalAggregateSummary[] = items.map(item => ({ ...item, sourceKind: "normal", mailboxAddress: account.emailAddress, mailboxDisplayName: account.displayName }));
  return <>
    {error && <p role="alert">{error}</p>}
    <BatchOrganization ids={selection} labels={labels} folders={folders} action={controller} disabled={locked}
      selectPage={() => setSelection(pageIds.slice(0, 50))} clear={() => setSelection([])} />
    {messages.length > 0 ? <MessageList items={messages} pending={locked} onOpen={item => onOpen(item.id)} selection={selection} selectionKey={item => item.id}
      onSelect={(id, checked) => setSelection(old => checked ? [...new Set([...old, id])].slice(0, 50) : old.filter(value => value !== id))} />
      : <p>暂无缓存邮件</p>}
  </>;
}
