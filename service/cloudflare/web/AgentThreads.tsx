import { useRef } from "react";
import { AgentInbox } from "./AgentInbox";
import { AgentFollowups } from "./AgentFollowups";
import { useAgentFollowups } from "./useAgentFollowups";
import { agentTaskStates } from "./agent-tasks-api";
import { agentThreadStates, agentThreadTitle, type AgentThreadState } from "./agent-threads-api";
import { useAgentThreads } from "./useAgentThreads";

export function AgentThreads({ visible }: { visible: boolean }) {
  const guard = useRef(false), state = useAgentThreads(visible, guard), selected = state.selected, task = selected?.kind === "task" ? selected.task : null;
  const followups = useAgentFollowups({ visible, thread: selected, threadLocked: state.locked, threadBusy: state.isBusy, guard });
  const locked = state.locked || followups.locked;
  const inbound = selected?.kind === "inbound" ? selected.inbound : null;
  function update(next: AgentThreadState) {
    const action = next === "completed" ? "标记人工完成" : next === "archived" ? "归档" : next === "needs_attention" ? "标记待人工关注" : "恢复为处理中";
    if (window.confirm(`确认${action}？仅修改人工管理状态，不取消或重试派发，不代表邮件已送达或远端任务已完成。`)) void state.submit(next);
  }
  return <section className="card" aria-label="Agent 线程" hidden={!visible}><h2>Agent 线程</h2>
    <label>线程状态筛选<select disabled={locked} value={state.filter} onChange={event => void state.refresh(event.target.value)}>
      <option value="">全部</option>{Object.entries(agentThreadStates).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <button className="secondary" disabled={locked} onClick={() => void state.refresh()}>刷新 Agent 线程</button>
    {state.error && <p role="alert">{state.error}</p>}{state.notice && <p role="status">{state.notice}</p>}
    {state.attempt && <div><code>操作键：{state.attempt.key}</code><button disabled={state.pending} onClick={() => void state.submit()}>核对原线程操作</button>
      <button className="secondary" disabled={state.pending} onClick={state.abandon}>放弃本页线程核对</button></div>}
    <ul>{state.page?.items.map(row => <li key={row.id}><button className="secondary" disabled={locked} onClick={() => void state.read(row.id)}>{agentThreadTitle(row)}</button>
      <small>{agentThreadStates[row.management.state]} · {row.kind === "task" ? agentTaskStates[row.task.state] : "入站"}</small></li>)}</ul>
    {state.page?.items.length === 0 && <p>暂无 Agent 线程</p>}
    {state.page?.nextCursor && <button disabled={locked} onClick={() => void state.refresh(state.filter, state.page!.nextCursor!)}>加载更多 Agent 线程</button>}
    {selected && <article aria-label="Agent 线程详情"><h3>{agentThreadTitle(selected)}</h3>
      <p role="status">{agentThreadStates[selected.management.state]}</p><small>线程 ID：{selected.id}</small>
      <small>管理版本：{selected.management.revision}</small>{task && <><small>{agentTaskStates[task.state]}</small><pre>{task.text}</pre></>}
      {inbound && <><small>收件账号：{inbound.accountId}</small><small>服务 ID：{inbound.serviceId}</small>
        {!inbound.memberActive && <p role="status">种子邮件已由后续人工处理重新归类</p>}</>}
      <div className="row">{(Object.entries(agentThreadStates) as [AgentThreadState, string][]).map(([value, label]) =>
        <button className="secondary" key={value} disabled={locked || selected.management.state === value}
          onClick={() => update(value)}>{value === "open" ? "恢复处理中" : value === "completed" ? "标记人工完成" : value === "archived" ? "归档线程" : label}</button>)}</div>
      <AgentFollowups key={`followup-${selected.id}`} thread={selected} state={followups} disabled={locked} />
      <AgentInbox key={selected.id} account={{ id: task ? task.senderAccountId : inbound!.accountId, revision: task ? task.accountRevision : inbound!.accountRevision,
        enabled: false, credentialConfigured: false }} visible={visible} disabled={locked} threadId={selected.id} inbound={!!inbound}
        onReply={message => followups.choose({ type: "incoming", id: message.id, subject: message.subject })} />
    </article>}
  </section>;
}
