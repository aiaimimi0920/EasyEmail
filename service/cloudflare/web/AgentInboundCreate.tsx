import { useConfirmation } from "./Confirmation";
import { Button, Field, Notice, Select } from '@neuro/ui';
import { useState } from "react";
import type { AgentIncoming } from "./agent-inbox-api";
import type { AgentInboundInput } from "./agent-inbound-api";
import { useAgentServices } from "./useAgentServices";

export function AgentInboundCreate({ message, accountRevision, disabled, onSubmit }: {
  message: AgentIncoming; accountRevision: number; disabled: boolean; onSubmit: (id: string, body: AgentInboundInput) => void;
}) {
  const services = useAgentServices(true), [selected, setSelected] = useState("");
  const service = services.page?.items.find(row => row.id === selected);
  const eligible = service?.status === "active" && service.trustLevel !== "blocked";
  async function submit() {
    if (disabled || services.pending || !eligible || !service) return;
    if (!(await confirm(`${service.trustLevel === "restricted" ? "所选服务受限。" : ""}为此来信创建入站线程？只建档，不验证发件身份、不发送邮件、不执行邮件内容。`))) return;
    onSubmit(message.id, { accountRevision, epochId: message.epochId, expectedRevision: message.review.revision,
      serviceId: service.id, serviceVersion: service.version, confirmRestricted: service.trustLevel === "restricted" });
  }
  const confirm = useConfirmation([message, accountRevision, service, disabled, services.pending]);
  if (message.inboundThread || message.review.effectiveThreadId) return null;
  return <section aria-label="创建入站线程"><Field label="入站线程服务"><Select value={selected} disabled={disabled || services.pending} onChange={event => setSelected(event.target.value)}>
    <option value="">请选择服务</option>{services.page?.items.filter(row => row.status === "active" && row.trustLevel !== "blocked").map(row =>
      <option key={row.id} value={row.id}>{row.displayName} · {row.emailAddress}</option>)}</Select></Field>
    <Button disabled={disabled || services.pending || !eligible} onClick={submit} wrap>创建入站线程</Button>
    {services.page?.nextCursor && <Button disabled={disabled || services.pending} onClick={() => void services.loadMore()} variant="quiet" wrap>加载更多入站服务</Button>}
    {services.error && <Notice role="alert" tone="danger">{services.error}</Notice>}
    <Button disabled={disabled || services.pending} onClick={services.refresh} variant="quiet" wrap>刷新入站服务</Button>
  </section>;
}
