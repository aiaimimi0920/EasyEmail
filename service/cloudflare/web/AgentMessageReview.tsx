import { useEffect, useRef, useState } from "react";
import { errorMessage, type Page } from "./api";
import type { AgentIncoming } from "./agent-inbox-api";
import { agentReviewTargets, type AgentReviewInput, type AgentReviewTarget } from "./agent-review-api";

export function AgentMessageReview({ message, accountRevision, disabled, onSubmit }: {
  message: AgentIncoming; accountRevision: number; disabled: boolean; onSubmit: (id: string, body: AgentReviewInput) => void;
}) {
  const [page, setPage] = useState<Page<AgentReviewTarget> | null>(null), [selected, setSelected] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const reader = useRef<AbortController | null>(null);
  async function load(cursor = "") {
    const controller = new AbortController(); reader.current?.abort(); reader.current = controller; setPending(true); setError("");
    try {
      const next = await agentReviewTargets(message.accountId, message.id, cursor, controller.signal);
      if (!controller.signal.aborted) setPage(old => cursor ? { ...next, items: [...(old?.items ?? []), ...next.items] } : next);
    } catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (reader.current === controller && !controller.signal.aborted) setPending(false); }
  }
  useEffect(() => { void load(); return () => reader.current?.abort(); }, [message.id, message.epochId]);
  function submit(state: AgentReviewInput["state"], threadId: string | null = null) {
    if (disabled || pending) return;
    if (state === "linked" && !window.confirm(`将此邮件人工归入任务 ${threadId}？不验证发件人身份、不修改原邮件头、不触发发信或标记任务完成。`)) return;
    onSubmit(message.id, { accountRevision, epochId: message.epochId, expectedRevision: message.review.revision, state, threadId });
  }
  return <section aria-label="邮件人工处理"><h5>人工处理</h5>
    <div className="row"><button className="secondary" disabled={disabled || pending || message.review.state === "attention"} onClick={() => submit("attention")}>重新关注</button>
      <button className="secondary" disabled={disabled || pending || message.review.state === "dismissed"} onClick={() => submit("dismissed")}>忽略此邮件</button></div>
    <label>人工关联任务<select value={selected} disabled={disabled || pending} onChange={event => setSelected(event.target.value)}><option value="">请选择已提交任务</option>
      {page?.items.map(row => <option key={row.id} value={row.id}>{row.subject || "（无主题）"} · {row.recipient} · {row.id}</option>)}</select></label>
    <button disabled={disabled || pending || !page?.items.some(row => row.id === selected)} onClick={() => submit("linked", selected)}>关联所选任务</button>
    {page?.nextCursor && <button className="secondary" disabled={disabled || pending} onClick={() => void load(page.nextCursor!)}>加载更多关联任务</button>}
    {error && <p role="alert">{error}</p>}{error && <button className="secondary" disabled={disabled || pending} onClick={() => void load()}>重试加载关联任务</button>}
  </section>;
}
