import { useEffect, useLayoutEffect } from "react";
import type { AgentAccount } from "./agent-accounts-api";
import { useAgentSmtp } from "./useAgentSmtp";

export function AgentSmtp({ account, disabled, onBusy, guard, canAct }: {
  account: AgentAccount; disabled: boolean; onBusy: (busy: boolean) => void; guard: { current: (() => boolean) | null };
  canAct?: () => boolean;
}) {
  const state = useAgentSmtp(account, disabled), locked = disabled || state.locked;
  useLayoutEffect(() => { guard.current = state.canLeave; return () => { if (guard.current === state.canLeave) guard.current = null; }; });
  useEffect(() => { onBusy(state.locked || state.dirty); }, [onBusy, state.locked, state.dirty]);
  useEffect(() => () => onBusy(false), [onBusy]);
  return <section aria-label="Agent 邮箱 SMTP"><h3>SMTP 配置</h3>
    <button className="secondary" disabled={locked} onClick={() => {
      if (canAct?.() !== false && (!state.dirty || window.confirm("刷新将丢弃未保存的 Agent SMTP 配置，确认刷新？"))) void state.refresh();
    }}>刷新 Agent SMTP 配置</button>
    {state.config && <><p>SMTP 凭据：{state.config.credentialConfigured ? "已加密保存" : "未保存"} · 版本 {state.config.revision}</p>
      {!state.config.current && state.config.revision > 0 && <p role="status">{account.authentication === "google-oauth2" ? "邮箱配置已变化，须重新绑定 Google 发信授权" : "邮箱配置已变化，启用 SMTP 须重新提供应用密码"}</p>}
      <form onSubmit={event => { event.preventDefault(); if (canAct?.() !== false) void state.save(); }} onChange={state.markDirty}>
        <label>Agent SMTP 服务器<select value={state.endpointId} disabled={locked} required onChange={event => state.setEndpointId(event.target.value)}>
          <option value="">请选择</option>{state.endpoints.map(row => <option key={row.id} value={row.id}>{row.label} · {row.hostname}:{row.port} {row.security === "starttls" ? "STARTTLS" : "TLS"}</option>)}
        </select></label>
        <label>Agent SMTP 用户名<input value={state.username} maxLength={255} required disabled={locked} readOnly={account.authentication === "google-oauth2"} onChange={event => state.setUsername(event.target.value)} /></label>
        {account.authentication !== "google-oauth2" && <label>Agent SMTP 应用密码<input type="password" autoComplete="new-password" value={state.password} maxLength={1024} disabled={locked} onChange={event => state.setPassword(event.target.value)} /></label>}
        <label><input type="checkbox" checked={state.enabled} disabled={locked} onChange={event => state.setEnabled(event.target.checked)} />启用 Agent SMTP 配置</label>
        <label><input type="checkbox" checked={state.forget} disabled={locked} onChange={event => state.setForget(event.target.checked)} />忘记 Agent SMTP 凭据（须同时关闭配置）</label>
        <button disabled={locked || !state.endpointId}>保存 Agent SMTP 配置</button>
      </form>
      {state.endpoints.length === 0 && <p role="status">尚未配置匹配的 SMTP 服务器</p>}
    </>}
    {state.dirty && <p role="status">SMTP 配置有未保存修改</p>}
    {state.attempt && <button disabled={state.pending} onClick={() => void state.save()}>核对原 Agent SMTP 配置</button>}
    {state.error && <p role="alert">{state.error}</p>}{state.notice && <p role="status">{state.notice}</p>}
  </section>;
}
