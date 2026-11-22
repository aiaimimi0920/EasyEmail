import { Button, Notice, Panel } from '@neuro/ui';
import type { OrganizationGroup, GroupState } from "./mixed-organization-plan";

const STATES: Record<GroupState, string> = { ready: "未执行", pending: "处理中", unknown: "结果未确认", completed: "已完成", rejected: "此组被拒绝", skipped: "已取消未执行组" };
export function MixedOrganizationStatus({ groups, pending, error, reconcile, retry, resume, skipReady }: {
  groups: OrganizationGroup[]; pending: boolean; error: string; reconcile: (id: string) => void; retry: (id: string) => void; resume: () => void; skipReady: () => void;
}) {
  if (!groups.length) return error ? <Notice role="alert" tone="danger">{error}</Notice> : null;
  const count = (state: GroupState) => groups.filter(group => group.state === state).length;
  const completed = groups.filter(group => group.state === "completed").reduce((total, group) => total + group.body.messageIds.length, 0);
  return <Panel className="card" aria-label="批量整理结果"><h2>批量整理结果</h2>
    <Notice role="status" tone="info">已完成 {completed} 封；拒绝 {count("rejected")} 组；未确认 {count("unknown")} 组；未执行 {count("ready")} 组；已取消 {count("skipped")} 组</Notice>
    <small>按来源、普通账号和服务器目录分别提交，不是跨组事务。</small>
    {error && <Notice role="alert" tone="danger">{error}</Notice>}
    <ul>{groups.map(group => <li key={group.id}><div><strong>{group.name}</strong><span> · {group.body.messageIds.length} 封 · {STATES[group.state]}</span>
      {group.error && <Notice role="alert" tone="danger">此组：{group.error}</Notice>}
      {group.state === "unknown" && <><small>原操作键：<code>{group.key}</code></small><div className="row">
        <Button disabled={pending} onClick={() => reconcile(group.id)} wrap>只读核对 {group.name}</Button>
        <Button disabled={pending} onClick={() => retry(group.id)} wrap>原键重试 {group.name}</Button></div></>}
    </div></li>)}</ul>
    {count("ready") > 0 && <div className="row"><Button disabled={pending || count("unknown") > 0} onClick={resume} wrap>继续未执行组</Button>
      <Button disabled={pending} onClick={skipReady} variant="quiet" wrap>取消未执行组</Button></div>}
  </Panel>;
}
