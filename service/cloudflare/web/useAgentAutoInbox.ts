import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import type { AgentAccount } from "./agent-accounts-api";
import { fetchAutoInbox, readAutoInboxReceipt, type AutoInboxConfig, type AutoInboxAttempt } from "./agent-auto-inbox-api";

export function useAgentAutoInbox(account: AgentAccount | null, visible: boolean) {
  const [config, setConfig] = useState<AutoInboxConfig | null>(null), [enabled, setEnabled] = useState(false), [interval, setInterval] = useState(15);
  const [dirty, setDirty] = useState(false), [pending, setPending] = useState(false), [attempt, setAttempt] = useState<AutoInboxAttempt | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const active = useRef(false), busy = useRef(false), held = useRef<AutoInboxAttempt | null>(null), changed = useRef(false), generation = useRef(0);
  const selected = useRef(account); selected.current = account;
  useEffect(() => { active.current = true; return () => { active.current = false; held.current = null; generation.current++; }; }, []);
  async function load() {
    const target = selected.current; if (!target) return;
    const current = ++generation.current, next = await fetchAutoInbox(target);
    if (!active.current || current !== generation.current || selected.current?.id !== target.id || selected.current?.revision !== target.revision) return;
    setConfig(next); setEnabled(next.enabled); setInterval(next.intervalMinutes); changed.current = false; setDirty(false);
  }
  useEffect(() => {
    if (busy.current || held.current || changed.current && config?.accountId === account?.id && config?.accountRevision === account?.revision) return;
    setConfig(null); setError(""); setNotice(""); changed.current = false; setDirty(false);
    const current = generation.current + 1;
    if (visible && account) void load().catch(failure => { if (active.current && current === generation.current) setError(errorMessage(failure)); });
    return () => { generation.current++; };
  }, [account?.id, account?.revision, visible]);
  const canLeave = () => !busy.current && !held.current && !changed.current;
  function changeEnabled(value: boolean) { if (busy.current || held.current) return; setEnabled(value); changed.current = true; setDirty(true); }
  function changeInterval(value: number) { if (busy.current || held.current) return; setInterval(value); changed.current = true; setDirty(true); }
  async function refresh() {
    if (busy.current || held.current) return; busy.current = true; setPending(true); setError(""); setNotice("");
    try { await load(); } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  async function save() {
    if (busy.current || !held.current && (!account || !config)) return;
    if (!held.current && enabled && !window.confirm("允许平台持续读取此 Agent 邮箱？退出网页或撤销本次 Key 不会停止；关闭自动收件、停用或修改账号后停止。")) return;
    const current = held.current ?? { accountId: account!.id, key: crypto.randomUUID(), uncertain: false,
      body: { expectedAccountRevision: account!.revision, expectedRevision: config!.revision, enabled, intervalMinutes: interval, persistentAuthorization: enabled } };
    const recovering = !!held.current;
    held.current = current; busy.current = true; generation.current++; setAttempt(current); setPending(true); setError(""); setNotice("");
    try {
      let receipt = null;
      const receiptPath = `/agent-inbox-automation-operations/${current.key}`;
      if (recovering) {
        try { receipt = readAutoInboxReceipt(await api(receiptPath), current); }
        catch (failure) { if (!(failure instanceof ApiError && failure.status === 404)) throw failure; }
      }
      if (!receipt) {
        try { receipt = readAutoInboxReceipt(await api(`/agent-accounts/${current.accountId}/auto-inbox`, "PUT", current.body, { "idempotency-key": current.key }), current); }
        catch (failure) {
          if (!(recovering && failure instanceof ApiError && failure.status === 409 && failure.message === "agent_auto_inbox_changed")) throw failure;
          try { receipt = readAutoInboxReceipt(await api(receiptPath), current); }
          catch (check) { if (check instanceof ApiError && check.status === 404) { current.uncertain = false; throw failure; } throw check; }
        }
      }
      if (!active.current) return;
      held.current = null; setAttempt(null); changed.current = false; setDirty(false); setNotice("自动收件配置已确认");
      try { await load(); } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    } catch (failure) {
      if (!active.current) return; setError(errorMessage(failure));
      if (held.current) {
        if (!current.uncertain && failure instanceof ApiError && failure.status < 500) { held.current = null; setAttempt(null); }
        else { current.uncertain = true; setAttempt({ ...current }); }
      }
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  return { config, enabled, interval, dirty, pending, attempt, error, notice, locked: pending || !!attempt,
    canLeave, changeEnabled, changeInterval, refresh, save };
}
