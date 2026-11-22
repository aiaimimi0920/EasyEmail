import { useConfirmation } from "./Confirmation";
import { Button, Notice, Panel } from '@neuro/ui';
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
    const original = operation.current, version = details.current;
    if (!operation.current && !(await confirm(kind === "cancel" ? "取消这个尚未预约发送的任务？已消费的草稿不会恢复。" : "确认只重试尚未建立发送预约的准备步骤？"))) return;
    if (busy.current || operation.current !== original || details.current !== version) return;
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
  const confirm = useConfirmation([basePath, detail, disabled, unconfirmed, visible]);
  return <Panel className="card" aria-label={title} hidden={!visible}><h2>{title}</h2>
    <Button disabled={pending} onClick={() => setRefresh(old => old + 1)} variant="quiet" wrap>刷新发送队列</Button>
    {error && <Notice role="alert" tone="danger">{error}</Notice>}
    <ul>{page?.items.map(item => <li key={item.id}><div>
      <Button disabled={disabled || !!operation.current} onClick={() => void open(item.id)} variant="quiet" wrap>{item.subject || "任务内容已清除"}</Button>
      <small>{jobState(item.state)} · {dateText(item.dueAt)}</small>
    </div></li>)}</ul>
    {page?.items.length === 0 && <p>暂无排队任务</p>}
    {page?.nextCursor && <Button disabled={disabled || pending || !!operation.current} onClick={() => void more()} wrap>加载更多排队任务</Button>}
    {detail && <article aria-label="任务详情"><h3>{detail.subject || "任务内容已清除"}</h3><p>{jobState(detail.state)}</p>
      <p>计划：{dateText(detail.dueAt)} · 最迟处理：{dateText(detail.deadlineAt)}</p><p>准备次数：{detail.attempts}/5</p>
      {detail.content && <><p>收件：{addressText(detail.content.to)}</p>{!!detail.content.cc.length && <p>抄送：{detail.content.cc.join(", ")}</p>}
        {!!detail.content.bcc.length && <p>密送：{detail.content.bcc.join(", ")}</p>}<pre>{detail.content.text}</pre>
        <ul>{detail.content.attachments.map(file => <li key={file.id}>{file.filename} · {file.size} 字节</li>)}</ul></>}
      {detail.error && <p>状态码：{detail.error}</p>}<p>原入队键：<code>{detail.requestKey}</code></p>
      {detail.cancellable && <Button disabled={disabled || pending || unconfirmed} onClick={() => void act("cancel")} wrap>取消排队</Button>}
      {detail.retrySafe && <Button disabled={disabled || pending || unconfirmed} onClick={() => void act("retry")} wrap>重试准备</Button>}
      {unconfirmed && operation.current && <Button disabled={pending} onClick={() => void act(operation.current!.kind)} wrap>核对原队列操作</Button>}
    </article>}
  </Panel>;
}
