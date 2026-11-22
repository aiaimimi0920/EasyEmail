import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage, type Page } from "./api";
import type { ImapEndpoint } from "./normal-accounts";
import { readAgentAccountReceipt, readAgentAccountTest, type AgentAccount, type AgentAccountAttempt } from "./agent-accounts-api";
import { readAgentSenderAccount, readAgentSenderPage } from "./agent-sender-options";

export function useAgentAccounts(visible: boolean, authorizedId?: string) {
  const [page, setPage] = useState<Page<AgentAccount> | null>(null), [endpoints, setEndpoints] = useState<ImapEndpoint[] | null>(null);
  const [selected, setSelected] = useState<AgentAccount | null>(null), [newId, setNewId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState<AgentAccountAttempt | null>(null);
  const held = useRef<AgentAccountAttempt | null>(null), busy = useRef(false), generation = useRef(0), active = useRef(false);
  const consumedAuthorization = useRef<string | undefined>(undefined);
  useEffect(() => { active.current = true; return () => { active.current = false; held.current = null; generation.current++; }; }, []);
  useEffect(() => {
    if (!visible || busy.current || held.current) return;
    const current = ++generation.current;
    Promise.all([api<unknown>("/agent-accounts").then(readAgentSenderPage), api<{ items: ImapEndpoint[] }>("/agent-accounts/endpoints"),
      authorizedId ? api<{ account: unknown }>(`/agent-accounts/${authorizedId}`).then(value => readAgentSenderAccount(value.account, authorizedId)) : Promise.resolve(null)])
      .then(([accounts, servers, authorized]) => { if (active.current && current === generation.current) {
        setPage(accounts); setEndpoints(servers.items);
        if (authorized && consumedAuthorization.current !== authorizedId && !busy.current && !held.current) {
          consumedAuthorization.current = authorizedId; setSelected(authorized);
        }
      } })
      .catch(failure => { if (active.current && current === generation.current) setError(errorMessage(failure)); });
    return () => { generation.current++; };
  }, [visible, authorizedId]);
  async function reload(id: string | null) {
    const current = ++generation.current;
    const [accounts, account, servers] = await Promise.all([api<unknown>("/agent-accounts").then(readAgentSenderPage),
      id ? api<{ account: unknown }>(`/agent-accounts/${id}`).then(value => readAgentSenderAccount(value.account, id)) : Promise.resolve(null), api<{ items: ImapEndpoint[] }>("/agent-accounts/endpoints")]);
    if (active.current && current === generation.current) { setPage(accounts); setSelected(account); setEndpoints(servers.items); }
  }
  async function refresh() {
    if (busy.current || held.current) return;
    busy.current = true; setPending(true); setError("");
    try { await reload(selected?.id ?? null); }
    catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  async function write(input?: Omit<AgentAccountAttempt, "key" | "uncertain">) {
    if (busy.current) return;
    const recovering = held.current !== null;
    const current = held.current ?? (input ? { ...input, body: { ...input.body }, key: crypto.randomUUID(), uncertain: false } : null);
    if (!current) return;
    held.current = current; busy.current = true; generation.current++; setAttempt(current); setPending(true); setError(""); setNotice("");
    try {
      let receipt = null;
      if (recovering) {
        try { receipt = readAgentAccountReceipt(await api<unknown>(`/agent-account-operations/${current.key}`), current); }
        catch (failure) { if (!(failure instanceof ApiError && failure.status === 404)) throw failure; }
      }
      if (!receipt) readAgentAccountReceipt(await api<unknown>(`/agent-accounts/${current.id}`, current.method, current.body, { "idempotency-key": current.key }), current);
      if (!active.current) return;
      held.current = null; setAttempt(null); setNewId(crypto.randomUUID()); setSelected(null);
      setNotice(current.method === "DELETE" ? "已移除 Agent 平台账号与凭据，未操作服务器邮件" : "Agent 账号已保存");
      await reload(current.method === "DELETE" ? null : current.id);
    } catch (failure) {
      if (active.current) {
        setError(errorMessage(failure));
        if (held.current) {
          if (!current.uncertain && failure instanceof ApiError && failure.status < 500 && failure.status !== 429) { held.current = null; setAttempt(null); }
          else { current.uncertain = true; setAttempt({ ...current }); }
        }
      }
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  async function testConnection() {
    if (busy.current || held.current || !selected) return;
    busy.current = true; generation.current++; setPending(true); setError(""); setNotice("");
    try {
      const result = readAgentAccountTest(await api<unknown>(`/agent-accounts/${selected.id}/test`, "POST", { expectedRevision: selected.revision }), selected);
      if (active.current) { setSelected(result); setNotice("Agent IMAP 认证与只读 INBOX 检查通过；本次检查未同步邮件"); }
    } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  async function more() {
    if (busy.current || held.current || !page?.nextCursor) return;
    const current = ++generation.current; busy.current = true; setPending(true); setError("");
    try {
      const next = readAgentSenderPage(await api<unknown>(`/agent-accounts?cursor=${page.nextCursor}`));
      if (active.current && current === generation.current) setPage({ ...next, items: [...page.items, ...next.items] });
    } catch (failure) { if (active.current && current === generation.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  function choose(account: AgentAccount | null) {
    if (busy.current || held.current) return;
    generation.current++; setSelected(account); setNewId(crypto.randomUUID()); setError(""); setNotice("");
  }
  function replaceAccount(account: AgentAccount) {
    if (busy.current || held.current) return;
    account = readAgentSenderAccount(account, selected?.id);
    generation.current++; setSelected(account); setPage(previous => previous ? { ...previous, items: previous.items.map(row => row.id === account.id ? account : row) } : null);
  }
  return { page, endpoints, selected, newId, error, notice, pending, attempt, locked: pending || attempt !== null, refresh, write, more, testConnection, choose, replaceAccount };
}
