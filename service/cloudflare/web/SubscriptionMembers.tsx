import { Button, Notice } from '@neuro/ui';
import { useState } from "react";
import type { Compose } from "./api";
import type { UnifiedMessageSummary } from "./normal-inbox";
import { NormalMessageDetail } from "./NormalMessageDetail";
import { MessageDetail } from "./MessageDetail";
import { MessageList } from "./MessageList";
import { SubscriptionMethods } from "./SubscriptionMethods";
import { subscriptionMembersPath, type Subscription } from "./subscriptions-api";
import { useSubscriptionPage } from "./useSubscriptionPage";

export function SubscriptionMembers({ item, query, revision, visible, refresh, onCompose, onClose }: {
  item: Subscription; query: string; revision: number; visible: boolean; refresh: () => void; onCompose: Compose; onClose: () => void;
}) {
  const list = useSubscriptionPage<UnifiedMessageSummary>(subscriptionMembersPath(item, query), revision, visible);
  const [selected, setSelected] = useState<UnifiedMessageSummary | null>(null);
  return <section aria-label="订阅成员"><h3>{item.name}</h3>
    <Button type="button" onClick={onClose} variant="quiet" wrap>关闭订阅</Button>
    <SubscriptionMethods key={item.methods.join("\n")} methods={item.methods} />
    {list.error && <Notice role="alert" tone="danger">{list.error}</Notice>}
    <Notice role="status" tone="info">{list.pending ? "读取订阅邮件…" : `已加载 ${list.page?.items.length ?? 0} 封订阅邮件`}</Notice>
    {list.page && <MessageList items={list.page.items} pending={list.pending} onOpen={setSelected} />}
    {list.page?.nextCursor && <Button disabled={list.pending} onClick={list.loadMore} wrap>加载更多订阅邮件</Button>}
    {selected?.sourceKind === "normal" ? <NormalMessageDetail key={`normal:${selected.accountId}:${selected.serverFolderId || "inbox"}:${selected.id}:${revision}`} {...selected} />
      : selected && <MessageDetail key={`temporary:${selected.id}-${revision}`} mailboxId={selected.mailboxId} id={selected.id} onCompose={onCompose}
      onStateChanged={refresh} onLabelsChanged={refresh} onRemoved={() => { setSelected(null); refresh(); }} />}
  </section>;
}
