import { useEffect, useState, type FormEvent } from "react";
import { api, dateText, errorMessage, type Mailbox } from "./api";
import { CreationAcknowledgement, CreationHistory } from "./CreationHistory";
import { useMailboxCreation } from "./useMailboxCreation";

interface Provider { id: string; type: string; allocation: { available: boolean; state: string; cooldownUntil: number | null };
  capabilities: { customPrefix: false | 'preflight-required' } }
interface CustomPrefix { enabled: boolean; minLength: number; maxLength: number; domains: string[] }

export function MailboxAllocation({ visible, onCreated, onRefresh }: { visible: boolean; onCreated: (mailbox: Mailbox) => void; onRefresh: () => void }) {
  const [providers, setProviders] = useState<Provider[]>([]), [providerId, setProviderId] = useState("");
  const [domains, setDomains] = useState<string[]>([]), [domain, setDomain] = useState("");
  const [selection, setSelection] = useState<"manual" | "automatic">("manual"), [autoDomain, setAutoDomain] = useState("");
  const [naming, setNaming] = useState<'random' | 'custom'>('random'), [prefix, setPrefix] = useState('');
  const [custom, setCustom] = useState<CustomPrefix | null>(null), [customError, setCustomError] = useState('');
  const [refresh, setRefresh] = useState(0), [error, setError] = useState("");
  const creation = useMailboxCreation(onCreated), { pending, unresolved } = creation;
  useEffect(() => {
    if (!visible) return;
    let active = true;
    api<{ items: Provider[] }>("/providers").then((catalog) => { if (active) {
      setProviders(catalog.items);
      setProviderId((old) => catalog.items.some((item) => item.id === old) ? old : catalog.items.find((item) => item.allocation.available)?.id ?? catalog.items[0]?.id ?? "");
    } }).catch((failure) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [visible, refresh, creation.refresh]);
  useEffect(() => {
    if (!visible || selection === "automatic" || naming === 'custom') return;
    let active = true;
    setDomains([]); setDomain("");
    if (providerId) api<{ domains: string[] }>(`/providers/${providerId}/domains`)
      .then((response) => { if (active) { setDomains(response.domains); setDomain(response.domains[0] ?? ""); } })
      .catch((failure) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [providerId, visible, selection, naming, refresh, creation.refresh]);
  useEffect(() => {
    setCustom(null); setCustomError('');
    if (!visible || naming !== 'custom' || selection !== 'manual' || !providerId) return;
    let active = true;
    api<{ customPrefix: CustomPrefix }>(`/providers/${providerId}/custom-prefix`).then((response) => {
      if (!active) return;
      setCustom(response.customPrefix);
      setDomain((old) => response.customPrefix.domains.includes(old) ? old : response.customPrefix.domains[0] ?? '');
    }).catch((failure) => { if (active) setCustomError(errorMessage(failure)); });
    return () => { active = false; };
  }, [visible, naming, selection, providerId, refresh, creation.refresh]);

  function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    const body: Record<string, string> = selection === "automatic" ? { selection: "automatic", ...(autoDomain ? { domain: autoDomain } : {}) }
      : { providerId, domain };
    if (naming === 'custom') body.prefix = prefix;
    creation.create(body);
  }
  const provider = providers.find((row) => row.id === providerId);
  const eligible = (row: Provider) => row.allocation.available && (naming === 'random' || row.capabilities.customPrefix === 'preflight-required');
  const available = selection === "automatic" ? providers.some(eligible) : provider && eligible(provider)
    && (naming === 'random' || custom?.enabled && custom.domains.length > 0);
  const displayedDomains = naming === 'custom' ? custom?.domains ?? [] : domains;
  const invalidPrefix = naming === 'custom' && (!/^[a-z0-9]{1,30}$/.test(prefix) || selection === 'manual'
    && (!custom || prefix.length < custom.minLength || prefix.length > custom.maxLength));
  return <>
    <button className="secondary" disabled={pending} onClick={() => { setError(""); setRefresh((value) => value + 1); creation.refreshHistory(); onRefresh(); }}>刷新供应商状态</button>
    {(providers.length > 0 || !!unresolved) && <form className="row" onSubmit={submit}>
      <label>分配方式<select value={selection} disabled={pending || !creation.ready || !!unresolved} onChange={(event) => setSelection(event.target.value as typeof selection)}>
        <option value="manual">手动选择</option><option value="automatic">自动选择</option>
      </select></label>
      <label>命名方式<select value={naming} disabled={pending || !creation.ready || !!unresolved} onChange={(event) => setNaming(event.target.value as typeof naming)}>
        <option value="random">随机前缀</option><option value="custom">自定义前缀</option>
      </select></label>
      {naming === 'custom' && <label>邮箱前缀<input value={prefix} maxLength={custom?.maxLength ?? 30} pattern="[a-z0-9]+" required
        minLength={custom?.minLength ?? 1} disabled={pending || !!unresolved} onChange={(event) => setPrefix(event.target.value)} /></label>}
      {selection === "automatic" ? <label>自动分配域名（可选）<input value={autoDomain} maxLength={253} disabled={pending || !!unresolved} onChange={(event) => setAutoDomain(event.target.value)} /></label> : <>
        <label>供应商<select value={providerId} onChange={(event) => setProviderId(event.target.value)} disabled={pending || !!unresolved}>
          {providers.map((row) => <option key={row.id} value={row.id}>{row.id} · {row.type}{row.allocation.state === "cooling" ? " · 分配冷却中" : row.allocation.state === "unconfigured" ? " · 未配置凭据" : ""}</option>)}
        </select></label>
        <label>域名<select value={domain} onChange={(event) => setDomain(event.target.value)} disabled={pending || !!unresolved}>
          {displayedDomains.map((value) => <option key={value}>{value}</option>)}
        </select></label>
      </>}
      <button disabled={pending || !creation.ready || (!unresolved && (!available || invalidPrefix || selection === "manual" && !domain))}>{unresolved ? "检查创建结果" : naming === 'custom' ? '创建自定义邮箱' : selection === "automatic" ? "自动分配邮箱" : "分配随机邮箱"}</button>
    </form>}
    {selection === "manual" && provider?.allocation.cooldownUntil && <p role="status">此供应商的新分配冷却至 {dateText(provider.allocation.cooldownUntil)}；已有邮箱不受分配冷却影响</p>}
    {unresolved && <p role="status" className="creation-status">{unresolved}</p>}
    {naming === 'custom' && selection === 'manual' && custom && !custom.enabled && <p role="status">此供应商已关闭自定义前缀</p>}
    {naming === 'custom' && customError && <p role="alert">{customError}</p>}
    {(creation.error || error) && <p role="alert">{creation.error || error}</p>}
    {creation.creation && <CreationAcknowledgement key={creation.creation.id} creation={creation.creation} pending={pending} onConfirm={creation.acknowledge} />}
    <CreationHistory visible={visible} refresh={refresh + creation.refresh} pending={pending} lockedKey={creation.lockedKey} onSelect={creation.select} onRecover={creation.recover} />
  </>;
}
