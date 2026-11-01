import { useEffect, useState } from "react";
import { dateText } from "./api";
import { agentAssociations, agentInboxPath, agentIncomingThreadId, type AgentIncoming } from "./agent-inbox-api";
import { useAgentInbox } from "./useAgentInbox";
import { SafeMailBody } from "./SafeMailBody";
import { AttachmentList } from "./AttachmentList";
import type { AgentAccount } from "./agent-accounts-api";
import { useAgentReview } from "./useAgentReview";
import { AgentMessageReview } from "./AgentMessageReview";
import { agentReviewLabels } from "./agent-review-api";
import { useAgentInbound } from "./useAgentInbound";
import { AgentInboundCreate } from "./AgentInboundCreate";

export function AgentInbox({ account, visible, disabled = false, onBusy, onReply, threadId = "", inbound = false, canAct }: {
  account: Pick<AgentAccount, "id" | "revision" | "enabled" | "credentialConfigured">; visible: boolean; disabled?: boolean;
  onBusy?: (busy: boolean) => void; onReply?: (message: AgentIncoming) => void; threadId?: string; inbound?: boolean;
  canAct?: () => boolean;
}) {
  const [filter, setFilter] = useState("");
  const state = useAgentInbox(account.id, account.revision, visible, threadId, filter), result = state.operation?.result, message = state.message;
  const review = useAgentReview(account.id, () => state.refresh()), creation = useAgentInbound(account.id, () => state.refresh());
  const writing = review.locked || creation.locked, locked = state.locked || writing;
  useEffect(() => { onBusy?.(locked); return () => onBusy?.(false); }, [locked, onBusy]);
  return <section aria-label={threadId ? inbound ? "入站线程来信" : "任务关联回信" : "Agent 收件"}><h3>{threadId ? inbound ? "线程来信" : "关联回信" : "收件"}</h3>
    <div className="row">{!threadId && <button disabled={disabled || state.pending || writing || !state.attempt && (!account.enabled || !account.credentialConfigured)}
      onClick={() => { if (canAct?.() !== false) void state.synchronize(); }}>{state.attempt ? "核对原 Agent 同步" : "同步 Agent 邮箱"}</button>}
      <button className="secondary" disabled={state.pending || state.reading || writing} onClick={() => void state.refresh()}>刷新 Agent 缓存</button></div>
    {!threadId && <label>Agent 处理筛选<select value={filter} disabled={locked || state.reading} onChange={event => setFilter(event.target.value)}>
      <option value="">全部</option><option value="attention">待人工关注</option><option value="handled">已处理</option></select></label>}
    {review.error && <p role="alert">{review.error}</p>}
    {review.attempt && <div><small>人工处理请求：{review.attempt.key}</small><div className="row">
      <button disabled={review.pending} onClick={() => void review.submit()}>核对原人工处理</button>
      <button className="secondary" disabled={review.pending} onClick={review.abandon}>放弃本页核对</button></div></div>}
    {review.operation && <p role="status">人工处理已保存 · 版本 {review.operation.revision}</p>}
    {creation.error && <p role="alert">{creation.error}</p>}
    {creation.attempt && <div><small>入站创建请求：{creation.attempt.key}</small><div className="row">
      <button disabled={creation.pending} onClick={() => void creation.submit()}>核对原入站创建</button>
      <button className="secondary" disabled={creation.pending} onClick={creation.abandon}>放弃本页入站核对</button></div></div>}
    {creation.operation && <p role="status">入站线程已创建 · {creation.operation.threadId}</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.operation?.state === "pending" && <p role="status">同步处理中，请核对原请求</p>}
    {result && <p role="status">本批保存 {result.stored} 封 · 跳过 {result.skipped.length} 封 · {result.complete ? "已检查到本次快照末尾" : "仍有未检查邮件"}</p>}
    <ul>{state.page?.items.map(row => <li key={row.id}><div><button className="secondary" disabled={state.pending || writing} onClick={() => void state.open(row.id)}>{row.subject || "（无主题）"}</button>
      <small>{row.sender} · {row.inboundThread?.active ? "已建入站线程" : row.review.state === "unreviewed" ? agentAssociations[row.association] : agentReviewLabels[row.review.state]} · {dateText(row.receivedAt)}</small></div></li>)}</ul>
    {state.page?.items.length === 0 && <p>暂无{threadId ? "关联回信" : " Agent 邮件"}</p>}
    {state.page?.nextCursor && <button className="secondary" disabled={state.reading || locked} onClick={() => void state.refresh(state.page!.nextCursor!)}>加载更多 Agent 邮件</button>}
    {message?.content && <article aria-label="Agent 邮件详情"><h4>{message.subject || "（无主题）"}</h4><p>{message.sender} → {message.recipient}</p>
      <p>{message.inboundThread?.active ? "已建入站线程" : message.review.state === "unreviewed" ? agentAssociations[message.association] : agentReviewLabels[message.review.state]} · 发件身份未验证</p>
      {message.inboundThread && <small>入站线程 ID：{message.inboundThread.id}{message.inboundThread.active ? "" : " · 归属已失效"}</small>}
      {message.review.effectiveThreadId && <small>有效任务 ID：{message.review.effectiveThreadId}</small>}
      {message.review.state !== "unreviewed" && <small>原邮件头：{agentAssociations[message.association]}{message.threadId ? ` · ${message.threadId}` : ""}</small>}
      {onReply && agentIncomingThreadId(message) === threadId && <button className="secondary" disabled={disabled || locked}
        onClick={() => onReply(message)}>回复这封 Agent 来信</button>}
      {!threadId && state.page && <AgentMessageReview key={message.id} message={message} accountRevision={state.page.accountRevision} disabled={disabled || locked}
        onSubmit={(id, body) => { void review.submit(id, body); }} />}
      {!threadId && state.page && <AgentInboundCreate key={`inbound-${message.id}`} message={message} accountRevision={state.page.accountRevision} disabled={disabled || locked}
        onSubmit={(id, body) => { void creation.submit(id, body); }} />}
      <SafeMailBody key={message.id} text={message.content.textBody} html={message.content.htmlBody} />
      <AttachmentList key={message.id} path={`${agentInboxPath(account.id)}/messages/${message.id}`} items={message.content.attachments} truncated={message.content.attachmentsTruncated} />
    </article>}
  </section>;
}
