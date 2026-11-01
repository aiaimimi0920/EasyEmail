import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import { agentInboxPath } from "./agent-inbox-api";
import { readAgentInboundOperation, type AgentInboundAttempt, type AgentInboundInput, type AgentInboundOperation } from "./agent-inbound-api";

// Owned by the inbox, not by the selected message: navigation cannot discard an uncertain write.
export function useAgentInbound(accountId: string, onConfirmed: () => Promise<void>) {
  const [attempt, setAttempt] = useState<AgentInboundAttempt | null>(null), [operation, setOperation] = useState<AgentInboundOperation | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const held = useRef<AgentInboundAttempt | null>(null), busy = useRef(false), active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; held.current = null; }; }, []);
  async function submit(messageId?: string, body?: AgentInboundInput) {
    if (busy.current) return;
    const recovering = !!held.current, current = held.current ?? (messageId && body ? { key: crypto.randomUUID(), accountId, messageId, body: { ...body }, uncertain: false } : null);
    if (!current) return; held.current = current; busy.current = true; setAttempt({ ...current }); setPending(true); setError(""); setOperation(null);
    const path = agentInboxPath(current.accountId);
    try {
      let result: AgentInboundOperation | null = null;
      if (recovering) {
        try { result = readAgentInboundOperation(await api(`${path}/inbound-thread-operations/${current.key}`), current); }
        catch (failure) { if (!(failure instanceof ApiError && failure.status === 404)) throw failure; }
      }
      result ??= readAgentInboundOperation(await api(`${path}/messages/${current.messageId}/inbound-thread`, "PUT", current.body, { "idempotency-key": current.key }), current);
      if (!active.current) return;
      held.current = null; setAttempt(null); setOperation(result);
      try { await onConfirmed(); } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    } catch (failure) {
      if (!active.current) return; setError(errorMessage(failure));
      if (!current.uncertain && failure instanceof ApiError && failure.status < 500 && failure.status !== 429) { held.current = null; setAttempt(null); }
      else { current.uncertain = true; setAttempt({ ...current }); }
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  function abandon() {
    if (busy.current || !held.current || !window.confirm("入站线程可能已创建。放弃本页核对不会撤销创建；请刷新邮件后再操作。确认放弃？")) return;
    held.current = null; setAttempt(null); setError("");
  }
  return { attempt, operation, pending, error, locked: pending || !!attempt, submit, abandon };
}
