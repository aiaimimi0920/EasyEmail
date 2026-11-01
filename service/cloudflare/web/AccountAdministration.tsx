import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, dateText, errorMessage, type Page } from "./api";
import { accountActions, type Account, type AccountAudit } from "./account-api";

interface Selection { account: Account; action: "disable" | "enable" | "revoke-credentials" }

export function AccountAdministration({ userId, onSignedOut }: { userId: string; onSignedOut: (message: string) => void }) {
  const [users, setUsers] = useState<Page<Account>>({ items: [], nextCursor: null });
  const [audit, setAudit] = useState<Page<AccountAudit>>({ items: [], nextCursor: null });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const busy = useRef(false);

  async function load(params = applied) {
    const [next, events] = await Promise.all([
      api<Page<Account>>(`/admin/users?${params}`), api<Page<AccountAudit>>("/admin/users/audit"),
    ]);
    setUsers(next); setAudit(events); setApplied(params);
  }
  useEffect(() => {
    load().catch((failure) => setError(errorMessage(failure))).finally(() => setPending(false));
  }, []);

  async function perform(task: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(""); setStatus("");
    try { await task(); }
    catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setSelection(null); setConfirmation("");
        try { await load(); } catch { /* Preserve the original conflict error. */ }
      }
      setError(errorMessage(failure));
    } finally { busy.current = false; setPending(false); }
  }

  function select(account: Account, action: Selection["action"]) {
    setSelection({ account, action }); setConfirmation(""); setError(""); setStatus("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selection || confirmation !== selection.account.username) return;
    const { account, action } = selection;
    await perform(async () => {
      const result = await api<{ reauthenticate?: boolean }>(`/admin/users/${account.id}/${action === "revoke-credentials" ? action : "status"}`, "POST", {
        expectedRevision: account.revision, confirmUsername: confirmation,
        ...(action === "revoke-credentials" ? {} : { status: action === "disable" ? "disabled" : "active" }),
      });
      setSelection(null); setConfirmation("");
      if (result.reauthenticate) { onSignedOut("全部会话和 API Key 已撤销，请重新登录"); return; }
      await load(); setStatus(`${account.username}：${accountActions[action]}完成`);
    });
  }

  return <section className="card" aria-label="用户管理">
    <h2>用户管理</h2>
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    <form className="row" onSubmit={(event) => {
      event.preventDefault(); setSelection(null);
      void perform(() => load(new URLSearchParams({ q: query, status: filter }).toString()));
    }}>
      <label>搜索用户名<input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={64} disabled={pending} /></label>
      <label>账号状态<select value={filter} onChange={(event) => setFilter(event.target.value)} disabled={pending}>
        <option value="">全部</option><option value="active">已启用</option><option value="disabled">已停用</option>
      </select></label>
      <button disabled={pending}>搜索用户</button>
      <button type="button" className="secondary" disabled={pending} onClick={() => { setSelection(null); void perform(() => load()); }}>刷新用户</button>
    </form>
    {selection && <form onSubmit={submit} aria-label="确认账号操作">
      <h3>{accountActions[selection.action]}：{selection.account.username}</h3>
      <p>{selection.action === "disable" ? "将禁止登录并撤销全部会话和 API Key。邮箱与历史保留；已派发的外部请求可能完成。"
        : selection.action === "enable" ? "恢复登录资格，但不会恢复旧会话或旧 API Key。"
          : "将退出所有设备并撤销全部 API Key；若操作自己的账号，当前网页也会退出。"}</p>
      <label>输入完整用户名确认<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" disabled={pending} /></label>
      <div className="row"><button disabled={pending || confirmation !== selection.account.username}>确认账号操作</button>
        <button type="button" className="secondary" disabled={pending} onClick={() => { setSelection(null); setConfirmation(""); }}>取消账号操作</button></div>
    </form>}
    <ul aria-label="用户列表">{users.items.map((account) => <li key={account.id}>
      <div><strong>{account.username}</strong><small>{account.status === "active" ? "已启用" : "已停用"} · {account.isAdmin ? "管理员" : "用户"} · 版本 {account.revision}</small>
        <small>邮箱 {account.mailboxes} · 有效会话 {account.activeSessions} · 有效 Key {account.activeKeys}</small></div>
      <div className="row"><button className="secondary" disabled={pending || account.id === userId && account.status === "active"}
        onClick={() => select(account, account.status === "active" ? "disable" : "enable")} aria-label={`${account.status === "active" ? "停用" : "启用"} ${account.username}`}>{account.status === "active" ? "停用" : "启用"}</button>
        <button className="secondary" disabled={pending} onClick={() => select(account, "revoke-credentials")} aria-label={`撤销凭据 ${account.username}`}>撤销凭据</button></div>
    </li>)}</ul>
    {users.nextCursor && <button className="secondary" disabled={pending} onClick={() => perform(async () => {
      const next = await api<Page<Account>>(`/admin/users?${applied}&cursor=${encodeURIComponent(users.nextCursor!)}`);
      setUsers({ items: [...users.items, ...next.items], nextCursor: next.nextCursor });
    })}>更多用户</button>}
    <h3>账号审计</h3><ul aria-label="账号审计">{audit.items.map((row) => <li key={row.id}><div>
      {accountActions[row.action] ?? row.action} · 版本 {row.revision}<small>{dateText(row.createdAt)} · 用户 {row.userId} · 操作者 {row.actorId}</small>
    </div></li>)}</ul>
    {audit.nextCursor && <button className="secondary" disabled={pending} onClick={() => perform(async () => {
      const next = await api<Page<AccountAudit>>(`/admin/users/audit?cursor=${encodeURIComponent(audit.nextCursor!)}`);
      setAudit({ items: [...audit.items, ...next.items], nextCursor: next.nextCursor });
    })}>更多账号审计</button>}
  </section>;
}
