import { useConfirmation } from "./Confirmation";
import { Button, Notice, Panel } from '@neuro/ui';
import { useLayoutEffect, useRef, useState } from "react";
import { dateText, errorMessage, ApiError } from "./api";
import { NormalAccountForm } from "./NormalAccountForm";
import { useNormalAccounts } from "./useNormalAccounts";
import { NormalInbox } from "./NormalInbox";
import { useNormalOrganization } from "./NormalOrganization";
import { NormalSmtp } from "./NormalSmtp";
import { useNormalReply, type NormalReplyIntent } from "./NormalReply";
import { GoogleAuthorization } from "./GoogleAuthorization";
import { NormalServerFolders } from "./NormalServerFolders";

export function NormalAccounts({ visible, authorizedId }: { visible: boolean; authorizedId?: string }) {
  const action = useNormalOrganization();
  const state = useNormalAccounts(visible, authorizedId), [mailLocked, setMailLocked] = useState(false), [smtpLocked, setSmtpLocked] = useState(false);
  const [oauthLocked, setOauthLocked] = useState(false), [folderLocked, setFolderLocked] = useState(false);
  const baseLocked = state.pending || state.unconfirmed || mailLocked || smtpLocked || action.locked || folderLocked, locked = baseLocked || oauthLocked;
  const account = state.selected;
  const [dirtyForm, setDirtyForm] = useState("");
  const formKey = `${account?.id ?? state.newId}:${account?.revision ?? 0}:${state.newId}`, dirty = dirtyForm === formKey;
  const reply = useNormalReply(), smtpGuard = useRef<(() => boolean) | null>(null), consumed = useRef("");
  const [composerReply, setComposerReply] = useState<NormalReplyIntent | null>(null);
  useLayoutEffect(() => {
    const check = () => state.canChoose() && !locked && !dirty && (!account || smtpGuard.current?.() === true);
    reply.guard.current = check;
    return () => { if (reply.guard.current === check) reply.guard.current = null; };
  });
  useLayoutEffect(() => {
    const next = reply.request; if (!next || consumed.current === next.nonce) return;
    consumed.current = next.nonce;
    if (!reply.guard.current?.() || !state.choose(next.account)) { reply.reject(); return; }
    setComposerReply(next);
  }, [reply.request]);
  const confirm = useConfirmation([account, locked, dirty, visible]);
  return <Panel className="card" aria-label="普通邮箱" hidden={!visible}><h2>普通邮箱</h2>
    <div className="row"><Button disabled={locked || dirty} onClick={() => state.choose(null)} variant="quiet" wrap>添加普通邮箱</Button>
      <Button disabled={locked || dirty} onClick={() => void state.refresh()} variant="quiet" wrap>刷新普通邮箱</Button></div>
    {state.error && <Notice role="alert" tone="danger">{state.error}</Notice>}{state.notice && <Notice role="status" tone="info">{state.notice}</Notice>}
    <ul>{state.page?.items.map(row => <li key={row.id}><div>
      <Button disabled={locked || dirty} onClick={() => state.choose(row)} variant="quiet" wrap>{row.displayName || row.emailAddress}</Button>
      <small>{row.emailAddress} · {row.enabled ? "允许连接" : "已停用"}</small>
    </div></li>)}</ul>
    {state.page?.items.length === 0 && <p>暂无普通邮箱</p>}
    {state.page?.nextCursor && <Button disabled={locked} onClick={() => void state.more()} wrap>加载更多普通邮箱</Button>}
    {dirty && <Notice role="status" tone="info">配置有未保存修改</Notice>}
    {state.endpoints !== null && <NormalAccountForm key={formKey} account={account}
      endpoints={state.endpoints} disabled={locked} onDirty={() => setDirtyForm(formKey)} onSave={body => void state.write({ path: `/normal-accounts/${account?.id ?? state.newId}`,
        method: "PUT", key: crypto.randomUUID(), body })} />}
    {state.endpoints?.length === 0 && <Notice role="status" tone="info">尚未配置 IMAP 服务器</Notice>}
    {state.unconfirmed && <Button disabled={state.pending} onClick={() => void state.write()} wrap>核对原账号操作</Button>}
    {account && <section aria-label="普通邮箱连接状态"><h3>连接状态</h3>
      <p>凭据：{account.credentialConfigured ? "已加密保存" : "未保存"} · 版本 {account.revision}</p>
      <p>最近检查：{dateText(account.testedAt)}</p>
      {account.testError && <p>{errorMessage(new ApiError(502, account.testError))}</p>}
      {account.inboxUidValidity && <p>只读 INBOX：{account.inboxMessages} 封 · UIDVALIDITY {account.inboxUidValidity}</p>}
      <Button disabled={locked || dirty || !account.enabled || !account.credentialConfigured} onClick={() => void state.testConnection()} wrap>测试 IMAP 连接</Button>
      <Button variant="danger" disabled={locked || dirty} onClick={async () => {
        if ((await confirm("移除平台普通邮箱账号和凭据？不会删除服务器上的邮件。"))) void state.write({ path: `/normal-accounts/${account.id}`,
          method: "DELETE", key: crypto.randomUUID(), body: { expectedRevision: account.revision } });
      }} wrap>移除普通邮箱</Button>
    </section>}
    {account?.authentication === "google-oauth2" && <GoogleAuthorization account={account} disabled={baseLocked || dirty}
      canAct={() => state.canChoose() && !baseLocked && !dirty && smtpGuard.current?.() === true} onBusy={setOauthLocked} onAccount={state.replaceAccount} />}
    {account && <NormalServerFolders key={`server-folders:${account.id}:${account.revision}`} account={account} visible={visible}
      disabled={state.pending || state.unconfirmed || dirty || mailLocked || smtpLocked || action.locked || oauthLocked} onBusy={setFolderLocked} />}
    {account && <NormalSmtp account={account} disabled={state.pending || state.unconfirmed || dirty || mailLocked || action.locked || oauthLocked || folderLocked} onBusy={setSmtpLocked}
      reply={composerReply} replyGuard={smtpGuard} onReplyConsumed={() => setComposerReply(null)} />}
    {account && <NormalInbox key={`${account.id}:${account.revision}`} account={account} visible={visible}
      disabled={state.pending || state.unconfirmed || dirty || smtpLocked || oauthLocked || folderLocked} onBusy={setMailLocked} />}
  </Panel>;
}
