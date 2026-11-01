import { useEffect, useState } from "react";
import type { AgentThread } from "./agent-threads-api";
import { agentFollowupSubmitted } from "./agent-followups-api";
import type { useAgentFollowups } from "./useAgentFollowups";

export function AgentFollowupComposer({ thread, state, disabled }: { thread: AgentThread; state: ReturnType<typeof useAgentFollowups>; disabled: boolean }) {
  const fallback = thread.kind === "task" && thread.task.contentPurgedAt === null && agentFollowupSubmitted(thread.task)
    ? { type: "task" as const, id: thread.id, subject: thread.task.subject } : null;
  const anchor = state.anchor ?? fallback, context = state.context;
  const [subject, setSubject] = useState(""), [text, setText] = useState("");
  useEffect(() => { setSubject(anchor ? `${/^re:/i.test(anchor.subject) ? "" : "Re: "}${anchor.subject}`.slice(0, 200) : ""); }, [anchor?.id, anchor?.type]);
  useEffect(() => { if (state.completedKey) setText(""); }, [state.completedKey]);
  const available = !!context && !!anchor && context.smtpRevision > 0 && context.trustLevel !== "blocked"
    && ["open", "needs_attention"].includes(thread.management.state);
  return <form aria-label="同线程跟进" onSubmit={event => {
    event.preventDefault(); if (disabled || !available || !context || !anchor) return;
    const restricted = context.trustLevel === "restricted";
    if (!window.confirm(`${restricted ? "受限服务。" : ""}${context.uncertain ? "前序邮件结果未确认，新邮件可能造成重复处理。" : ""}${anchor.type === "incoming" ? "来信发件身份未验证。" : ""}从 ${context.from} 发送给 ${context.to}，回复 ${anchor.id}。入队后退出或撤销 Key 不会取消；仅派发前可取消。确认发送这封跟进？`)) return;
    void state.submit({ serviceId: context.serviceId, serviceVersion: context.serviceVersion, senderAccountId: context.senderAccountId,
      accountRevision: context.accountRevision, smtpRevision: context.smtpRevision, expectedThreadRevision: context.threadRevision,
      replyToType: anchor.type, replyToId: anchor.id, confirmRestricted: restricted, confirmUncertain: context.uncertain, subject, text });
  }}><fieldset disabled={disabled}>
    {context && <p>{context.from} → {context.to}</p>}
    {anchor && <small>回复对象：{anchor.type} · {anchor.id}</small>}
    {fallback && state.anchor && <button type="button" className="secondary" onClick={() => state.choose(fallback)}>回复原 Agent 任务</button>}
    <label>跟进主题<input required maxLength={200} value={subject} onChange={event => setSubject(event.target.value)} /></label>
    <label>跟进正文<textarea required maxLength={6000} value={text} onChange={event => setText(event.target.value)} /></label>
    <button disabled={!available}>排队发送同线程跟进</button>
  </fieldset></form>;
}
