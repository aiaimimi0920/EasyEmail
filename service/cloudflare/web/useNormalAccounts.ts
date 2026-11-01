import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage, type Page } from "./api";
import type { ImapEndpoint, NormalAccount, NormalWrite } from "./normal-accounts";

export function useNormalAccounts(visible: boolean, authorizedId?: string) {
  const [page, setPage] = useState<Page<NormalAccount> | null>(null), [endpoints, setEndpoints] = useState<ImapEndpoint[] | null>(null);
  const [selected, setSelected] = useState<NormalAccount | null>(null), [newId, setNewId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [pending, setPending] = useState(false), [unconfirmed, setUnconfirmed] = useState(false);
  const operation = useRef<NormalWrite | null>(null), busy = useRef(false), generation = useRef(0);
  const consumedAuthorization = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!visible) return;
    const current = ++generation.current;
    Promise.all([api<Page<NormalAccount>>("/normal-accounts"), api<{ items: ImapEndpoint[] }>("/normal-accounts/endpoints"),
      authorizedId ? api<{ account: NormalAccount }>(`/normal-accounts/${authorizedId}`) : Promise.resolve(null)])
      .then(([accounts, servers, authorized]) => { if (current === generation.current) {
        setPage(accounts); setEndpoints(servers.items);
        if (authorized && consumedAuthorization.current !== authorizedId && !busy.current && !operation.current) {
          consumedAuthorization.current = authorizedId; setSelected(authorized.account);
        }
      } })
      .catch(failure => { if (current === generation.current) setError(errorMessage(failure)); });
    return () => { generation.current++; };
  }, [visible, authorizedId]);
  useEffect(() => () => { operation.current = null; }, []);
  async function refresh() {
    if (busy.current || operation.current) return;
    busy.current = true; setPending(true); setError("");
    try {
      setPage(await api<Page<NormalAccount>>("/normal-accounts"));
      if (selected) setSelected((await api<{ account: NormalAccount }>(`/normal-accounts/${selected.id}`)).account);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  async function write(next?: Omit<NormalWrite, "uncertain">) {
    if (busy.current) return;
    if (!operation.current && next) operation.current = { ...next, uncertain: false };
    const current = operation.current; if (!current) return;
    busy.current = true; setPending(true); setError(""); setNotice("");
    try {
      const result = await api<{ account: NormalAccount }>(current.path, current.method, current.body, { "idempotency-key": current.key });
      operation.current = null; setUnconfirmed(false);
      setSelected(result.account.deleted ? null : result.account); setNewId(crypto.randomUUID());
      setNotice(result.account.deleted ? "已移除平台账号与凭据，未操作服务器邮件" : "账号已保存");
      setPage(await api<Page<NormalAccount>>("/normal-accounts"));
    } catch (failure) {
      setError(errorMessage(failure));
      if (operation.current && !current.uncertain && failure instanceof ApiError && failure.status < 500) {
        operation.current = null; setUnconfirmed(false);
      } else if (operation.current) { current.uncertain = true; setUnconfirmed(true); }
    } finally { busy.current = false; setPending(false); }
  }
  async function testConnection() {
    if (busy.current || operation.current || !selected) return;
    busy.current = true; setPending(true); setError(""); setNotice("");
    try {
      const result = await api<{ account: NormalAccount }>(`/normal-accounts/${selected.id}/test`, "POST", { expectedRevision: selected.revision });
      setSelected(result.account); setNotice("IMAP 认证与只读 INBOX 检查通过；本次检查未同步邮件");
    } catch (failure) { setError(errorMessage(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  async function more() {
    if (busy.current || operation.current || !page?.nextCursor) return;
    busy.current = true; setPending(true);
    try { const next = await api<Page<NormalAccount>>(`/normal-accounts?cursor=${page.nextCursor}`); setPage({ ...next, items: [...page.items, ...next.items] }); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  function choose(account: NormalAccount | null) {
    if (busy.current || operation.current) return false;
    setSelected(account); setNewId(crypto.randomUUID()); setError(""); setNotice("");
    return true;
  }
  function replaceAccount(account: NormalAccount) {
    if (busy.current || operation.current) return;
    setSelected(account); setPage(previous => previous ? { ...previous, items: previous.items.map(row => row.id === account.id ? account : row) } : null);
  }
  return { page, endpoints, selected, newId, error, notice, pending, unconfirmed, refresh, write, more, testConnection, choose,
    replaceAccount,
    canChoose: () => !busy.current && !operation.current };
}
