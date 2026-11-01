import { useEffect, useState } from "react";
import { api, dateText, errorMessage, type Page } from "./api";
import { creationStateText, type Creation } from "./creation-api";

interface Props {
  visible: boolean; refresh: number; pending: boolean; lockedKey?: string;
  onSelect: (row: Creation) => Promise<void>; onRecover: (row: Creation | null) => void;
}

export function CreationHistory({ visible, refresh, pending, lockedKey, onSelect, onRecover }: Props) {
  const [page, setPage] = useState<Page<Creation>>({ items: [], nextCursor: null });
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  useEffect(() => {
    if (!visible) return;
    let active = true;
    setLoading(true); setError("");
    Promise.all([api<Page<Creation>>("/mailbox-creations"), api<Page<Creation>>("/mailbox-creations?state=unresolved&limit=1")])
      .then(([result, unresolved]) => { if (active) { setPage(result); onRecover(unresolved.items[0] ?? null); } })
      .catch((failure) => { if (active) setError(errorMessage(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [visible, refresh, onRecover]);

  async function more() {
    setLoading(true); setError("");
    try {
      const next = await api<Page<Creation>>(`/mailbox-creations?cursor=${page.nextCursor}`);
      setPage((old) => ({ items: [...old.items, ...next.items.filter((item) => !old.items.some((row) => row.id === item.id))], nextCursor: next.nextCursor }));
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setLoading(false); }
  }

  return <section aria-label="创建历史">
    <h3>创建历史</h3>
    {error && <p role="alert">{error}</p>}
    <ul>{page.items.map((row) => <li key={row.id}>
      <div><button className="secondary" aria-label={`查看创建 ${row.id}`} disabled={pending || loading || !!lockedKey && lockedKey !== row.requestKey} onClick={() => onSelect(row)}>{row.address ?? "地址待确认"}</button>
        <small>{row.origin === 'imported' ? '已导入（未创建上游邮箱）' : creationStateText(row.state)} · {row.providerId ?? "历史供应商未记录"} · {dateText(row.createdAt)}</small>
        <small>请求键：{row.requestKey}</small>
        {row.error && <small>{row.error}</small>}
        {row.acknowledgedAt !== null && <small>已知悉不确定性：{dateText(row.acknowledgedAt)}</small>}</div>
    </li>)}</ul>
    {!loading && page.items.length === 0 && <p>暂无创建记录</p>}
    {page.nextCursor && <button className="secondary" disabled={pending || loading} onClick={more}>加载更多创建记录</button>}
  </section>;
}

export function CreationAcknowledgement({ creation, pending, onConfirm }: {
  creation: Creation; pending: boolean; onConfirm: (address: string, acknowledged: boolean) => Promise<void>;
}) {
  const [address, setAddress] = useState(""), [acknowledged, setAcknowledged] = useState(false);
  const expected = creation.address ?? creation.requestKey;
  return <form className="card" aria-label="未决创建确认" onSubmit={(event) => { event.preventDefault(); onConfirm(address, acknowledged); }}>
    <label>{creation.address === null ? "确认原请求键" : "确认原邮箱地址"}<input value={address} disabled={pending} maxLength={320} onChange={(event) => setAddress(event.target.value)} autoComplete="off" /></label>
    <label className="check"><input type="checkbox" checked={acknowledged} disabled={pending} onChange={(event) => setAcknowledged(event.target.checked)} />
      我已知悉原请求仍可能成功，另起分配可能产生额外邮箱并占用配额</label>
    <button className="secondary" disabled={pending || address !== expected || !acknowledged}>保留未决记录，另起分配</button>
  </form>;
}
