import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type Compose, type Page } from "./api";
import type { UnifiedMessageSummary } from "./normal-inbox";
import { NormalMessageDetail } from "./NormalMessageDetail";
import { MessageDetail } from "./MessageDetail";
import { MessageList } from "./MessageList";
import type { Label } from "./labels-api";
import type { Folder } from "./folders-api";
import { BatchOrganization } from "./BatchOrganization";
import type { OrganizationController } from "./useOrganization";
import { useNormalOrganization } from "./NormalOrganization";
import { useMixedOrganization } from "./MixedOrganization";
import { canOrganizeMessage, messageSelectionKey } from "./mixed-organization-plan";

export function UnifiedInboxResults({ query, onCompose, labels, folders, action, revision, refresh }: {
  query: string; onCompose: Compose; labels: Label[]; folders: Folder[]; action: OrganizationController; revision: number; refresh: () => void;
}) {
  const [page, setPage] = useState<Page<UnifiedMessageSummary> | null>(null), [selected, setSelected] = useState<UnifiedMessageSummary | null>(null);
  const [error, setError] = useState(""), [pending, setPending] = useState(true), [selection, setSelection] = useState<string[]>([]);
  const [pageIds, setPageIds] = useState<string[]>([]), generation = useRef(0), path = `/messages?${query}`;
  const normal = useNormalOrganization(), mixed = useMixedOrganization(), locked = action.locked || normal.locked || mixed.locked;
  useEffect(() => {
    const current = ++generation.current; setPending(true); setError(""); setSelection([]); setPage(null);
    api<Page<UnifiedMessageSummary>>(path).then(value => {
      if (current === generation.current) { setPage(value); setPageIds(value.items.filter(canOrganizeMessage).map(messageSelectionKey)); }
    }).catch(failure => { if (current === generation.current) setError(errorMessage(failure)); })
      .finally(() => { if (current === generation.current) setPending(false); });
    return () => { generation.current++; };
  }, [path, revision]);
  async function more() {
    if (pending || !page?.nextCursor) return; const current = ++generation.current; setPending(true); setError("");
    try {
      const next = await api<Page<UnifiedMessageSummary>>(`${path}&cursor=${encodeURIComponent(page.nextCursor)}`);
      if (current === generation.current) { setPage(old => ({ ...next, items: [...(old?.items ?? []), ...next.items] }));
        setPageIds(next.items.filter(canOrganizeMessage).map(messageSelectionKey)); }
    } catch (failure) { if (current === generation.current) setError(errorMessage(failure)); }
    finally { if (current === generation.current) setPending(false); }
  }
  const batchAction: OrganizationController = { ...action, locked, submit: async (ids, patch) => {
    if (!ids || !patch) return action.submit();
    if (locked) return;
    const targets = page?.items.filter(item => ids.includes(messageSelectionKey(item))) ?? [];
    if (targets.length !== ids.length) { setError("选择的邮件已变化，请刷新列表"); return; }
    if (targets.some(item => !canOrganizeMessage(item))) { setError("邮件来源已变化，请刷新列表"); return; }
    if (patch.trashed === true && !window.confirm(`将选择的 ${targets.length} 封邮件移到平台回收站？不会删除远端邮件。`)) return;
    if (targets.some(item => item.sourceKind === "normal")) return mixed.submit(targets, patch);
    return action.submit(targets.map(item => item.id), patch);
  } };
  return <>
    <div className="row"><button className="secondary" disabled={pending || locked} onClick={refresh}>刷新缓存列表</button>
      <small role="status">{pending ? "读取缓存…" : `已加载 ${page?.items.length ?? 0} 封`}</small></div>
    {error && <p role="alert">{error}</p>}
    <BatchOrganization ids={selection} labels={labels} folders={folders} action={batchAction} disabled={pending || locked}
      selectPage={() => setSelection(pageIds.slice(0, 50))} clear={() => setSelection([])} />
    {page && <MessageList items={page.items} pending={pending || locked} onOpen={setSelected} selection={selection} selectionKey={messageSelectionKey}
      onSelect={(id, checked) => setSelection(old => checked ? [...new Set([...old, id])].slice(0, 50) : old.filter(value => value !== id))} />}
    {page?.nextCursor && <button disabled={pending || locked} onClick={() => void more()}>加载更多聚合邮件</button>}
    {selected?.sourceKind === "normal" ? <NormalMessageDetail key={`${messageSelectionKey(selected)}:${revision}`} {...selected} />
      : selected && <MessageDetail key={`temporary:${selected.id}:${revision}`} mailboxId={selected.mailboxId} id={selected.id}
        onStateChanged={refresh} onLabelsChanged={refresh} onRemoved={() => { setSelected(null); refresh(); }} onCompose={onCompose} />}
  </>;
}
