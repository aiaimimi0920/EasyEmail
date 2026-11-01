import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type Page } from "./api";
import { readAgentSenderPage } from "./agent-sender-options";
import type { AgentAccount } from "./agent-accounts-api";

export function AgentSenderPicker({ value, onChange, disabled }: { value: string | null; onChange: (value: string | null) => void; disabled: boolean }) {
  const [page, setPage] = useState<Page<AgentAccount> | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const active = useRef(false), busy = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function load(more = false) {
    if (busy.current || disabled) return; busy.current = true; setPending(true); setError("");
    try {
      const next = readAgentSenderPage(await api(`/agent-accounts?limit=100${more && page?.nextCursor ? `&cursor=${page.nextCursor}` : ""}`));
      if (active.current) setPage(old => ({ ...next, items: more ? [...new Map([...(old?.items ?? []), ...next.items].map(item => [item.id, item])).values()] : next.items }));
    } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  return <div>
    <label>服务默认发件邮箱<select value={value ?? ""} disabled={disabled || pending} onChange={event => onChange(event.target.value || null)}>
      <option value="">无默认邮箱</option>
      {value && !page?.items.some(row => row.id === value) && <option value={value}>已配置账号（未加载）</option>}
      {page?.items.map(row => <option key={row.id} value={row.id}>{row.displayName || row.emailAddress}{!row.enabled || !row.credentialConfigured ? "（当前不可用）" : ""}</option>)}
    </select></label>
    <button type="button" className="secondary" disabled={disabled || pending} onClick={() => void load()}>加载 Agent 发件邮箱</button>
    {page?.nextCursor && <button type="button" className="secondary" disabled={disabled || pending} onClick={() => void load(true)}>加载更多默认邮箱选项</button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
