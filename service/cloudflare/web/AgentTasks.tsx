import { useConfirmation } from "./Confirmation";
import { Button, Field, Input, Notice, Panel, Select, Textarea } from '@neuro/ui';
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
  const confirm = useConfirmation([source.account, source.service, source.smtp, subject, text, task, locked, visible]);
  return <Panel className="card" aria-label="Agent 任务" hidden={!visible}><h2>Agent 任务</h2>
    <form onSubmit={async event => {
      event.preventDefault(); if (!available || locked || !source.account || !source.service || !source.smtp) return;
      const restricted = source.service.trustLevel === "restricted";
      if (!(await confirm(`${restricted ? "该服务为受限服务。" : ""}将任务排队发送给 ${source.service.emailAddress}，发件邮箱 ${source.account.emailAddress}。提交后形成持久发送意图，退出或撤销 Key 不会取消；可在派发前取消任务。确认提交？`))) return;
      void state.submit({ serviceId: source.service.id, serviceVersion: source.service.version, senderAccountId: source.account.id,
        accountRevision: source.account.revision, smtpRevision: source.smtp.revision, confirmRestricted: restricted, subject, text });
    }}><fieldset disabled={locked || !!task}>
      <Field label="任务远程服务"><Select required value={source.serviceId} onChange={event => source.setServiceId(event.target.value)}><option value="">请选择服务</option>
        {source.services?.items.map(row => <option key={row.id} value={row.id} disabled={row.status !== "active" || row.trustLevel === "blocked"}>{row.displayName} · {row.emailAddress}</option>)}</Select></Field>
      <Field label="任务发件邮箱"><Select required value={source.accountId} onChange={event => source.setAccountId(event.target.value)}><option value="">请选择 Agent 邮箱</option>
        {source.accounts?.items.map(row => <option key={row.id} value={row.id} disabled={!row.enabled || !row.credentialConfigured}>{row.displayName || row.emailAddress}</option>)}</Select></Field>
      {source.service?.defaultSenderAccountId && <Button type="button" onClick={() => void source.useDefaultSender()} variant="quiet" wrap>使用服务默认邮箱</Button>}
      <Field label="任务主题"><Input required maxLength={200} value={subject} onChange={event => setSubject(event.target.value)} /></Field>
      <Field label="任务正文"><Textarea required maxLength={6000} value={text} onChange={event => setText(event.target.value)} /></Field>
      <Button disabled={!available} type="submit" wrap>创建并排队发送 Agent 任务</Button>
    </fieldset></form>
    <div className="row"><Button disabled={locked} onClick={() => { void source.refresh(); }} variant="quiet" wrap>刷新任务来源</Button>
      <Button disabled={state.pending} onClick={async () => { if (await state.newTask()) { setSubject(""); setText(""); } }} variant="quiet" wrap>另建 Agent 任务</Button></div>
    {source.accounts?.nextCursor && <Button disabled={locked} onClick={() => void source.refresh("accounts")} wrap>加载更多任务邮箱</Button>}
    {source.services?.nextCursor && <Button disabled={locked} onClick={() => void source.refresh("services")} wrap>加载更多任务服务</Button>}
    {state.attempt && <Button disabled={state.pending} onClick={() => void state.submit()} wrap>核对原 Agent 任务</Button>}
    {state.error && <Notice role="alert" tone="danger">{state.error}</Notice>}{source.error && <Notice role="alert" tone="danger">{source.error}</Notice>}
    {task && <article aria-label="Agent 任务详情"><h3>{task.subject || "内容已清理"}</h3><Notice role="status" tone="info">{agentTaskStates[task.state]}</Notice>
      <small>任务 ID：{task.id}</small><small>邮件 Message-ID：{task.messageId}</small><pre>{task.text}</pre>
      {task.error && <p>{task.error}</p>}
      <Button disabled={state.locked} onClick={() => void state.read(task.id)} variant="quiet" wrap>刷新 Agent 任务状态</Button>
      {task.cancellable && <Button variant="danger" disabled={state.locked} onClick={async () => {
        if ((await confirm("仅能取消尚未派发的任务，确认取消？"))) void state.read(task.id, true);
      }} wrap>取消 Agent 任务派发</Button>}
      <AgentInbox key={task.id} account={{ id: task.senderAccountId, revision: task.accountRevision, enabled: false, credentialConfigured: false }} visible={visible} threadId={task.id} />
    </article>}
    <h3>任务记录</h3><Button disabled={state.locked} onClick={() => void state.refresh()} variant="quiet" wrap>刷新 Agent 任务列表</Button>
    <ul>{state.page?.items.map(row => <li key={row.id}><Button disabled={state.locked} onClick={() => void state.read(row.id)} variant="quiet" wrap>{row.subject || "内容已清理"}</Button>
      <small>{agentTaskStates[row.state]}</small></li>)}</ul>
    {state.page?.nextCursor && <Button disabled={state.locked} onClick={() => void state.more()} wrap>加载更多 Agent 任务</Button>}
  </Panel>;
}
