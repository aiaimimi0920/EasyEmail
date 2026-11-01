import type { OrganizationGroup, GroupState } from "./mixed-organization-plan";

const STATES: Record<GroupState, string> = { ready: "未执行", pending: "处理中", unknown: "结果未确认", completed: "已完成", rejected: "此组被拒绝", skipped: "已取消未执行组" };
export function MixedOrganizationStatus({ groups, pending, error, reconcile, retry, resume, skipReady }: {
  groups: OrganizationGroup[]; pending: boolean; error: string; reconcile: (id: string) => void; retry: (id: string) => void; resume: () => void; skipReady: () => void;
}) {
  if (!groups.length) return error ? <p role="alert">{error}</p> : null;
  const count = (state: GroupState) => groups.filter(group => group.state === state).length;
  const completed = groups.filter(group => group.state === "completed").reduce((total, group) => total + group.body.messageIds.length, 0);
  return <section className="card" aria-label="批量整理结果"><h2>批量整理结果</h2>
    <p role="status">已完成 {completed} 封；拒绝 {count("rejected")} 组；未确认 {count("unknown")} 组；未执行 {count("ready")} 组；已取消 {count("skipped")} 组</p>
    <small>按来源、普通账号和服务器目录分别提交，不是跨组事务。</small>
    {error && <p role="alert">{error}</p>}
    <ul>{groups.map(group => <li key={group.id}><div><strong>{group.name}</strong><span> · {group.body.messageIds.length} 封 · {STATES[group.state]}</span>
      {group.error && <p role="alert">此组：{group.error}</p>}
      {group.state === "unknown" && <><small>原操作键：<code>{group.key}</code></small><div className="row">
        <button disabled={pending} onClick={() => reconcile(group.id)}>只读核对 {group.name}</button>
        <button disabled={pending} onClick={() => retry(group.id)}>原键重试 {group.name}</button></div></>}
    </div></li>)}</ul>
    {count("ready") > 0 && <div className="row"><button disabled={pending || count("unknown") > 0} onClick={resume}>继续未执行组</button>
      <button className="secondary" disabled={pending} onClick={skipReady}>取消未执行组</button></div>}
  </section>;
}
