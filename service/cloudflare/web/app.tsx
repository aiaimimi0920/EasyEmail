import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiKeys } from "./ApiKeys";
import { Authentication } from "./Authentication";
import { api, ApiError, errorMessage, type ApiKey, type Compose, type ComposeRequest, type Page, type User } from "./api";
import { Mailboxes } from "./Mailboxes";
import { AggregateInbox } from "./AggregateInbox";
import { Composer } from "./Composer";
import { Administration } from "./Administration";
import { RetentionPanel } from "./RetentionPanel";
import { PasswordChange } from "./PasswordChange";
import { AccountAdministration } from "./AccountAdministration";
import { Contacts } from "./Contacts";
import { Subscriptions } from "./Subscriptions";
import { NormalAccounts } from "./NormalAccounts";
import { NormalOrganizationProvider } from "./NormalOrganization";
import { OrganizationGateProvider } from "./OrganizationGate";
import { MixedOrganizationProvider } from "./MixedOrganization";
import { NormalReplyProvider } from "./NormalReply";
import { completeGoogleReturn, discardGoogleReturn, hasGoogleReturn } from "./google-oauth-return";
import { AgentServices } from "./AgentServices";
import { AgentAccounts } from "./AgentAccounts";
import { AgentTasks } from "./AgentTasks";
import { AgentThreads } from "./AgentThreads";
import { NormalRemoteFlagsProvider } from "./NormalRemoteFlags";
import { NormalRemoteMutationsProvider } from "./NormalRemoteMutations";
import "./app.css";

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [keys, setKeys] = useState<Page<ApiKey> | null>(null);
  const [view, setView] = useState("mailboxes");
  const [composeRequest, setComposeRequest] = useState<ComposeRequest | null>(null);
  const [authorizedId, setAuthorizedId] = useState<string>();
  const [authorizedAgentId, setAuthorizedAgentId] = useState<string>();
  const compose: Compose = (mailboxId, message) => {
    setComposeRequest({ nonce: crypto.randomUUID(), mailboxId, message }); setView("outgoing");
  };

  useEffect(() => {
    let active = true;
    api<{ user: User }>("/me").then(async response => {
      if (!active) return; setUser(response.user);
      if (hasGoogleReturn()) {
        try { const result = await completeGoogleReturn(response.user.id); if (active) {
          if (result.account.scope === "agent") { setAuthorizedAgentId(result.account.id); setView("agent-accounts"); }
          else { setAuthorizedId(result.account.id); setView("normal"); }
          setNotice("Google 邮箱授权已保存；SMTP 发信仍须单独启用");
        } } catch (failure) { if (active) setError(errorMessage(failure)); }
      }
    }).catch((failure) => { if (!active) return;
      if (hasGoogleReturn()) { discardGoogleReturn(); setError("授权会话已失效，请登录后重新发起 Google 授权"); }
      else if (!(failure instanceof ApiError && failure.status === 401)) setError(errorMessage(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!user) return;
    let active = true;
    setError("");
    api<Page<ApiKey>>("/api-keys")
      .then((nextKeys) => { if (active) setKeys(nextKeys); })
      .catch((failure) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [user]);

  function signedOut(message = "") {
    setUser(null);
    setKeys(null);
    setError("");
    setNotice(message);
    setView("mailboxes");
    setComposeRequest(null);
    setAuthorizedId(undefined);
    setAuthorizedAgentId(undefined);
  }

  async function logout() {
    try {
      await api("/auth/logout", "POST");
      signedOut();
    } catch (failure) { setError(errorMessage(failure)); }
  }

  if (loading) return <main><p role="status">加载中…</p></main>;
  return <main>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!user ? <Authentication onAuthenticated={(next) => { setNotice(""); setUser(next); }} /> : <OrganizationGateProvider key={user.id}>
      <MixedOrganizationProvider><NormalOrganizationProvider><NormalRemoteFlagsProvider><NormalRemoteMutationsProvider><NormalReplyProvider onOpen={() => setView("normal")}>
      <header><h1>EasyEmail</h1><div>{user.username} <button className="secondary" onClick={logout}>退出登录</button></div></header>
      <nav className="row" aria-label="邮件工作台">
        <button className="secondary" aria-pressed={view === "mailboxes"} onClick={() => setView("mailboxes")}>邮箱管理</button>
        <button className="secondary" aria-pressed={view === "inbox"} onClick={() => setView("inbox")}>聚合收件箱</button>
        <button className="secondary" aria-pressed={view === "outgoing"} onClick={() => setView("outgoing")}>写信与发送记录</button>
        <button className="secondary" aria-pressed={view === "contacts"} onClick={() => setView("contacts")}>联系人</button>
        <button className="secondary" aria-pressed={view === "subscriptions"} onClick={() => setView("subscriptions")}>订阅邮件</button>
        <button className="secondary" aria-pressed={view === "normal"} onClick={() => setView("normal")}>普通邮箱</button>
        <button className="secondary" aria-pressed={view === "agents"} onClick={() => setView("agents")}>Agent 服务</button>
        <button className="secondary" aria-pressed={view === "agent-accounts"} onClick={() => setView("agent-accounts")}>Agent 邮箱</button>
        <button className="secondary" aria-pressed={view === "agent-tasks"} onClick={() => setView("agent-tasks")}>Agent 任务</button>
        <button className="secondary" aria-pressed={view === "agent-threads"} onClick={() => setView("agent-threads")}>Agent 线程</button>
        {user.isAdmin && <button className="secondary" aria-pressed={view === "admin"} onClick={() => setView("admin")}>平台管理</button>}
        <button className="secondary" aria-pressed={view === "security"} onClick={() => setView("security")}>账号安全</button>
      </nav>
      <div hidden={view !== "mailboxes"}><Mailboxes key={user.id} visible={view === "mailboxes"} onCompose={compose} /></div>
      <div hidden={view !== "inbox"}><AggregateInbox key={user.id} onCompose={compose} visible={view === "inbox"} /></div>
      <div hidden={view !== "outgoing"}><Composer key={user.id} visible={view === "outgoing"} request={composeRequest} /></div>
      <div hidden={view !== "contacts"}><Contacts key={user.id} visible={view === "contacts"} /></div>
      <div hidden={view !== "subscriptions"}><Subscriptions key={user.id} visible={view === "subscriptions"} onCompose={compose} /></div>
      <NormalAccounts key={user.id} visible={view === "normal"} authorizedId={authorizedId} />
      <div hidden={view !== "agents"}><AgentServices key={user.id} visible={view === "agents"} /></div>
      <AgentAccounts key={user.id} visible={view === "agent-accounts"} authorizedId={authorizedAgentId} />
      <AgentTasks key={user.id} visible={view === "agent-tasks"} />
      <AgentThreads key={user.id} visible={view === "agent-threads"} />
      {view === "admin" && user.isAdmin && <Administration key={user.id} />}
      {view === "admin" && user.isAdmin && <AccountAdministration key={user.id} userId={user.id} onSignedOut={signedOut} />}
      {user.isAdmin && <div hidden={view !== "admin"}><RetentionPanel key={user.id} visible={view === "admin"} /></div>}
      {view === "security" && <PasswordChange key={user.id} onSignedOut={signedOut} />}
      {keys && <ApiKeys initial={keys} />}
      </NormalReplyProvider></NormalRemoteMutationsProvider></NormalRemoteFlagsProvider></NormalOrganizationProvider></MixedOrganizationProvider>
    </OrganizationGateProvider>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
