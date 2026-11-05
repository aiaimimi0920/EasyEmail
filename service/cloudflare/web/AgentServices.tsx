import { useConfirmation } from "./Confirmation";
import { Button, Field, Input, Notice, Panel, Select, Textarea } from '@neuro/ui';
import { useState, type FormEvent } from "react";
import { agentStatusLabels, agentTrustLabels, type AgentService } from "./agent-services-api";
import { useAgentServices } from "./useAgentServices";
import { useAgentServiceMutation } from "./useAgentServiceMutation";
import { AgentSenderPicker } from "./AgentSenderPicker";

export function AgentServices({ visible }: { visible: boolean }) {
  const list = useAgentServices(visible), [editing, setEditing] = useState<AgentService | null>(null);
  const [name, setName] = useState(""), [email, setEmail] = useState(""), [description, setDescription] = useState(""), [kind, setKind] = useState("email_agent");
  const [trust, setTrust] = useState<AgentService["trustLevel"]>("unknown"), [status, setStatus] = useState<AgentService["status"]>("active");
  const [senderId, setSenderId] = useState<string | null>(null);
  const [query, setQuery] = useState(""), [filterTrust, setFilterTrust] = useState(""), [filterStatus, setFilterStatus] = useState("");
  const action = useAgentServiceMutation(() => { edit(null); list.refresh(); });
  function edit(service: AgentService | null) {
    setEditing(service); setName(service?.displayName ?? ""); setEmail(service?.emailAddress ?? ""); setDescription(service?.description ?? "");
    setKind(service?.serviceKind ?? "email_agent"); setTrust(service?.trustLevel ?? "unknown"); setStatus(service?.status ?? "active");
    setSenderId(service?.defaultSenderAccountId ?? null);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (trust !== (editing?.trustLevel ?? "unknown") && !(await confirm(`将远程服务“${name}”的信任级别设置为“${agentTrustLabels[trust]}”？这不会验证发件身份或授权执行邮件内容。`))) return;
    if (editing && senderId !== editing.defaultSenderAccountId && !(await confirm("更改服务默认邮箱会更新服务版本，旧版本的未派发任务将无法派发，不会改用新邮箱。确认保存？"))) return;
    void action.submit({ path: editing ? `/agent-services/${editing.id}` : "/agent-services", method: editing ? "PATCH" : "POST",
      body: { displayName: name, description, serviceKind: kind, trustLevel: trust, status,
        ...(senderId !== (editing?.defaultSenderAccountId ?? null) ? { defaultSenderAccountId: senderId } : {}),
        ...(editing ? { expectedVersion: editing.version } : { emailAddress: email }) } });
  }
  const locked = action.locked;
  const confirm = useConfirmation([editing, name, email, description, kind, trust, status, senderId, action.locked, visible, list.page]);
  return <Panel className="card" aria-label="Agent 远程服务目录"><h2>Agent 远程服务</h2>
    <form onSubmit={save}><fieldset disabled={locked}>
      <Field label="服务名称"><Input value={name} maxLength={160} required onChange={event => setName(event.target.value)} /></Field>
      <Field label="服务邮箱"><Input value={email} maxLength={512} required disabled={!!editing} onChange={event => setEmail(event.target.value)} /></Field>
      <Field label="服务描述"><Textarea value={description} maxLength={2000} onChange={event => setDescription(event.target.value)} /></Field>
      <Field label="服务类型"><Input value={kind} pattern="[a-z][a-z0-9_-]{0,63}" maxLength={64} required onChange={event => setKind(event.target.value)} /></Field>
      <AgentSenderPicker value={senderId} onChange={setSenderId} disabled={locked} />
      <Field label="信任级别"><Select value={trust} onChange={event => setTrust(event.target.value as AgentService["trustLevel"])}>
        {Object.entries(agentTrustLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select></Field>
      <Field label="服务状态"><Select value={status} onChange={event => setStatus(event.target.value as AgentService["status"])}>
        {Object.entries(agentStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select></Field>
      <div className="row"><Button type="submit" wrap>{editing ? "保存服务修改" : "新增远程服务"}</Button>
        {editing && <Button type="button" onClick={() => edit(null)} variant="quiet" wrap>取消编辑服务</Button>}</div>
    </fieldset></form>
    {action.error && <Notice role="alert" tone="danger">{action.error}</Notice>}
    {action.attempt && <p>服务操作键：<code data-testid="agent-service-operation-key">{action.attempt.key}</code></p>}
    {locked && !action.pending && <Button onClick={() => void action.submit()} wrap>核对原服务操作</Button>}
    <form className="row" onSubmit={event => { event.preventDefault(); list.search({ query, trust: filterTrust, status: filterStatus }); }}>
      <fieldset disabled={list.pending || locked}>
        <Field label="搜索远程服务"><Input value={query} maxLength={160} onChange={event => setQuery(event.target.value)} /></Field>
        <Field label="筛选信任级别"><Select value={filterTrust} onChange={event => setFilterTrust(event.target.value)}><option value="">全部</option>
          {Object.entries(agentTrustLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select></Field>
        <Field label="筛选服务状态"><Select value={filterStatus} onChange={event => setFilterStatus(event.target.value)}><option value="">全部</option>
          {Object.entries(agentStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select></Field>
        <div className="row"><Button type="submit" wrap>搜索远程服务</Button><Button type="button" onClick={list.refresh} variant="quiet" wrap>刷新远程服务</Button></div>
      </fieldset>
    </form>
    {list.error && <Notice role="alert" tone="danger">{list.error}</Notice>}
    <Notice role="status" tone="info">{list.pending ? "读取远程服务…" : `已加载 ${list.page?.items.length ?? 0} 个远程服务`}</Notice>
    <ul>{list.page?.items.map(service => <li key={service.id}><article>
      <strong>{service.displayName}</strong><small>{service.emailAddress}</small>{service.description && <pre>{service.description}</pre>}
      <small>{service.serviceKind} · {agentTrustLabels[service.trustLevel]} · {agentStatusLabels[service.status]} · 版本 {service.version}</small>
      <div className="row"><Button disabled={locked || list.pending} onClick={() => edit(service)} variant="quiet" wrap>编辑服务 {service.displayName}</Button>
        <Button disabled={locked || list.pending} onClick={async () => {
          if ((await confirm(`删除远程服务“${service.displayName}”（${service.emailAddress}）？仅移除平台目录，不会联系或删除远程服务。`))) {
            void action.submit({ path: `/agent-services/${service.id}`, method: "DELETE", body: { expectedVersion: service.version } });
          }
        }} variant="quiet" wrap>删除服务 {service.displayName}</Button></div>
    </article></li>)}</ul>
    {list.page?.nextCursor && <Button disabled={list.pending || locked} onClick={() => void list.loadMore()} wrap>加载更多远程服务</Button>}
  </Panel>;
}
