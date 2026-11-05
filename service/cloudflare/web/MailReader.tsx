import { Button, Notice } from '@neuro/ui';
import { useEffect, useState } from "react";
import { dateText, type Compose, type Mailbox } from "./api";
import { MessageDetail } from "./MessageDetail";
import { MessageList } from "./MessageList";
import { mailboxExpired, useMailboxExpiry } from "./mailbox-expiry";
import { ExtractionPanel } from "./ExtractionPanel";

import { MailboxMessageSearch } from "./MailboxMessageSearch";
import { useMailboxMessages } from "./useMailboxMessages";
import { MessageWorkspace } from './MessageWorkspace';
import { messageSelectionKey } from './mixed-organization-plan';

export function MailReader({ mailbox, onCompose, visible }: { mailbox: Mailbox; onCompose: Compose; visible: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0), [query, setQuery] = useState("");
  const [extracting, setExtracting] = useState(false);
  const { inbox, setInbox, pending, syncing, error, status, sync, loadMore } = useMailboxMessages(mailbox.id, visible, query, refresh);
  useMailboxExpiry([mailbox]);
  const expired = mailboxExpired(mailbox);

  useEffect(() => {
    if (inbox) setSelectedId(old => inbox.items.some(item => item.id === old) ? old : null);
  }, [inbox]);

  const selected = inbox?.items.find(item => item.id === selectedId);
  return <section className="mail-reader" aria-label="单邮箱收件箱"><h2 className="reader-title">收件箱</h2>
    <MessageWorkspace selected={!!selectedId} active={visible} onBack={() => setSelectedId(null)} list={<>
    <div className="row"><Button disabled={pending || extracting || expired || mailbox.paused || mailbox.disabled || mailbox.releasedAt !== null} onClick={() => sync()} wrap>刷新收信</Button>
      {inbox?.sync.nextPage && <Button disabled={pending || extracting || expired || mailbox.paused || mailbox.disabled || mailbox.releasedAt !== null} onClick={() => sync(inbox.sync.nextPage!)} wrap>继续同步下一页</Button>}
      {mailbox.paused && <small>已暂停平台同步</small>}
      <small>最近同步：{dateText(inbox?.sync.syncedAt ?? null)}</small></div>
    <MailboxMessageSearch disabled={syncing || extracting} onSearch={value => { setSelectedId(null); setQuery(value); setRefresh(old => old + 1); }} />
    <small role="status">{pending ? "读取缓存…" : `已加载 ${inbox?.items.length ?? 0} 封缓存邮件`}</small>
    {status && <Notice role="status" tone="info">{status}</Notice>}
    {error && <Notice role="alert" tone="danger">{error}</Notice>}
    {inbox?.sync.error && <Notice role="status" tone="info">同步状态：{inbox.sync.error}</Notice>}
    {inbox && <MessageList items={inbox.items} pending={pending} onOpen={(item) => setSelectedId(item.id)} selectedKey={selected ? messageSelectionKey(selected) : undefined} />}
    {inbox?.nextCursor && <Button disabled={pending} onClick={loadMore} wrap>加载更多邮件</Button>}
    </>} tools={<ExtractionPanel mailboxId={mailbox.id} address={mailbox.address} visible={visible} busy={pending} onBusy={setExtracting}
      usable={!expired && !mailbox.paused && !mailbox.disabled && mailbox.releasedAt === null && mailbox.status === "active"}
      onMatch={() => setRefresh((value) => value + 1)} />}>
    {selectedId && visible && <MessageDetail key={`${selectedId}-${expired}-${mailbox.disabled}-${mailbox.releasedAt}`} mailboxId={mailbox.id} id={selectedId} onCompose={onCompose}
      onRemoved={() => { setSelectedId(null); setInbox((old) => old ? { ...old, items: old.items.filter((item) => item.id !== selectedId) } : old); }} onStateChanged={(state) => {
      setInbox((old) => old ? { ...old, items: old.items.map((item) => item.id === state.id ? { ...item, ...state } : item) } : old);
    }} />}
    </MessageWorkspace>
  </section>;
}
