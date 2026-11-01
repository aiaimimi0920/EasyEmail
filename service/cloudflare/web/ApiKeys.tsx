import { useState, type FormEvent } from "react";
import { api, errorMessage, type ApiKey, type Page } from "./api";

export function ApiKeys({ initial }: { initial: Page<ApiKey> }) {
  const [page, setPage] = useState(initial);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [permission, setPermission] = useState("metadata");

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = new FormData(form).get("name");
    setPending(true);
    setSecret("");
    setError("");
    try {
      const scopes = permission === 'recover' ? ['mailboxes:read', 'mailboxes:write']
        : permission === "drafts" ? ["mailboxes:read", "drafts:read", "drafts:write"]
        : permission === "normal-read" ? ["mail-accounts:read"]
        : permission === "normal" ? ["mail-accounts:read", "mail-accounts:write", "mail-accounts:sync"]
        : permission === "normal-send" ? ["mail-accounts:read", "mail-accounts:send", "messages:read"]
        : permission === "normal-drafts" ? ["mail-accounts:read", "drafts:read", "drafts:write"]
        : permission === "normal-draft-send" ? ["mail-accounts:read", "mail-accounts:send", "messages:read", "drafts:read", "drafts:write"]
        : permission === "normal-outbox" ? ["mail-accounts:read", "mail-accounts:send", "messages:read", "drafts:read", "drafts:write", "attachments:read", "attachments:write"]
        : permission === "normal-schedule" ? ["mail-accounts:read", "mail-accounts:send", "mail-accounts:schedule", "messages:read", "drafts:read", "drafts:write", "attachments:read", "attachments:write"]
        : permission === "unified-read" ? ["mailboxes:read", "messages:read", "mail-accounts:read"]
        : permission === "unified-download" ? ["mailboxes:read", "messages:read", "mail-accounts:read", "attachments:read"]
        : permission === "normal-inbox" ? ["mail-accounts:read", "mail-accounts:sync", "messages:read", "attachments:read"]
        : permission === "normal-organize" ? ["mail-accounts:read", "messages:read", "messages:write"]
        : permission === "normal-remote-flags" ? ["mail-accounts:read", "messages:read", "mail-accounts:remote-flags"]
        : permission === "normal-remote-move" ? ["mail-accounts:read", "messages:read", "mail-accounts:remote-move"]
        : permission === "normal-remote-delete" ? ["mail-accounts:read", "messages:read", "mail-accounts:remote-delete"]
        : permission === "normal-trash" ? ["mail-accounts:read", "messages:read", "messages:write", "messages:delete"]
        : permission === "normal-taxonomy" ? ["mail-accounts:read", "messages:read", "messages:write", "labels:read", "folders:read"]
        : permission === "subscriptions-read" ? ["messages:read", "subscriptions:read"]
        : permission === "subscriptions" ? ["messages:read", "subscriptions:read", "subscriptions:write"]
        : permission === "unified-subscriptions-read" ? ["messages:read", "subscriptions:read", "mail-accounts:read"]
        : permission === "unified-subscriptions" ? ["messages:read", "subscriptions:read", "subscriptions:write", "mail-accounts:read"]
        : permission === "contacts-read" ? ["contacts:read"]
        : permission === "contacts" ? ["contacts:read", "contacts:write"]
        : permission === "agent-services-read" ? ["agent-services:read"]
        : permission === "agent-services" ? ["agent-services:read", "agent-services:write"]
        : permission === "agent-accounts-read" ? ["agent-accounts:read"]
        : permission === "agent-accounts" ? ["agent-accounts:read", "agent-accounts:write", "agent-accounts:sync"]
        : permission === "agent-tasks-read" ? ["agent-tasks:read"]
        : permission === "agent-threads" ? ["agent-tasks:read", "agent-threads:write"]
        : permission === "agent-followups" ? ["agent-tasks:read", "agent-threads:send", "agent-inbox:read"]
        : permission === "agent-inbound" ? ["agent-inbox:read", "agent-inbox:review", "agent-tasks:read", "agent-services:read", "agent-threads:write"]
        : permission === "agent-inbox-read" ? ["agent-inbox:read", "attachments:read"]
        : permission === "agent-inbox" ? ["agent-inbox:read", "agent-accounts:sync", "attachments:read"]
        : permission === "agent-auto-inbox" ? ["agent-accounts:read", "agent-inbox:automate"]
        : permission === "agent-inbox-review" ? ["agent-inbox:read", "agent-inbox:review", "agent-tasks:read"]
        : permission === "agent-tasks" ? ["agent-tasks:read", "agent-tasks:send", "agent-services:read", "agent-accounts:read"]
        : permission === "send" ? ["mailboxes:read", "messages:read", "messages:send"]
        : permission === "schedule" ? ["mailboxes:read", "messages:read", "messages:send", "messages:schedule", "drafts:read", "drafts:write", "attachments:read", "attachments:write"]
        : permission === "outbox" ? ["mailboxes:read", "messages:read", "messages:send", "drafts:read", "drafts:write", "attachments:read", "attachments:write"]
        : permission === "attachments" ? ["mailboxes:read", "messages:read", "attachments:read"]
        : permission === "cleanup" ? ["mailboxes:read", "messages:read", "messages:delete"]
        : permission === "remote-delete" ? ["mailboxes:read", "messages:read", "messages:remote-delete"]
        : permission === "mailbox-remote-delete" ? ["mailboxes:read", "mailboxes:remote-delete"]
        : permission === "release" ? ["mailboxes:read", "mailboxes:delete"]
        : permission === "folders" ? ["mailboxes:read", "messages:read", "messages:write", "folders:read", "folders:write"]
        : permission === "labels" ? ["mailboxes:read", "messages:read", "messages:write", "labels:read", "labels:write"]
        : permission === "organize" ? ["mailboxes:read", "mailboxes:write", "messages:read", "messages:write"]
        : permission === "manage" ? ["mailboxes:read", "mailboxes:write", "messages:read"]
        : permission === "content" ? ["mailboxes:read", "messages:read"] : ["mailboxes:read"];
      const key = await api<{ token: string }>("/api-keys", "POST", { name, scopes });
      setSecret(key.token);
      form.reset();
      setPage(await api<Page<ApiKey>>("/api-keys"));
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  async function revoke(id: string) {
    setPending(true);
    setError("");
    try {
      await api(`/api-keys/${id}`, "DELETE");
      setPage(await api<Page<ApiKey>>("/api-keys"));
      setSecret("");
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  async function loadMore() {
    setPending(true);
    try {
      const next = await api<Page<ApiKey>>(`/api-keys?cursor=${page.nextCursor}`);
      setPage({ items: [...page.items, ...next.items], nextCursor: next.nextCursor });
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  return <section className="card">
    <h2>API Key</h2>
    <form className="row" onSubmit={create}>
      <label>名称<input name="name" maxLength={80} required disabled={pending} /></label>
      <label>权限<select value={permission} onChange={(event) => setPermission(event.target.value)} disabled={pending}>
        <option value="metadata">仅邮箱元数据</option><option value="content">邮箱与邮件只读</option>
        <option value="manage">创建、恢复、同步与阅读</option>
        <option value="recover">邮箱访问恢复与元数据（不含邮件阅读或发信）</option>
        <option value="normal-read">仅查看普通邮箱配置</option><option value="normal">普通邮箱配置与连接测试（不含发信）</option>
        <option value="normal-send">普通邮箱直接发信与发送记录（不含配置）</option>
        <option value="normal-drafts">普通邮箱云端草稿（不含发信）</option>
        <option value="normal-draft-send">普通邮箱云端草稿与发信（不含配置）</option>
        <option value="normal-outbox">普通邮箱草稿、附件上传与发信（不含配置）</option>
        <option value="normal-schedule">普通邮箱排队、定时、草稿及附件（不含配置）</option>
        <option value="unified-read">临时与普通邮箱聚合只读</option><option value="unified-download">临时与普通邮箱只读及下载</option>
        <option value="normal-inbox">普通邮箱同步、阅读及下载（不含配置与发信）</option>
        <option value="normal-organize">普通邮件平台已读、星标与归档</option><option value="normal-trash">普通邮件平台整理及回收站</option>
        <option value="normal-remote-flags">普通邮件服务器已读与星标（含外部写入）</option>
        <option value="normal-remote-move">普通邮件服务器移动（不含删除、同步或配置）</option>
        <option value="normal-remote-delete">普通邮件服务器永久删除（不含移动、同步或配置）</option>
        <option value="normal-taxonomy">普通邮件标签与文件夹（不含管理或删除）</option>
        <option value="organize">创建、同步、阅读与整理</option>
        <option value="labels">阅读、批量整理与管理标签（不含删除）</option>
        <option value="folders">阅读、移动邮件与管理文件夹（不含删除邮件）</option>
        <option value="send">阅读与发送邮件（含外部写入）</option>
        <option value="schedule">后台排队、定时发送与取消（含外部写入）</option>
        <option value="drafts">查看邮箱与管理云端草稿（不含发送）</option>
        <option value="contacts-read">仅查看联系人</option><option value="contacts">查看与管理联系人（不含发信）</option>
        <option value="agent-services-read">仅查看 Agent 服务</option><option value="agent-services">管理 Agent 服务目录（不含发信）</option>
        <option value="agent-accounts-read">仅查看 Agent 邮箱与 SMTP 配置</option><option value="agent-accounts">Agent 邮箱、SMTP 配置与 IMAP 测试（不含发信）</option>
        <option value="agent-tasks-read">仅查看 Agent 任务</option><option value="agent-tasks">Agent 任务排队发信与取消</option>
        <option value="agent-threads">Agent 任务线程状态管理（不含发信、同步或来信处理）</option>
        <option value="agent-followups">Agent 同线程跟进与取消（不含配置、同步或线程状态管理）</option>
        <option value="agent-inbound">Agent 入站线程创建与人工管理（不含发信或同步）</option>
        <option value="agent-inbox-read">仅查看 Agent 收件与附件</option><option value="agent-inbox">Agent 显式收件同步与读取（不含发信）</option>
        <option value="agent-auto-inbox">Agent 持续自动收件配置（不含发信或读取邮件）</option>
        <option value="agent-inbox-review">Agent 来信人工处理与任务归类（不含发信或同步）</option>
        <option value="subscriptions-read">查看订阅邮件</option><option value="subscriptions">查看与隐藏订阅（不含远端退订）</option>
        <option value="unified-subscriptions-read">临时与普通订阅只读</option><option value="unified-subscriptions">临时与普通订阅隐藏偏好（不含远端退订）</option>
        <option value="attachments">阅读邮件与下载附件</option>
        <option value="outbox">云端草稿、附件上传与发送（含外部写入）</option>
        <option value="cleanup">阅读与清理平台邮件缓存</option>
        <option value="remote-delete">阅读与条件删除上游邮件</option>
        <option value="mailbox-remote-delete">查看与条件删除上游邮箱</option>
        <option value="release">查看邮箱与释放平台访问</option>
      </select></label>
      <button disabled={pending}>{permission === "metadata" ? "创建只读 Key" : "创建 Key"}</button>
    </form>
    {secret && <div className="secret"><p>仅本次显示，请保存。</p><code data-testid="new-key">{secret}</code>
      <button className="secondary" onClick={() => setSecret("")}>隐藏</button></div>}
    {error && <p role="alert">{error}</p>}
    <ul>{page.items.map((key) => <li key={key.id}>
      <div><strong>{key.name}</strong> <code>{key.prefix}…</code>
        <small>{key.revokedAt ? "已撤销" : key.expiresAt * 1000 <= Date.now() ? "已过期" : key.scopes.join(" · ")}</small></div>
      {!key.revokedAt && <button className="secondary" disabled={pending} onClick={() => revoke(key.id)}>撤销</button>}
    </li>)}</ul>
    {page.items.length === 0 && <p>暂无 API Key</p>}
    {page.nextCursor && <button disabled={pending} onClick={loadMore}>加载更多 Key</button>}
  </section>;
}
