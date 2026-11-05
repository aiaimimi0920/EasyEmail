import { useConfirmation } from "./Confirmation";
import { Button, Checkbox, Field, Input, Notice, Select } from '@neuro/ui';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, errorMessage } from "./api";
import type { NormalAccount } from "./normal-accounts";
import { NormalSend } from "./NormalSend";
import type { NormalReplyIntent, ReplyGuard } from "./NormalReply";

interface Config { revision: number; accountRevision: number; endpointId: string; username: string; credentialConfigured: boolean; enabled: boolean; current: boolean }
interface Endpoint { id: string; label: string; hostname: string; port: number; security?: "tls" | "starttls"; authentication?: "password" | "google-oauth2" }
interface Write { accountId: string; key: string; body: Record<string, unknown> }
export function NormalSmtp({ account, disabled, onBusy, reply, replyGuard, onReplyConsumed }: {
  account: NormalAccount; disabled: boolean; onBusy: (busy: boolean) => void;
  reply: NormalReplyIntent | null; replyGuard: ReplyGuard; onReplyConsumed: () => void;
}) {
  const [config, setConfig] = useState<Config | null>(null), [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [endpointId, setEndpointId] = useState(""), [username, setUsername] = useState(""), [password, setPassword] = useState("");
  const [enabled, setEnabled] = useState(false), [forget, setForget] = useState(false), [dirty, setDirty] = useState(false);
  const [attempt, setAttempt] = useState<Write | null>(null), [pending, setPending] = useState(false), [sendLocked, setSendLocked] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [refreshRevision, setRefreshRevision] = useState(0);
  const busy = useRef(false);
  const oauth = account.authentication === "google-oauth2";
  const sendGuard = useRef<(() => boolean) | null>(null);
  useLayoutEffect(() => {
    const check = () => !disabled && !busy.current && !pending && !attempt && !dirty && sendGuard.current?.() === true;
    replyGuard.current = check;
    return () => { if (replyGuard.current === check) replyGuard.current = null; };
  });
  const locked = pending || !!attempt || sendLocked;
  const reportSend = useCallback((value: boolean) => setSendLocked(value), []);
  useEffect(() => { onBusy(locked || dirty); }, [locked, dirty, onBusy]);
  useEffect(() => {
    const controller = new AbortController(); setConfig(null); setError(""); setNotice(""); setPassword(""); setForget(false); setDirty(false);
    void Promise.all([api<{ smtp: Config }>(`/normal-accounts/${account.id}/smtp`, "GET", undefined, undefined, controller.signal),
      api<{ items: Endpoint[] }>("/normal-accounts/smtp-endpoints", "GET", undefined, undefined, controller.signal)]).then(([response, servers]) => {
      if (controller.signal.aborted) return;
      const compatible = servers.items.filter(row => (row.authentication === "google-oauth2") === oauth);
      setConfig(response.smtp); setEndpoints(compatible); setEndpointId(response.smtp.endpointId || compatible[0]?.id || "");
      setUsername(response.smtp.username || account.username); setEnabled(response.smtp.enabled);
    }).catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [account.id, account.revision, refreshRevision]);
  async function save(event?: FormEvent) {
    event?.preventDefault(); if (busy.current || (!config && !attempt)) return; busy.current = true;
    const current = attempt ?? { accountId: account.id, key: crypto.randomUUID(), body: { expectedRevision: account.revision, smtpRevision: config!.revision,
      endpointId, username, ...(password ? { password } : {}), enabled, forgetCredential: forget } };
    setAttempt(current); setPending(true); setError(""); setNotice(""); setPassword("");
    try {
      const response = await api<{ smtp: Config }>(`/normal-accounts/${current.accountId}/smtp`, "PUT", current.body, { "idempotency-key": current.key });
      setConfig(response.smtp); setAttempt(null); setDirty(false); setForget(false); setNotice("SMTP 配置已保存");
    } catch (failure) {
      setError(errorMessage(failure));
      if (!attempt && failure instanceof ApiError && failure.status < 500) setAttempt(null);
    } finally { busy.current = false; setPending(false); }
  }
  const confirm = useConfirmation([account.id, account.revision, config, endpointId, username, password, enabled, forget, disabled, locked]);
  return <section aria-label="普通邮箱 SMTP"><h3>SMTP 配置</h3>
    <Button disabled={disabled || locked} onClick={async () => {
      if (!dirty || (await confirm("刷新将丢弃未保存的 SMTP 配置，确认刷新？"))) setRefreshRevision(value => value + 1);
    }} variant="quiet" wrap>刷新 SMTP 配置</Button>
    {config && <><p>SMTP 凭据：{config.credentialConfigured ? "已加密保存" : "未保存"} · 版本 {config.revision}</p>
      {!config.current && config.revision > 0 && <Notice role="status" tone="info">{oauth ? "账号版本已变化，请重新保存 SMTP 授权配置" : "账号版本已变化，请重新提供 SMTP 应用密码并保存"}</Notice>}
      <form onSubmit={event => void save(event)} onChange={() => setDirty(true)}>
        <Field label="SMTP 服务器"><Select value={endpointId} disabled={disabled || locked} onChange={event => setEndpointId(event.target.value)} required>
          <option value="">请选择</option>{endpoints.map(row => <option key={row.id} value={row.id}>{row.label} · {row.hostname}:{row.port} {row.security === "starttls" ? "STARTTLS" : "TLS"}</option>)}
        </Select></Field>
        <Field label="SMTP 用户名"><Input value={username} maxLength={255} required disabled={disabled || locked} onChange={event => setUsername(event.target.value)} /></Field>
        {!oauth && <Field label="SMTP 应用密码"><Input type="password" autoComplete="new-password" value={password} maxLength={1024} disabled={disabled || locked} onChange={event => setPassword(event.target.value)} /></Field>}
        {oauth && <p>SMTP 使用此邮箱的 Google 授权，不向网页返回令牌</p>}
        <Checkbox checked={enabled} disabled={disabled || locked} onChange={event => setEnabled(event.target.checked)} label="允许 SMTP 发信" />
        <Checkbox checked={forget} disabled={disabled || locked} onChange={event => setForget(event.target.checked)} label="忘记 SMTP 凭据（须同时关闭发信）" />
        <Button disabled={disabled || locked || !endpointId} type="submit" wrap>保存 SMTP 配置</Button>
      </form>
      {attempt && <Button disabled={pending} onClick={() => void save()} wrap>核对原 SMTP 配置</Button>}
    </>}
    <NormalSend key={`${account.id}:${account.revision}`} account={account} smtp={config ?? { revision: 0, enabled: false, current: false, credentialConfigured: false }}
      disabled={disabled || !config || pending || !!attempt || dirty} onBusy={reportSend}
      reply={reply} replyGuard={sendGuard} onReplyConsumed={onReplyConsumed} />
    {endpoints.length === 0 && config && <Notice role="status" tone="info">尚未配置 SMTP 服务器</Notice>}
    {error && <Notice role="alert" tone="danger">{error}</Notice>}{notice && <Notice role="status" tone="info">{notice}</Notice>}
  </section>;
}
