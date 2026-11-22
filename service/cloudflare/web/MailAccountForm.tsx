import { Button, Checkbox, Field, Input, Select } from '@neuro/ui';
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
      <Field label="邮箱地址"><Input name="emailAddress" type="email" maxLength={254} required defaultValue={account?.emailAddress ?? ""} readOnly={immutableAddress && account !== null} /></Field>
      <Field label="邮箱名称"><Input name="displayName" maxLength={100} defaultValue={account?.displayName ?? ""} /></Field>
      <Field label="IMAP 服务器"><Select name="endpointId" required value={endpointId} onChange={event => setEndpointId(event.target.value)}>
        {endpoints.map(endpoint => <option key={endpoint.id} value={endpoint.id}>{endpoint.label} · {endpoint.hostname}:{endpoint.port} {endpoint.security === "starttls" ? "STARTTLS" : "TLS"}</option>)}
      </Select></Field>
      <Field label="IMAP 用户名"><Input name="username" autoComplete="off" maxLength={255} required defaultValue={account?.username ?? ""} /></Field>
      {!oauth && <Field label="IMAP 应用密码"><Input name="password" type="password" autoComplete="new-password" maxLength={1024} required={!account} placeholder={account ? "留空保留原凭据" : "使用邮箱服务商的应用密码"} /></Field>}
      {oauth && <p>保存后发起 Google 授权；用户名须与邮箱地址一致</p>}
      {(!oauth || account?.authentication === "google-oauth2" && account.credentialConfigured) && <Checkbox name="enabled" defaultChecked={account?.enabled ?? true} label="允许平台连接" />}
      {account && !oauth && <Checkbox name="forgetCredential" label="忘记凭据（须同时关闭连接）" />}
      <Button type="submit" disabled={!endpoints.length} wrap>{`保存${separator}${label}`}</Button>
    </fieldset>
  </form>;
}
