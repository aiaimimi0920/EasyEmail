import { useConfirmation } from "./Confirmation";
import { Button, Notice, Panel } from '@neuro/ui';
import { useCallback, useRef, useState } from "react";
import { dateText, errorMessage, ApiError } from "./api";
import { MailAccountForm } from "./MailAccountForm";
import { useAgentAccounts } from "./useAgentAccounts";
import { AgentSmtp } from "./AgentSmtp";
import { AgentInbox } from "./AgentInbox";
import { AgentAutoInbox } from "./AgentAutoInbox";
import { useAgentAutoInbox } from "./useAgentAutoInbox";
import { GoogleAuthorization } from "./GoogleAuthorization";

export function AgentAccounts({ visible, authorizedId }: { visible: boolean; authorizedId?: string }) {
  const state = useAgentAccounts(visible, authorizedId), account = state.selected;
  const [oauthBusy, setOauthBusy] = useState(false);
  const [dirtyForm, setDirtyForm] = useState("");
  const [smtpBusy, setSmtpBusy] = useState(false), smtpGuard = useRef<(() => boolean) | null>(null);
  const [inboxBusy, setInboxBusy] = useState(false), reportInbox = useCallback((value: boolean) => setInboxBusy(value), []);
  const reportSmtp = useCallback((value: boolean) => setSmtpBusy(value), []);
  const formKey = `${account?.id ?? state.newId}:${account?.revision ?? 0}:${state.newId}`, dirty = dirtyForm === formKey;
  const automation = useAgentAutoInbox(account, visible), canAct = () => smtpGuard.current?.() !== false && automation.canLeave();
  const canConfigureAuto = () => smtpGuard.current?.() !== false && !state.locked && !dirty && !inboxBusy && !oauthBusy;
  const baseLocked = state.locked || smtpBusy || inboxBusy || automation.locked || automation.dirty, locked = baseLocked || oauthBusy;
  const confirm = useConfirmation([account, locked, dirty, visible]);
  return <Panel className="card" aria-label="Agent 邮箱" hidden={!visible}><h2>Agent 邮箱</h2>
    <div className="row"><Button disabled={locked || dirty} onClick={() => { if (canAct()) state.choose(null); }} variant="quiet" wrap>添加 Agent 邮箱</Button>
      <Button disabled={locked || dirty} onClick={() => { if (canAct()) void state.refresh(); }} variant="quiet" wrap>刷新 Agent 邮箱</Button></div>
    {state.error && <Notice role="alert" tone="danger">{state.error}</Notice>}{state.notice && <Notice role="status" tone="info">{state.notice}</Notice>}
    <ul>{state.page?.items.map(row => <li key={row.id}><div>
      <Button disabled={locked || dirty} onClick={() => { if (canAct()) state.choose(row); }} variant="quiet" wrap>{row.displayName || row.emailAddress}</Button>
      <small>{row.emailAddress} · {row.enabled ? "允许连接" : "已停用"}</small>
    </div></li>)}</ul>
    {state.page?.items.length === 0 && <p>暂无 Agent 邮箱</p>}
    {state.page?.nextCursor && <Button disabled={locked || dirty} onClick={() => { if (canAct()) void state.more(); }} wrap>加载更多 Agent 邮箱</Button>}
    {dirty && <Notice role="status" tone="info">配置有未保存修改</Notice>}
    {state.endpoints !== null && <MailAccountForm key={formKey} account={account} label="Agent 邮箱" immutableAddress endpoints={state.endpoints} disabled={locked}
      onDirty={() => setDirtyForm(formKey)} onSave={body => { if (canAct()) void state.write({ id: account?.id ?? state.newId, method: "PUT", body }); }} />}
    {state.endpoints?.length === 0 && <Notice role="status" tone="info">尚未配置可用的 IMAP 服务器</Notice>}
    {state.attempt && <Button disabled={state.pending} onClick={() => void state.write()} wrap>核对原 Agent 账号操作</Button>}
    {account && <section aria-label="Agent 邮箱连接状态"><h3>连接状态</h3>
      <p>凭据：{account.credentialConfigured ? "已加密保存" : "未保存"} · 版本 {account.revision}</p>
      <p>最近检查：{dateText(account.testedAt)}</p>
      {account.testError && <p>{errorMessage(new ApiError(502, account.testError))}</p>}
      {account.inboxUidValidity && <p>只读 INBOX：{account.inboxMessages} 封 · UIDVALIDITY {account.inboxUidValidity}</p>}
      <Button disabled={locked || dirty || !account.enabled || !account.credentialConfigured} onClick={() => { if (canAct()) void state.testConnection(); }} wrap>测试 Agent IMAP 连接</Button>
      <Button variant="danger" disabled={locked || dirty} onClick={async () => {
        if (canAct() && (await confirm("移除 Agent 平台邮箱账号和凭据？不会删除服务器上的邮件。"))) void state.write({ id: account.id, method: "DELETE", body: { expectedRevision: account.revision } });
      }} wrap>移除 Agent 邮箱</Button>
    </section>}
    {account?.authentication === "google-oauth2" && <GoogleAuthorization key={`oauth:${account.id}`} scope="agent" account={account} disabled={baseLocked || dirty}
      canAct={() => !baseLocked && !dirty && canAct()} onBusy={setOauthBusy} onAccount={state.replaceAccount} />}
    {account && <AgentSmtp key={`${account.id}:${account.revision}`} account={account} disabled={state.locked || dirty || inboxBusy || automation.locked || automation.dirty || oauthBusy}
      canAct={automation.canLeave} onBusy={reportSmtp} guard={smtpGuard} />}
    {account && <AgentAutoInbox state={automation} disabled={state.locked || dirty || smtpBusy || inboxBusy || oauthBusy} canAct={canConfigureAuto} />}
    {account && <AgentInbox key={`inbox:${account.id}:${account.revision}`} account={account} visible={visible} disabled={state.locked || dirty || smtpBusy || automation.locked || automation.dirty || oauthBusy}
      canAct={automation.canLeave} onBusy={reportInbox} />}
  </Panel>;
}
