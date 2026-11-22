import { useConfirmation } from "./Confirmation";
import { Button, Notice } from '@neuro/ui';
import { agentTaskStates } from "./agent-tasks-api";
import { agentFollowupSubmitted } from "./agent-followups-api";
import type { AgentThread } from "./agent-threads-api";
import type { useAgentFollowups } from "./useAgentFollowups";
import { AgentFollowupComposer } from "./AgentFollowupComposer";

export function AgentFollowups({ thread, state, disabled }: { thread: AgentThread; state: ReturnType<typeof useAgentFollowups>; disabled: boolean }) {
  const row = state.selected, locked = disabled || state.locked;
  const confirm = useConfirmation([thread, row, locked]);
  return <section aria-label="Agent 同线程跟进"><h3>同线程跟进</h3>
    <Button disabled={locked} onClick={() => void state.refresh()} variant="quiet" wrap>刷新跟进来源与记录</Button>
    {state.error && <Notice role="alert" tone="danger">{state.error}</Notice>}{state.notice && <Notice role="status" tone="info">{state.notice}</Notice>}
    {state.attempt && <div><code>请求：{state.attempt.kind === "send" ? state.attempt.key : state.attempt.row.id}</code><div className="row">
      <Button disabled={state.pending} onClick={() => void state.recover()} wrap>核对原跟进操作</Button>
      <Button disabled={state.pending} onClick={state.abandon} variant="quiet" wrap>放弃本页跟进核对</Button></div></div>}
    <AgentFollowupComposer thread={thread} state={state} disabled={locked} />
    <ul>{state.page?.items.map(item => <li key={item.id}><Button disabled={locked} onClick={() => void state.read(item.id)} variant="quiet" wrap>{item.subject || "内容已清理"}</Button>
      <small>{agentTaskStates[item.state]}</small></li>)}</ul>
    {state.page?.items.length === 0 && <p>暂无同线程跟进</p>}
    {state.page?.nextCursor && <Button disabled={locked} onClick={() => void state.refresh(state.page!.nextCursor!)} wrap>加载更多跟进</Button>}
    {row && <article aria-label="Agent 跟进详情"><h4>{row.subject || "内容已清理"}</h4><Notice role="status" tone="info">{agentTaskStates[row.state]}</Notice>
      <small>跟进 ID：{row.id}</small><small>邮件 Message-ID：{row.messageId}</small><small>In-Reply-To：{row.inReplyTo}</small>
      <p>{row.from} → {row.to}</p><pre>{row.text}</pre>{row.error && <p>{row.error}</p>}
      <Button disabled={locked} onClick={() => void state.read(row.id)} variant="quiet" wrap>刷新跟进状态</Button>
      {agentFollowupSubmitted(row) && row.contentPurgedAt === null && <Button disabled={locked} onClick={() => state.choose({ type: "followup", id: row.id, subject: row.subject })} variant="quiet" wrap>回复这封跟进</Button>}
      {row.cancellable && <Button variant="danger" disabled={locked} onClick={async () => {
        if ((await confirm("仅取消这封尚未派发的跟进，不改变线程人工状态，确认取消？"))) void state.cancel();
      }} wrap>取消这封跟进派发</Button>}
    </article>}
  </section>;
}
