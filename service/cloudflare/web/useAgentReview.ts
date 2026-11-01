import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import { agentInboxPath } from "./agent-inbox-api";
import { readAgentReviewOperation, type AgentReviewAttempt, type AgentReviewInput, type AgentReviewOperation } from "./agent-review-api";

export function useAgentReview(accountId: string, onConfirmed: () => Promise<void>) {
  const [attempt, setAttempt] = useState<AgentReviewAttempt | null>(null), [operation, setOperation] = useState<AgentReviewOperation | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const held = useRef<AgentReviewAttempt | null>(null), busy = useRef(false), active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; held.current = null; }; }, []);
  async function submit(messageId?: string, body?: AgentReviewInput) {
    if (busy.current) return;
    const recovering = !!held.current, current = held.current ?? (messageId && body ? { key: crypto.randomUUID(), accountId, messageId, body: { ...body }, uncertain: false } : null);
    if (!current) return; held.current = current; busy.current = true; setAttempt({ ...current }); setPending(true); setError(""); setOperation(null);
    const path = agentInboxPath(current.accountId);
    try {
      let result: AgentReviewOperation | null = null;
      if (recovering) {
        try { result = readAgentReviewOperation(await api(`${path}/review-operations/${current.key}`), current); }
        catch (failure) { if (!(failure instanceof ApiError && failure.status === 404)) throw failure; }
      }
      result ??= readAgentReviewOperation(await api(`${path}/messages/${current.messageId}/review`, "PUT", current.body, { "idempotency-key": current.key }), current);
      if (!active.current) return;
      held.current = null; setAttempt(null); setOperation(result);
      // Refresh failures must never turn a confirmed write into an uncertain attempt.
      try { await onConfirmed(); } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    } catch (failure) {
      if (!active.current) return; setError(errorMessage(failure));
      if (!current.uncertain && failure instanceof ApiError && failure.status < 500 && failure.status !== 429) { held.current = null; setAttempt(null); }
      else { current.uncertain = true; setAttempt({ ...current }); }
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  function abandon() {
    if (busy.current || !held.current || !window.confirm("原人工处理可能已保存。放弃本页核对不会撤销该处理；请刷新邮件后再操作。确认放弃？")) return;
    held.current = null; setAttempt(null); setError("");
  }
  return { attempt, operation, pending, error, locked: pending || !!attempt, submit, abandon };
}
