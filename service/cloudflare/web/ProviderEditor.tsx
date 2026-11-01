import { useState, type FormEvent } from "react";
import { api, errorMessage } from "./api";
import { emptyProvider, type ProviderConfig, type ProviderState } from "./admin-api";

export function ProviderEditor({ initial, onSaved, onCancel }: {
  initial: ProviderState | null; onSaved: () => void; onCancel: () => void;
}) {
  const [config, setConfig] = useState(initial?.config ?? emptyProvider());
  const [domains, setDomains] = useState(config.domains.join("\n"));
  const [recipients, setRecipients] = useState(config.sendRecipients.join("\n"));
  const [secretAction, setSecretAction] = useState("keep");
  const [apiKey, setApiKey] = useState(""), [sitePassword, setSitePassword] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const update = (value: Partial<ProviderConfig>) => setConfig({ ...config, ...value });
  const split = (value: string) => value.split(/[,\s]+/).filter(Boolean);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = { ...config, domains: split(domains), sendRecipients: config.type === "cloudflare" ? split(recipients) : [] };
    const clearPrompt = ["duckmail", "guerrillamail"].includes(next.type) && next.authentication === "anonymous"
      ? "清除平台供应商凭据？不会退回环境凭据；当前显式配置的上游匿名访问仍保留。"
      : "清除平台供应商凭据？不会退回环境凭据，后续外部操作将被阻止。";
    if (secretAction === "clear" && !window.confirm(clearPrompt)) return;
    if (next.sendTransport && (next.sendTransport !== initial?.config.sendTransport || JSON.stringify(next.sendRecipients) !== JSON.stringify(initial?.config.sendRecipients))
      && !window.confirm("确认启用或修改发送渠道及收件范围？渠道接受不代表最终送达。")) return;
    setPending(true); setError("");
    try {
      await api(`/admin/providers/${config.id}`, "PUT", { expectedRevision: initial?.revision ?? 0, config: next, secretAction,
        ...(secretAction === "replace" ? { secret: { apiKey, ...(config.type === "cloudflare" ? { sitePassword } : {}) } } : {}) });
      onSaved();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setApiKey(""); setSitePassword(""); setPending(false); }
  }

  return <section className="card" aria-label="供应商配置编辑">
    <h3>{initial ? `编辑 ${config.id} · 版本 ${initial.revision}` : "新增供应商实例"}</h3>
    <form onSubmit={submit} autoComplete="off">
      <fieldset disabled={pending}>
        <label>实例 ID<input value={config.id} required pattern="[a-z][a-z0-9-]{0,47}" maxLength={48} disabled={!!initial}
          onChange={(event) => update({ id: event.target.value })} /></label>
        <label>供应商类型<select value={config.type} disabled={!!initial} onChange={(event) => {
          const type = event.target.value as ProviderConfig["type"];
          update({ type, authentication: type === "guerrillamail" ? "anonymous" : undefined, sendTransport: undefined, sendRecipients: [] }); setRecipients("");
          setSecretAction("keep"); setApiKey(""); setSitePassword("");
        }}><option value="cloudflare">Cloudflare Email</option><option value="temporam">Temporam</option><option value="moemail">MoEmail</option><option value="gptmail">GPTMail</option><option value="duckmail">DuckMail</option><option value="guerrillamail">GuerrillaMail</option><option value="im215">215.im</option></select></label>
        <label>API 地址<input type="url" value={config.baseUrl} required maxLength={2048} disabled={!!initial}
          onChange={(event) => update({ baseUrl: event.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={config.enabled} onChange={(event) => update({ enabled: event.target.checked })} />启用供应商</label>
        <label>域名白名单<textarea value={domains} required={["gptmail", "guerrillamail"].includes(config.type)} maxLength={6000} onChange={(event) => setDomains(event.target.value)} /></label>
        {["duckmail", "guerrillamail"].includes(config.type) && <label>上游访问方式<select value={config.authentication ?? "api-key"}
          onChange={(event) => update({ authentication: event.target.value as ProviderConfig["authentication"] })}>
          {config.type !== "guerrillamail" && <option value="api-key">平台 API Key</option>}<option value="anonymous">公共匿名接口</option>
        </select></label>}
        {config.type === "cloudflare" && <>
          <label>发送渠道<select value={config.sendTransport ?? ""} onChange={(event) => update({ sendTransport: event.target.value as ProviderConfig["sendTransport"] || undefined })}>
            <option value="">关闭发送</option><option value="worker">邮箱 JWT 发信</option><option value="binding">管理员 Binding 发信</option>
          </select></label>
          <label>允许收件地址<textarea value={recipients} maxLength={6000} onChange={(event) => setRecipients(event.target.value)} placeholder="每行一个；单独 * 允许任意收件人" /></label>
        </>}
        <label>凭据操作<select value={secretAction} onChange={(event) => { setSecretAction(event.target.value); setApiKey(""); setSitePassword(""); }}>
          <option value="keep">保留当前凭据</option>{config.type !== "guerrillamail" && <option value="replace">替换凭据</option>}<option value="clear">清除凭据</option>
        </select></label>
        {secretAction === "replace" && <>
          <label>供应商 API Key<input type="password" autoComplete="off" value={apiKey} required maxLength={4096} onChange={(event) => setApiKey(event.target.value)} /></label>
          {config.type === "cloudflare" && <label>站点密码<input type="password" autoComplete="off" value={sitePassword} maxLength={4096} onChange={(event) => setSitePassword(event.target.value)} /></label>}
        </>}
        {error && <p role="alert">{error}</p>}
        <div className="row"><button type="submit">{pending ? "保存中…" : "保存供应商"}</button><button type="button" className="secondary" onClick={onCancel}>取消编辑</button></div>
      </fieldset>
    </form>
  </section>;
}
