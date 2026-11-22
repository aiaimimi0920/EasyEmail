import { useConfirmation } from "./Confirmation";
import { Button, Field, Notice, Panel, Select } from '@neuro/ui';
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
  async function update(next: AgentThreadState) {
    const action = next === "completed" ? "标记人工完成" : next === "archived" ? "归档" : next === "needs_attention" ? "标记待人工关注" : "恢复为处理中";
    if ((await confirm(`确认${action}？仅修改人工管理状态，不取消或重试派发，不代表邮件已送达或远端任务已完成。`))) void state.submit(next);
  }
  const confirm = useConfirmation([selected, locked, visible]);
  return <Panel className="card" aria-label="Agent 线程" hidden={!visible}><h2>Agent 线程</h2>
    <Field label="线程状态筛选"><Select disabled={locked} value={state.filter} onChange={event => void state.refresh(event.target.value)}>
      <option value="">全部</option>{Object.entries(agentThreadStates).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </Select></Field>
    <Button disabled={locked} onClick={() => void state.refresh()} variant="quiet" wrap>刷新 Agent 线程</Button>
    {state.error && <Notice role="alert" tone="danger">{state.error}</Notice>}{state.notice && <Notice role="status" tone="info">{state.notice}</Notice>}
    {state.attempt && <div><code>操作键：{state.attempt.key}</code><Button disabled={state.pending} onClick={() => void state.submit()} wrap>核对原线程操作</Button>
      <Button disabled={state.pending} onClick={state.abandon} variant="quiet" wrap>放弃本页线程核对</Button></div>}
    <ul>{state.page?.items.map(row => <li key={row.id}><Button disabled={locked} onClick={() => void state.read(row.id)} variant="quiet" wrap>{agentThreadTitle(row)}</Button>
      <small>{agentThreadStates[row.management.state]} · {row.kind === "task" ? agentTaskStates[row.task.state] : "入站"}</small></li>)}</ul>
    {state.page?.items.length === 0 && <p>暂无 Agent 线程</p>}
    {state.page?.nextCursor && <Button disabled={locked} onClick={() => void state.refresh(state.filter, state.page!.nextCursor!)} wrap>加载更多 Agent 线程</Button>}
    {selected && <article aria-label="Agent 线程详情"><h3>{agentThreadTitle(selected)}</h3>
      <Notice role="status" tone="info">{agentThreadStates[selected.management.state]}</Notice><small>线程 ID：{selected.id}</small>
      <small>管理版本：{selected.management.revision}</small>{task && <><small>{agentTaskStates[task.state]}</small><pre>{task.text}</pre></>}
      {inbound && <><small>收件账号：{inbound.accountId}</small><small>服务 ID：{inbound.serviceId}</small>
        {!inbound.memberActive && <Notice role="status" tone="info">种子邮件已由后续人工处理重新归类</Notice>}</>}
      <div className="row">{(Object.entries(agentThreadStates) as [AgentThreadState, string][]).map(([value, label]) =>
        <Button key={value} disabled={locked || selected.management.state === value} onClick={() => update(value)} variant="quiet" wrap>{value === "open" ? "恢复处理中" : value === "completed" ? "标记人工完成" : value === "archived" ? "归档线程" : label}</Button>)}</div>
      <AgentFollowups key={`followup-${selected.id}`} thread={selected} state={followups} disabled={locked} />
      <AgentInbox key={selected.id} account={{ id: task ? task.senderAccountId : inbound!.accountId, revision: task ? task.accountRevision : inbound!.accountRevision,
        enabled: false, credentialConfigured: false }} visible={visible} disabled={locked} threadId={selected.id} inbound={!!inbound}
        onReply={message => followups.choose({ type: "incoming", id: message.id, subject: message.subject })} />
    </article>}
  </Panel>;
}
