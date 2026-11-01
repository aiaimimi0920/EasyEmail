import { useState, type FormEvent } from "react";
import type { ImapEndpoint, NormalAccount } from "./normal-accounts";

export function MailAccountForm({ account, endpoints, disabled, onSave, onDirty, label = "普通邮箱", immutableAddress = false }: {
  account: Omit<NormalAccount, "deleted"> | null; endpoints: ImapEndpoint[]; disabled: boolean;
  onSave(body: Record<string, unknown>): void; onDirty(): void; label?: string; immutableAddress?: boolean;
}) {
  const [endpointId, setEndpointId] = useState(account?.endpointId ?? endpoints[0]?.id ?? "");
  const oauth = endpoints.find(row => row.id === endpointId)?.authentication === "google-oauth2";
  const separator = /^[A-Za-z]/.test(label) ? " " : "";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const fields = new FormData(event.currentTarget), password = String(fields.get("password") ?? "");
    onSave({ expectedRevision: account?.revision ?? 0, emailAddress: fields.get("emailAddress"), displayName: fields.get("displayName"),
      endpointId: fields.get("endpointId"), username: fields.get("username"), ...(password ? { password } : {}),
      enabled: oauth && (!account?.credentialConfigured || account.authentication !== "google-oauth2") ? false : fields.get("enabled") === "on",
      forgetCredential: fields.get("forgetCredential") === "on" });
  }
  return <form onSubmit={submit} onChange={onDirty} aria-label={`${label}配置`}>
    <fieldset disabled={disabled}>
      <legend>{account ? `编辑${separator}${label}` : `添加${separator}${label}`}</legend>
      <label>邮箱地址<input name="emailAddress" type="email" maxLength={254} required defaultValue={account?.emailAddress ?? ""} readOnly={immutableAddress && account !== null} /></label>
      <label>邮箱名称<input name="displayName" maxLength={100} defaultValue={account?.displayName ?? ""} /></label>
      <label>IMAP 服务器<select name="endpointId" required value={endpointId} onChange={event => setEndpointId(event.target.value)}>
        {endpoints.map(endpoint => <option key={endpoint.id} value={endpoint.id}>{endpoint.label} · {endpoint.hostname}:{endpoint.port} {endpoint.security === "starttls" ? "STARTTLS" : "TLS"}</option>)}
      </select></label>
      <label>IMAP 用户名<input name="username" autoComplete="off" maxLength={255} required defaultValue={account?.username ?? ""} /></label>
      {!oauth && <label>IMAP 应用密码<input name="password" type="password" autoComplete="new-password" maxLength={1024} required={!account}
        placeholder={account ? "留空保留原凭据" : "使用邮箱服务商的应用密码"} /></label>}
      {oauth && <p>保存后发起 Google 授权；用户名须与邮箱地址一致</p>}
      {(!oauth || account?.authentication === "google-oauth2" && account.credentialConfigured) && <label className="check"><input type="checkbox" name="enabled" defaultChecked={account?.enabled ?? true} />允许平台连接</label>}
      {account && !oauth && <label className="check"><input type="checkbox" name="forgetCredential" />忘记凭据（须同时关闭连接）</label>}
      <button type="submit" disabled={!endpoints.length}>{`保存${separator}${label}`}</button>
    </fieldset>
  </form>;
}
