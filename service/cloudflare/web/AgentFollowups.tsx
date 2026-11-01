import { agentTaskStates } from "./agent-tasks-api";
import { agentFollowupSubmitted } from "./agent-followups-api";
import type { AgentThread } from "./agent-threads-api";
import type { useAgentFollowups } from "./useAgentFollowups";
import { AgentFollowupComposer } from "./AgentFollowupComposer";

export function AgentFollowups({ thread, state, disabled }: { thread: AgentThread; state: ReturnType<typeof useAgentFollowups>; disabled: boolean }) {
  const row = state.selected, locked = disabled || state.locked;
  return <section aria-label="Agent 同线程跟进"><h3>同线程跟进</h3>
    <button className="secondary" disabled={locked} onClick={() => void state.refresh()}>刷新跟进来源与记录</button>
    {state.error && <p role="alert">{state.error}</p>}{state.notice && <p role="status">{state.notice}</p>}
    {state.attempt && <div><code>请求：{state.attempt.kind === "send" ? state.attempt.key : state.attempt.row.id}</code><div className="row">
      <button disabled={state.pending} onClick={() => void state.recover()}>核对原跟进操作</button>
      <button className="secondary" disabled={state.pending} onClick={state.abandon}>放弃本页跟进核对</button></div></div>}
    <AgentFollowupComposer thread={thread} state={state} disabled={locked} />
    <ul>{state.page?.items.map(item => <li key={item.id}><button className="secondary" disabled={locked} onClick={() => void state.read(item.id)}>{item.subject || "内容已清理"}</button>
      <small>{agentTaskStates[item.state]}</small></li>)}</ul>
    {state.page?.items.length === 0 && <p>暂无同线程跟进</p>}
    {state.page?.nextCursor && <button disabled={locked} onClick={() => void state.refresh(state.page!.nextCursor!)}>加载更多跟进</button>}
    {row && <article aria-label="Agent 跟进详情"><h4>{row.subject || "内容已清理"}</h4><p role="status">{agentTaskStates[row.state]}</p>
      <small>跟进 ID：{row.id}</small><small>邮件 Message-ID：{row.messageId}</small><small>In-Reply-To：{row.inReplyTo}</small>
      <p>{row.from} → {row.to}</p><pre>{row.text}</pre>{row.error && <p>{row.error}</p>}
      <button className="secondary" disabled={locked} onClick={() => void state.read(row.id)}>刷新跟进状态</button>
      {agentFollowupSubmitted(row) && row.contentPurgedAt === null && <button className="secondary" disabled={locked}
        onClick={() => state.choose({ type: "followup", id: row.id, subject: row.subject })}>回复这封跟进</button>}
      {row.cancellable && <button className="danger" disabled={locked} onClick={() => {
        if (window.confirm("仅取消这封尚未派发的跟进，不改变线程人工状态，确认取消？")) void state.cancel();
      }}>取消这封跟进派发</button>}
    </article>}
  </section>;
}
