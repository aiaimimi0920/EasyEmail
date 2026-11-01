import { useEffect, useRef, useState } from "react";
import { api, dateText, errorMessage, type Page } from "./api";
import { sendState, type Outgoing } from "./outgoing";
import { addressText } from "./compose-recipients";

export function OutgoingHistory({ revision }: { revision: number }) {
  const [page, setPage] = useState<Page<Outgoing> | null>(null);
  const [detail, setDetail] = useState<Outgoing | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const detailGeneration = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setPending(true); setError("");
    api<Page<Outgoing>>("/outgoing").then((value) => { if (current === generation.current) setPage(value); })
      .catch((failure) => { if (current === generation.current) setError(errorMessage(failure)); })
      .finally(() => { if (current === generation.current) setPending(false); });
    return () => { generation.current++; detailGeneration.current++; };
  }, [revision, refresh]);

  async function more() {
    if (pending || !page?.nextCursor) return;
    const current = ++generation.current;
    setPending(true); setError("");
    try {
      const value = await api<Page<Outgoing>>(`/outgoing?cursor=${page.nextCursor}`);
      if (current === generation.current) setPage({ ...value, items: [...page.items, ...value.items] });
    } catch (failure) { if (current === generation.current) setError(errorMessage(failure)); }
    finally { if (current === generation.current) setPending(false); }
  }

  async function open(id: string) {
    const current = ++detailGeneration.current;
    setDetail(null); setError("");
    try {
      const value = await api<{ outgoing: Outgoing }>(`/outgoing/${id}`);
      if (current === detailGeneration.current) setDetail(value.outgoing);
    } catch (failure) { if (current === detailGeneration.current) setError(errorMessage(failure)); }
  }

  return <section className="card" aria-label="发送记录"><h2>发送记录</h2>
    <button className="secondary" disabled={pending} onClick={() => setRefresh((value) => value + 1)}>刷新发送记录</button>
    {error && <p role="alert">{error}</p>}
    <ul>{page?.items.map((item) => <li key={item.id}><div>
      <button className="secondary" onClick={() => open(item.id)}>{item.contentPurgedAt !== null ? "发送内容已清除" : item.subject}</button>
      <small>{item.from} → {addressText(item.to)}</small><small>{dateText(item.createdAt)} · {sendState(item.state)}</small>
    </div></li>)}</ul>
    {page?.items.length === 0 && <p>暂无发送记录</p>}
    {page?.nextCursor && <button disabled={pending} onClick={more}>加载更多发送记录</button>}
    {detail && <article aria-label="发送详情"><h3>{detail.contentPurgedAt !== null ? "发送内容已清除" : detail.subject}</h3><p>{detail.from} → {addressText(detail.to)}</p>
      {!!detail.cc?.length && <p>抄送：{detail.cc.join(", ")}</p>}{!!detail.bcc?.length && <p>密送：{detail.bcc.join(", ")}</p>}
      {!!detail.attachments?.length && <ul aria-label="已提交附件">{detail.attachments.map(item => <li key={item.id}>{item.filename} · {item.size} 字节</li>)}</ul>}
      {detail.contentPurgedAt !== null && <p>发送内容已按策略清除，防重放记录仍保留 · {dateText(detail.contentPurgedAt)}</p>}
      <p>{sendState(detail.state)}</p><code>{detail.requestKey}</code><pre>{detail.text}</pre>
      {detail.error && <p>状态码：{detail.error}</p>}
    </article>}
  </section>;
}
