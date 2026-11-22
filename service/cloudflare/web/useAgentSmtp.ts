import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import type { AgentAccount } from "./agent-accounts-api";
import { readAgentSmtpConfig, readAgentSmtpEndpoints, readAgentSmtpReceipt, type AgentSmtpAttempt, type AgentSmtpConfig, type AgentSmtpEndpoint } from "./agent-smtp-api";

export function useAgentSmtp(account: AgentAccount, disabled: boolean) {
  const [config, setConfig] = useState<AgentSmtpConfig | null>(null), [endpoints, setEndpoints] = useState<AgentSmtpEndpoint[]>([]);
  const [endpointId, setEndpointId] = useState(""), [username, setUsername] = useState(account.username), [password, setPassword] = useState("");
  const [enabled, setEnabled] = useState(false), [forget, setForget] = useState(false), [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false), [attempt, setAttempt] = useState<AgentSmtpAttempt | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const active = useRef(false), busy = useRef(false), held = useRef<AgentSmtpAttempt | null>(null), changed = useRef(false), generation = useRef(0);
  async function load() {
    const current = ++generation.current;
    const [value, servers] = await Promise.all([api<unknown>(`/agent-accounts/${account.id}/smtp`), api<unknown>("/agent-accounts/smtp-endpoints")]);
    const fresh = readAgentSmtpConfig(value, account), items = readAgentSmtpEndpoints(servers).filter(row => row.authentication === account.authentication);
    if (!active.current || current !== generation.current) return;
    setConfig(fresh); setEndpoints(items); setEndpointId(fresh.endpointId || items[0]?.id || ""); setUsername(fresh.username || account.username);
    setEnabled(fresh.enabled); setPassword(""); setForget(false); changed.current = false; setDirty(false);
  }
  useEffect(() => {
    active.current = true;
    const current = generation.current + 1;
    void load().catch(failure => { if (active.current && current === generation.current) setError(errorMessage(failure)); });
    return () => { active.current = false; held.current = null; generation.current++; };
  }, []);
  const canLeave = () => !busy.current && !held.current && !changed.current;
  function markDirty() { changed.current = true; setDirty(true); }
  async function refresh() {
    if (disabled || busy.current || held.current) return;
    busy.current = true; setPending(true); setError(""); setNotice(""); generation.current++;
    setConfig(null); setPassword(""); changed.current = false; setDirty(false);
    try { await load(); } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  async function save() {
    if (busy.current || (!held.current && (disabled || !config))) return;
    const recovering = held.current !== null, current = held.current ?? { id: account.id, key: crypto.randomUUID(), uncertain: false,
      body: { expectedRevision: account.revision, smtpRevision: config!.revision, endpointId, username, ...(password ? { password } : {}), enabled, forgetCredential: forget } };
    held.current = current; busy.current = true; generation.current++; setAttempt(current); setPending(true); setError(""); setNotice(""); setPassword("");
    try {
      let receipt = null;
      if (recovering) {
        try { receipt = readAgentSmtpReceipt(await api<unknown>(`/agent-smtp-operations/${current.key}`), current); }
        catch (failure) { if (!(failure instanceof ApiError && failure.status === 404)) throw failure; }
      }
      if (!receipt) {
        try { receipt = readAgentSmtpReceipt(await api<unknown>(`/agent-accounts/${current.id}/smtp`, "PUT", current.body, { "idempotency-key": current.key }), current); }
        catch (failure) {
          if (!(recovering && failure instanceof ApiError && failure.status === 409 && failure.message === "agent_smtp_changed")) throw failure;
          // A monotonic CAS mismatch makes the old request obsolete; confirm the original key once more before releasing uncertainty.
          try { receipt = readAgentSmtpReceipt(await api<unknown>(`/agent-smtp-operations/${current.key}`), current); }
          catch (check) {
            if (check instanceof ApiError && check.status === 404) { current.uncertain = false; throw failure; }
            throw check;
          }
        }
      }
      if (!active.current) return;
      held.current = null; setAttempt(null); changed.current = false; setDirty(false); setNotice("Agent SMTP 配置操作已确认");
      await load();
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
  return { config, endpoints, endpointId, setEndpointId, username, setUsername, password, setPassword, enabled, setEnabled, forget, setForget,
    dirty, pending, attempt, error, notice, locked: pending || attempt !== null, markDirty, canLeave, refresh, save };
}
