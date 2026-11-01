import type { OrganizationController } from "./useOrganization";

export function OrganizationStatus({ action }: { action: OrganizationController }) {
  return <>
    {action.status && <p role="status">{action.status}</p>}
    {action.error && <p role="alert">{action.error}</p>}
    {action.key && <div className="secret"><small>本次整理键：<code data-testid="organization-key">{action.key}</code></small>
      {!action.pending && <button onClick={() => action.submit()}>核对并完成原整理</button>}</div>}
  </>;
}
