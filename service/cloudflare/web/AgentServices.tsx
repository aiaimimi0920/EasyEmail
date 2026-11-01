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
  function save(event: FormEvent) {
    event.preventDefault();
    if (trust !== (editing?.trustLevel ?? "unknown") && !window.confirm(`将远程服务“${name}”的信任级别设置为“${agentTrustLabels[trust]}”？这不会验证发件身份或授权执行邮件内容。`)) return;
    if (editing && senderId !== editing.defaultSenderAccountId && !window.confirm("更改服务默认邮箱会更新服务版本，旧版本的未派发任务将无法派发，不会改用新邮箱。确认保存？")) return;
    void action.submit({ path: editing ? `/agent-services/${editing.id}` : "/agent-services", method: editing ? "PATCH" : "POST",
      body: { displayName: name, description, serviceKind: kind, trustLevel: trust, status,
        ...(senderId !== (editing?.defaultSenderAccountId ?? null) ? { defaultSenderAccountId: senderId } : {}),
        ...(editing ? { expectedVersion: editing.version } : { emailAddress: email }) } });
  }
  const locked = action.locked;
  return <section className="card" aria-label="Agent 远程服务目录"><h2>Agent 远程服务</h2>
    <form onSubmit={save}><fieldset disabled={locked}>
      <label>服务名称<input value={name} maxLength={160} required onChange={event => setName(event.target.value)} /></label>
      <label>服务邮箱<input value={email} maxLength={512} required disabled={!!editing} onChange={event => setEmail(event.target.value)} /></label>
      <label>服务描述<textarea value={description} maxLength={2000} onChange={event => setDescription(event.target.value)} /></label>
      <label>服务类型<input value={kind} pattern="[a-z][a-z0-9_-]{0,63}" maxLength={64} required onChange={event => setKind(event.target.value)} /></label>
      <AgentSenderPicker value={senderId} onChange={setSenderId} disabled={locked} />
      <label>信任级别<select value={trust} onChange={event => setTrust(event.target.value as AgentService["trustLevel"])}>
        {Object.entries(agentTrustLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>服务状态<select value={status} onChange={event => setStatus(event.target.value as AgentService["status"])}>
        {Object.entries(agentStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <div className="row"><button>{editing ? "保存服务修改" : "新增远程服务"}</button>
        {editing && <button type="button" className="secondary" onClick={() => edit(null)}>取消编辑服务</button>}</div>
    </fieldset></form>
    {action.error && <p role="alert">{action.error}</p>}
    {action.attempt && <p>服务操作键：<code data-testid="agent-service-operation-key">{action.attempt.key}</code></p>}
    {locked && !action.pending && <button onClick={() => void action.submit()}>核对原服务操作</button>}
    <form className="row" onSubmit={event => { event.preventDefault(); list.search({ query, trust: filterTrust, status: filterStatus }); }}>
      <fieldset disabled={list.pending || locked}>
        <label>搜索远程服务<input value={query} maxLength={160} onChange={event => setQuery(event.target.value)} /></label>
        <label>筛选信任级别<select value={filterTrust} onChange={event => setFilterTrust(event.target.value)}><option value="">全部</option>
          {Object.entries(agentTrustLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>筛选服务状态<select value={filterStatus} onChange={event => setFilterStatus(event.target.value)}><option value="">全部</option>
          {Object.entries(agentStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <div className="row"><button>搜索远程服务</button><button type="button" className="secondary" onClick={list.refresh}>刷新远程服务</button></div>
      </fieldset>
    </form>
    {list.error && <p role="alert">{list.error}</p>}
    <p role="status">{list.pending ? "读取远程服务…" : `已加载 ${list.page?.items.length ?? 0} 个远程服务`}</p>
    <ul>{list.page?.items.map(service => <li key={service.id}><article>
      <strong>{service.displayName}</strong><small>{service.emailAddress}</small>{service.description && <pre>{service.description}</pre>}
      <small>{service.serviceKind} · {agentTrustLabels[service.trustLevel]} · {agentStatusLabels[service.status]} · 版本 {service.version}</small>
      <div className="row"><button className="secondary" disabled={locked || list.pending} onClick={() => edit(service)}>编辑服务 {service.displayName}</button>
        <button className="secondary" disabled={locked || list.pending} onClick={() => {
          if (window.confirm(`删除远程服务“${service.displayName}”（${service.emailAddress}）？仅移除平台目录，不会联系或删除远程服务。`)) {
            void action.submit({ path: `/agent-services/${service.id}`, method: "DELETE", body: { expectedVersion: service.version } });
          }
        }}>删除服务 {service.displayName}</button></div>
    </article></li>)}</ul>
    {list.page?.nextCursor && <button disabled={list.pending || locked} onClick={() => void list.loadMore()}>加载更多远程服务</button>}
  </section>;
}
