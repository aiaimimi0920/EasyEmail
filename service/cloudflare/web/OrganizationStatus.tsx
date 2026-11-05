import { Button, Notice } from '@neuro/ui';
import type { OrganizationController } from "./useOrganization";

export function OrganizationStatus({ action }: { action: OrganizationController }) {
  return <>
    {action.status && <Notice role="status" tone="info">{action.status}</Notice>}
    {action.error && <Notice role="alert" tone="danger">{action.error}</Notice>}
    {action.key && <div className="secret"><small>本次整理键：<code data-testid="organization-key">{action.key}</code></small>
      {!action.pending && <Button onClick={() => action.submit()} wrap>核对并完成原整理</Button>}</div>}
  </>;
}
