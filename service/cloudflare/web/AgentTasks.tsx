import { useState } from "react";
import { agentTaskStates } from "./agent-tasks-api";
import { useAgentTaskSources } from "./useAgentTaskSources";
import { useAgentTasks } from "./useAgentTasks";
import { AgentInbox } from "./AgentInbox";

export function AgentTasks({ visible }: { visible: boolean }) {
  const state = useAgentTasks(visible), source = useAgentTaskSources(visible);
  const [subject, setSubject] = useState(""), [text, setText] = useState(""), task = state.selected;
  const available = !!source.account?.enabled && source.account.credentialConfigured && !!source.smtp?.current && source.smtp.enabled && source.smtp.credentialConfigured
    && source.service?.status === "active" && source.service.trustLevel !== "blocked";
  const locked = state.locked || source.pending;
  return <section className="card" aria-label="Agent 任务" hidden={!visible}><h2>Agent 任务</h2>
    <form onSubmit={event => {
      event.preventDefault(); if (!available || locked || !source.account || !source.service || !source.smtp) return;
      const restricted = source.service.trustLevel === "restricted";
      if (!window.confirm(`${restricted ? "该服务为受限服务。" : ""}将任务排队发送给 ${source.service.emailAddress}，发件邮箱 ${source.account.emailAddress}。提交后形成持久发送意图，退出或撤销 Key 不会取消；可在派发前取消任务。确认提交？`)) return;
      void state.submit({ serviceId: source.service.id, serviceVersion: source.service.version, senderAccountId: source.account.id,
        accountRevision: source.account.revision, smtpRevision: source.smtp.revision, confirmRestricted: restricted, subject, text });
    }}><fieldset disabled={locked || !!task}>
      <label>任务远程服务<select required value={source.serviceId} onChange={event => source.setServiceId(event.target.value)}><option value="">请选择服务</option>
        {source.services?.items.map(row => <option key={row.id} value={row.id} disabled={row.status !== "active" || row.trustLevel === "blocked"}>{row.displayName} · {row.emailAddress}</option>)}</select></label>
      <label>任务发件邮箱<select required value={source.accountId} onChange={event => source.setAccountId(event.target.value)}><option value="">请选择 Agent 邮箱</option>
        {source.accounts?.items.map(row => <option key={row.id} value={row.id} disabled={!row.enabled || !row.credentialConfigured}>{row.displayName || row.emailAddress}</option>)}</select></label>
      {source.service?.defaultSenderAccountId && <button type="button" className="secondary" onClick={() => void source.useDefaultSender()}>使用服务默认邮箱</button>}
      <label>任务主题<input required maxLength={200} value={subject} onChange={event => setSubject(event.target.value)} /></label>
      <label>任务正文<textarea required maxLength={6000} value={text} onChange={event => setText(event.target.value)} /></label>
      <button disabled={!available}>创建并排队发送 Agent 任务</button>
    </fieldset></form>
    <div className="row"><button className="secondary" disabled={locked} onClick={() => { void source.refresh(); }}>刷新任务来源</button>
      <button className="secondary" disabled={state.pending} onClick={() => { if (state.newTask()) { setSubject(""); setText(""); } }}>另建 Agent 任务</button></div>
    {source.accounts?.nextCursor && <button disabled={locked} onClick={() => void source.refresh("accounts")}>加载更多任务邮箱</button>}
    {source.services?.nextCursor && <button disabled={locked} onClick={() => void source.refresh("services")}>加载更多任务服务</button>}
    {state.attempt && <button disabled={state.pending} onClick={() => void state.submit()}>核对原 Agent 任务</button>}
    {state.error && <p role="alert">{state.error}</p>}{source.error && <p role="alert">{source.error}</p>}
    {task && <article aria-label="Agent 任务详情"><h3>{task.subject || "内容已清理"}</h3><p role="status">{agentTaskStates[task.state]}</p>
      <small>任务 ID：{task.id}</small><small>邮件 Message-ID：{task.messageId}</small><pre>{task.text}</pre>
      {task.error && <p>{task.error}</p>}
      <button className="secondary" disabled={state.locked} onClick={() => void state.read(task.id)}>刷新 Agent 任务状态</button>
      {task.cancellable && <button className="danger" disabled={state.locked} onClick={() => {
        if (window.confirm("仅能取消尚未派发的任务，确认取消？")) void state.read(task.id, true);
      }}>取消 Agent 任务派发</button>}
      <AgentInbox key={task.id} account={{ id: task.senderAccountId, revision: task.accountRevision, enabled: false, credentialConfigured: false }} visible={visible} threadId={task.id} />
    </article>}
    <h3>任务记录</h3><button className="secondary" disabled={state.locked} onClick={() => void state.refresh()}>刷新 Agent 任务列表</button>
    <ul>{state.page?.items.map(row => <li key={row.id}><button className="secondary" disabled={state.locked} onClick={() => void state.read(row.id)}>{row.subject || "内容已清理"}</button>
      <small>{agentTaskStates[row.state]}</small></li>)}</ul>
    {state.page?.nextCursor && <button disabled={state.locked} onClick={() => void state.more()}>加载更多 Agent 任务</button>}
  </section>;
}
