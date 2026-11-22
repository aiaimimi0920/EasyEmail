import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage, type Page } from "./api";
import type { AgentAccount } from "./agent-accounts-api";
import type { AgentService } from "./agent-services-api";
import { readAgentSmtpConfig, type AgentSmtpConfig } from "./agent-smtp-api";
import { readAgentSenderAccount, readAgentSenderPage } from "./agent-sender-options";

function sourcePage<T extends { id: string }>(value: unknown, kind: "accounts" | "services"): Page<T> {
  if (kind === "accounts") return readAgentSenderPage(value) as unknown as Page<T>;
  const row = value as Page<Record<string, unknown>>;
  const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/;
  if (!row || !Array.isArray(row.items) || row.items.length > 100 || row.nextCursor !== null && (typeof row.nextCursor !== "string" || !cursorPattern.test(row.nextCursor))
    || row.items.some(item => !item || typeof item.id !== "string" || !/^[0-9a-f-]{36}$/.test(item.id) || typeof item.displayName !== "string" || typeof item.emailAddress !== "string"
      || !Number.isSafeInteger(item.version) || !["active", "disabled", "archived"].includes(item.status as string) || !["unknown", "trusted", "restricted", "blocked"].includes(item.trustLevel as string)
      || item.defaultSenderAccountId !== null && (typeof item.defaultSenderAccountId !== "string" || !/^[0-9a-f-]{36}$/.test(item.defaultSenderAccountId))))
    throw new ApiError(502, "agent_task_response_invalid");
  return row as unknown as Page<T>;
}
export function useAgentTaskSources(visible: boolean) {
  const [accounts, setAccounts] = useState<Page<AgentAccount> | null>(null), [services, setServices] = useState<Page<AgentService> | null>(null);
  const [accountId, setAccountId] = useState(""), [serviceId, setServiceId] = useState("");
  const [smtp, setSmtp] = useState<AgentSmtpConfig | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const generation = useRef(0), reading = useRef(false), active = useRef(false);
  const account = accounts?.items.find(row => row.id === accountId), service = services?.items.find(row => row.id === serviceId);
  async function refresh(kind?: "accounts" | "services") {
    if (reading.current) return; reading.current = true; const current = ++generation.current; setPending(true); setError("");
    try {
      const [a, s] = await Promise.all([
        kind === "services" ? accounts : api(`/agent-accounts?limit=100${kind === "accounts" && accounts?.nextCursor ? `&cursor=${encodeURIComponent(accounts.nextCursor)}` : ""}`).then(value => sourcePage<AgentAccount>(value, "accounts")),
        kind === "accounts" ? services : api(`/agent-services?limit=100${kind === "services" && services?.nextCursor ? `&cursor=${encodeURIComponent(services.nextCursor)}` : ""}`).then(value => sourcePage<AgentService>(value, "services")),
      ]);
      if (active.current && current === generation.current) {
        if (a) setAccounts(kind === "accounts" ? { ...a, items: [...(accounts?.items ?? []), ...a.items] } : a);
        if (s) setServices(kind === "services" ? { ...s, items: [...(services?.items ?? []), ...s.items] } : s);
        setRevision(value => value + 1);
      }
    } catch (failure) { if (active.current && current === generation.current) setError(errorMessage(failure)); }
    finally { reading.current = false; if (active.current && current === generation.current) setPending(false); }
  }
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; }; }, []);
  useEffect(() => { if (visible) void refresh(); }, [visible]);
  async function useDefaultSender() {
    if (reading.current || !service?.defaultSenderAccountId) return;
    const id = service.defaultSenderAccountId, current = ++generation.current; reading.current = true; setPending(true); setError(""); setAccountId(""); setSmtp(null);
    try {
      const result = await api<{ account: unknown }>(`/agent-accounts/${id}`), selected = readAgentSenderAccount(result?.account, id);
      if (active.current && current === generation.current) {
        setAccounts(old => ({ items: [...new Map([...(old?.items ?? []), selected].map(item => [item.id, item])).values()], nextCursor: old?.nextCursor ?? null }));
        setSmtp(null); setAccountId(selected.id); setRevision(value => value + 1);
      }
    } catch (failure) { if (active.current && current === generation.current) setError(errorMessage(failure)); }
    finally { reading.current = false; if (active.current && current === generation.current) setPending(false); }
  }
  useEffect(() => {
    let current = true; setSmtp(null);
    if (account) void api(`/agent-accounts/${account.id}/smtp`).then(value => {
      const config = readAgentSmtpConfig(value, account); if (current) setSmtp(config);
    }).catch(failure => { if (current) setError(errorMessage(failure)); });
    return () => { current = false; };
  }, [account?.id, account?.revision, revision]);
  return { accounts, services, account, service, accountId, setAccountId, serviceId, setServiceId, smtp, pending, error, refresh, useDefaultSender };
}
