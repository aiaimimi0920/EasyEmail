import { useCallback, useEffect, useState } from "react";
import { api, dateText, errorMessage, type Compose, type Mailbox, type Page } from "./api";
import { MailReader } from "./MailReader";
import { MailboxSettings } from "./MailboxSettings";
import { mailboxExpired, useMailboxExpiry } from "./mailbox-expiry";
import { MailboxAllocation } from "./MailboxAllocation";
import { MailboxAccessRecovery } from './MailboxAccessRecovery';

export function Mailboxes({ onCompose, visible }: { onCompose: Compose; visible: boolean }) {
  const [page, setPage] = useState<Page<Mailbox>>({ items: [], nextCursor: null });
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<Mailbox | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useMailboxExpiry(page.items);
  const created = useCallback((mailbox: Mailbox) => { setSelected(mailbox); setRefresh((value) => value + 1); }, []);
  const refreshed = useCallback(() => setRefresh((value) => value + 1), []);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setLoading(true);
    api<Page<Mailbox>>("/mailboxes")
      .then((mail) => { if (active) {
        setPage(mail);
        setSelected((old) => old ? mail.items.find((item) => item.id === old.id) ?? old : null);
      } })
      .catch((failure) => { if (active) setError(errorMessage(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [visible, refresh]);

  async function openMailbox(id: string) {
    setPending(true); setError("");
    try { setSelected((await api<{ mailbox: Mailbox }>(`/mailboxes/${id}`)).mailbox); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  async function loadMore() {
    setPending(true);
    try {
      const next = await api<Page<Mailbox>>(`/mailboxes?cursor=${page.nextCursor}`);
      setPage({ items: [...page.items, ...next.items], nextCursor: next.nextCursor });
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  return <>
    <section className="card"><h2>邮箱</h2>
      <MailboxAllocation visible={visible} onCreated={created} onRefresh={refreshed} />
      <MailboxAccessRecovery visible={visible} onRecovered={async receipt => {
        const result = await api<{ mailbox: Mailbox }>(`/mailboxes/${receipt.mailboxId}`);
        if (result.mailbox.id !== receipt.mailboxId || result.mailbox.address !== receipt.address || result.mailbox.providerId !== receipt.providerId) {
          throw new Error('mailbox_recovery_response_invalid');
        }
        created(result.mailbox);
      }} />
      {error && <p role="alert">{error}</p>}
      <ul>{page.items.map((mailbox) => <li key={mailbox.id}>
        <div>{mailbox.displayName && <strong>{mailbox.displayName}</strong>}
          <button className="secondary" disabled={pending || loading} onClick={() => openMailbox(mailbox.id)}>{mailbox.address}</button>
          <small>{mailbox.favorite ? "已收藏 · " : ""}{mailbox.releasedAt !== null ? "已释放平台访问" : mailboxExpired(mailbox) ? "平台访问已到期" : mailbox.disabled ? "已停用" : mailbox.paused ? "已暂停平台同步" : mailbox.status}</small>
          {mailbox.expiresAt !== null && <small>平台期限：{dateText(mailbox.expiresAt)}</small>}</div>
      </li>)}</ul>
      {page.items.length === 0 && <p>暂无邮箱</p>}
      {page.nextCursor && <button disabled={pending || loading} onClick={loadMore}>加载更多邮箱</button>}
    </section>
    {selected && <fieldset disabled={loading || pending}>
      <button className="secondary" disabled={mailboxExpired(selected) || selected.disabled || selected.releasedAt !== null || selected.status !== "active"} onClick={() => onCompose(selected.id)}>用此邮箱写信</button>
      <MailboxSettings key={`settings-${selected.id}`} mailbox={selected} onSaved={(box) => {
        setPage((old) => ({ ...old, items: old.items.map((item) => item.id === box.id ? box : item) }));
        setSelected((old) => old?.id === box.id ? box : old);
      }} />
      <MailReader key={`reader-${selected.id}`} mailbox={selected} visible={visible} onCompose={onCompose} />
    </fieldset>}
  </>;
}
