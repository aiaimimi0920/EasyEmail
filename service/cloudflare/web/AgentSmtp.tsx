import { useConfirmation } from "./Confirmation";
import { Button, Checkbox, Field, Input, Notice, Select } from '@neuro/ui';
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
  const confirm = useConfirmation([account, locked, state.config, state.endpointId, state.username, state.password, state.enabled, state.forget]);
  return <section aria-label="Agent 邮箱 SMTP"><h3>SMTP 配置</h3>
    <Button disabled={locked} onClick={async () => {
      if (canAct?.() !== false && (!state.dirty || (await confirm("刷新将丢弃未保存的 Agent SMTP 配置，确认刷新？")))) void state.refresh();
    }} variant="quiet" wrap>刷新 Agent SMTP 配置</Button>
    {state.config && <><p>SMTP 凭据：{state.config.credentialConfigured ? "已加密保存" : "未保存"} · 版本 {state.config.revision}</p>
      {!state.config.current && state.config.revision > 0 && <Notice role="status" tone="info">{account.authentication === "google-oauth2" ? "邮箱配置已变化，须重新绑定 Google 发信授权" : "邮箱配置已变化，启用 SMTP 须重新提供应用密码"}</Notice>}
      <form onSubmit={event => { event.preventDefault(); if (canAct?.() !== false) void state.save(); }} onChange={state.markDirty}>
        <Field label="Agent SMTP 服务器"><Select value={state.endpointId} disabled={locked} required onChange={event => state.setEndpointId(event.target.value)}>
          <option value="">请选择</option>{state.endpoints.map(row => <option key={row.id} value={row.id}>{row.label} · {row.hostname}:{row.port} {row.security === "starttls" ? "STARTTLS" : "TLS"}</option>)}
        </Select></Field>
        <Field label="Agent SMTP 用户名"><Input value={state.username} maxLength={255} required disabled={locked} readOnly={account.authentication === "google-oauth2"} onChange={event => state.setUsername(event.target.value)} /></Field>
        {account.authentication !== "google-oauth2" && <Field label="Agent SMTP 应用密码"><Input type="password" autoComplete="new-password" value={state.password} maxLength={1024} disabled={locked} onChange={event => state.setPassword(event.target.value)} /></Field>}
        <Checkbox checked={state.enabled} disabled={locked} onChange={event => state.setEnabled(event.target.checked)} label="启用 Agent SMTP 配置" />
        <Checkbox checked={state.forget} disabled={locked} onChange={event => state.setForget(event.target.checked)} label="忘记 Agent SMTP 凭据（须同时关闭配置）" />
        <Button disabled={locked || !state.endpointId} type="submit" wrap>保存 Agent SMTP 配置</Button>
      </form>
      {state.endpoints.length === 0 && <Notice role="status" tone="info">尚未配置匹配的 SMTP 服务器</Notice>}
    </>}
    {state.dirty && <Notice role="status" tone="info">SMTP 配置有未保存修改</Notice>}
    {state.attempt && <Button disabled={state.pending} onClick={() => void state.save()} wrap>核对原 Agent SMTP 配置</Button>}
    {state.error && <Notice role="alert" tone="danger">{state.error}</Notice>}{state.notice && <Notice role="status" tone="info">{state.notice}</Notice>}
  </section>;
}
