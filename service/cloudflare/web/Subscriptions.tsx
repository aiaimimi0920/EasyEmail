import { useState } from "react";
import { dateText, type Compose } from "./api";
import { subscriptionIdentity, type Subscription } from "./subscriptions-api";
import { useNormalOrganization } from "./NormalOrganization";
import { useSubscriptionPage } from "./useSubscriptionPage";
import { useSubscriptionMutation } from "./useSubscriptionMutation";
import { SubscriptionMembers } from "./SubscriptionMembers";

export function Subscriptions({ visible, onCompose }: { visible: boolean; onCompose: Compose }) {
  const [queryInput, setQueryInput] = useState(""), [search, setSearch] = useState(""), [visibility, setVisibility] = useState("active");
  const [sources, setSources] = useState("all"), normal = useNormalOrganization();
  const [revision, setRevision] = useState(0), [selected, setSelected] = useState<Subscription | null>(null);
  const refresh = () => setRevision(old => old + 1), action = useSubscriptionMutation(() => { setSelected(null); refresh(); });
  const query = new URLSearchParams({ sources, folder: "all", visibility, q: search }).toString(), pageRevision = revision + normal.revision;
  const list = useSubscriptionPage<Subscription>(`/subscriptions?${query}`, pageRevision, visible);
  const item = selected && !list.error && (list.page?.items.find(row => subscriptionIdentity(row) === subscriptionIdentity(selected)) ?? (list.pending ? selected : null));
  return <section className="card" aria-label="订阅管理"><h2>订阅邮件</h2>
    <form className="row" onSubmit={event => { event.preventDefault(); if (action.locked) return; setSearch(queryInput); setSelected(null); refresh(); }}>
      <label>搜索订阅邮件<input value={queryInput} maxLength={160} disabled={action.locked} onChange={event => setQueryInput(event.target.value)} /></label>
      <label>订阅来源<select aria-label="订阅来源" value={sources} disabled={action.locked} onChange={event => { setSources(event.target.value); setSelected(null); }}>
        <option value="all">全部邮箱</option><option value="temporary">临时邮箱</option><option value="normal">普通邮箱</option>
      </select></label>
      <label>订阅可见性<select aria-label="订阅可见性" value={visibility} disabled={action.locked} onChange={event => { setVisibility(event.target.value); setSelected(null); }}>
        <option value="active">可见</option><option value="hidden">已隐藏</option><option value="all">全部</option>
      </select></label>
      <button disabled={list.pending || action.locked}>搜索订阅</button>
      <button type="button" className="secondary" disabled={list.pending || action.locked} onClick={refresh}>刷新订阅</button>
    </form>
    <small>隐藏仅影响平台列表，不会停止收件或代为退订。</small>
    {action.error && <p role="alert">{action.error}</p>}
    {action.attempt && <p>订阅操作键：<code data-testid="subscription-operation-key">{action.attempt.key}</code></p>}
    {action.locked && !action.pending && <button onClick={() => action.submit()}>核对原订阅操作</button>}
    {action.locked && !action.pending && <button onClick={() => action.submit(undefined, true)}>只读核对原订阅操作</button>}
    {list.error && <p role="alert">{list.error}</p>}
    <p role="status">{list.pending ? "读取订阅…" : `已加载 ${list.page?.items.length ?? 0} 个订阅`}</p>
    <ul>{list.page?.items.map(row => <li key={subscriptionIdentity(row)}><div>
      <button type="button" className="secondary" disabled={list.pending} onClick={() => setSelected(row)}>查看订阅 {row.name}</button>
      <small>{row.messageCount} 封 · {row.unreadCount} 封未读 · 版本 {row.version}</small>
      <small>{row.latest.mailboxDisplayName || row.latest.mailboxAddress} · {dateText(row.latest.receivedAt)}{row.limited ? " · 部分订阅头或退订方法不可用" : ""}</small>
      {row.latest.sourceKind === "normal" && row.latest.serverFolderId && <small>{row.latest.serverFolderName || "服务器文件夹"}</small>}
      <button type="button" className="secondary" disabled={list.pending || action.locked} onClick={() => action.submit(row)}>{row.hidden ? "恢复" : "隐藏"}订阅 {row.name}</button>
    </div></li>)}</ul>
    {!list.pending && list.page?.items.length === 0 && <p>暂无匹配的订阅</p>}
    {list.page?.nextCursor && <button disabled={list.pending || action.locked} onClick={list.loadMore}>加载更多订阅</button>}
    {item && <SubscriptionMembers key={`${subscriptionIdentity(item)}:${query}`} item={item} query={query} revision={pageRevision} visible={visible} refresh={refresh}
      onCompose={onCompose} onClose={() => setSelected(null)} />}
  </section>;
}
