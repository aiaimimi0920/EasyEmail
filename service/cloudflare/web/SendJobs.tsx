import { useEffect, useRef, useState } from "react";
import { api, ApiError, dateText, errorMessage, type Page } from "./api";
import { jobState, type SendJob } from "./send-jobs";
import { addressText } from "./compose-recipients";

interface Operation { id: string; kind: "cancel" | "retry"; key: string; revision: number; uncertain: boolean; basePath: string }
export function SendJobs({ revision, visible, basePath = "/send-jobs", title = "发送队列", disabled = false, onLock }: {
  revision: number; visible: boolean; basePath?: string; title?: string; disabled?: boolean; onLock?: (locked: boolean) => void;
}) {
  const [page, setPage] = useState<Page<SendJob> | null>(null), [detail, setDetail] = useState<SendJob | null>(null);
  const [error, setError] = useState(""), [pending, setPending] = useState(false), [refresh, setRefresh] = useState(0);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const generation = useRef(0), details = useRef(0), busy = useRef(false), operation = useRef<Operation | null>(null);
  const owner = useRef(basePath), report = useRef(onLock); report.current = onLock;
  useEffect(() => {
    if (owner.current !== basePath) { owner.current = basePath; setPage(null); setDetail(null); setError(""); }
    if (!visible) return;
    const current = ++generation.current; setPending(true);
    api<Page<SendJob>>(basePath).then(value => { if (current === generation.current) setPage(value); })
      .catch(failure => { if (current === generation.current) setError(errorMessage(failure)); })
      .finally(() => { if (current === generation.current) setPending(false); });
    return () => { generation.current++; details.current++; };
  }, [revision, refresh, visible, basePath]);
  async function open(id: string) {
    if (disabled || operation.current || busy.current) return;
    const current = ++details.current; setError("");
    busy.current = true; report.current?.(true);
    try { const value = await api<{ job: SendJob }>(`${basePath}/${id}`); if (current === details.current) setDetail(value.job); }
    catch (failure) { if (current === details.current) setError(errorMessage(failure)); }
    finally { busy.current = false; report.current?.(!!operation.current); }
  }
  async function more() {
    if (disabled || operation.current || busy.current || pending || !page?.nextCursor) return;
    const current = ++generation.current; setPending(true);
    busy.current = true; report.current?.(true);
    try {
      const value = await api<Page<SendJob>>(`${basePath}?cursor=${page.nextCursor}`);
      if (current === generation.current) setPage({ ...value, items: [...page.items, ...value.items] });
    } catch (failure) { if (current === generation.current) setError(errorMessage(failure)); }
    finally { busy.current = false; report.current?.(!!operation.current); if (current === generation.current) setPending(false); }
  }
  async function act(kind: "cancel" | "retry") {
    if (busy.current || !detail || !operation.current && disabled) return;
    if (!operation.current && !window.confirm(kind === "cancel" ? "取消这个尚未预约发送的任务？已消费的草稿不会恢复。" : "确认只重试尚未建立发送预约的准备步骤？")) return;
    operation.current ??= { id: detail.id, kind, key: crypto.randomUUID(), revision: detail.revision, uncertain: false, basePath };
    report.current?.(true);
    details.current++;
    const current = operation.current; busy.current = true; setPending(true); setError("");
    try {
      const value = await api<{ job: SendJob }>(`${current.basePath}/${current.id}/${current.kind}`, "POST", { expectedRevision: current.revision }, { "idempotency-key": current.key });
      setDetail(value.job); operation.current = null; setUnconfirmed(false); setRefresh(old => old + 1);
    } catch (failure) {
      setError(errorMessage(failure));
      if (!current.uncertain && failure instanceof ApiError && failure.status < 500) {
        operation.current = null;
        try { setDetail((await api<{ job: SendJob }>(`${current.basePath}/${current.id}`)).job); } catch { /* Keep the actionable error visible. */ }
      }
      else { current.uncertain = true; setUnconfirmed(true); }
    } finally { busy.current = false; report.current?.(!!operation.current); setPending(false); }
  }
  return <section className="card" aria-label={title} hidden={!visible}><h2>{title}</h2>
    <button className="secondary" disabled={pending} onClick={() => setRefresh(old => old + 1)}>刷新发送队列</button>
    {error && <p role="alert">{error}</p>}
    <ul>{page?.items.map(item => <li key={item.id}><div>
      <button className="secondary" disabled={disabled || !!operation.current} onClick={() => void open(item.id)}>{item.subject || "任务内容已清除"}</button>
      <small>{jobState(item.state)} · {dateText(item.dueAt)}</small>
    </div></li>)}</ul>
    {page?.items.length === 0 && <p>暂无排队任务</p>}
    {page?.nextCursor && <button disabled={disabled || pending || !!operation.current} onClick={() => void more()}>加载更多排队任务</button>}
    {detail && <article aria-label="任务详情"><h3>{detail.subject || "任务内容已清除"}</h3><p>{jobState(detail.state)}</p>
      <p>计划：{dateText(detail.dueAt)} · 最迟处理：{dateText(detail.deadlineAt)}</p><p>准备次数：{detail.attempts}/5</p>
      {detail.content && <><p>收件：{addressText(detail.content.to)}</p>{!!detail.content.cc.length && <p>抄送：{detail.content.cc.join(", ")}</p>}
        {!!detail.content.bcc.length && <p>密送：{detail.content.bcc.join(", ")}</p>}<pre>{detail.content.text}</pre>
        <ul>{detail.content.attachments.map(file => <li key={file.id}>{file.filename} · {file.size} 字节</li>)}</ul></>}
      {detail.error && <p>状态码：{detail.error}</p>}<p>原入队键：<code>{detail.requestKey}</code></p>
      {detail.cancellable && <button disabled={disabled || pending || unconfirmed} onClick={() => void act("cancel")}>取消排队</button>}
      {detail.retrySafe && <button disabled={disabled || pending || unconfirmed} onClick={() => void act("retry")}>重试准备</button>}
      {unconfirmed && operation.current && <button disabled={pending} onClick={() => void act(operation.current!.kind)}>核对原队列操作</button>}
    </article>}
  </section>;
}
