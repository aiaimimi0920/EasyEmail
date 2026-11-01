import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import { readAgentServiceReceipt, type AgentServiceAttempt, type AgentServiceOperation } from "./agent-services-api";

export function useAgentServiceMutation(onChanged: () => void) {
  const [attempt, setAttempt] = useState<AgentServiceAttempt | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const held = useRef<AgentServiceAttempt | null>(null), busy = useRef(false), active = useRef(false), done = useRef(onChanged);
  done.current = onChanged;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function submit(input?: Omit<AgentServiceAttempt, "key">) {
    if (busy.current) return;
    const recovering = held.current !== null;
    const current = held.current ?? (input ? { ...input, body: { ...input.body }, key: crypto.randomUUID() } : null);
    if (!current) return;
    held.current = current; busy.current = true; setAttempt(current); setPending(true); setError("");
    try {
      let receipt: AgentServiceOperation | null = null;
      if (recovering) {
        try { receipt = readAgentServiceReceipt(await api<unknown>(`/agent-service-operations/${current.key}`), current); }
        catch (failure) { if (!(failure instanceof ApiError && failure.status === 404)) throw failure; }
      }
      if (!receipt) readAgentServiceReceipt(await api<unknown>(current.path, current.method, current.body, { "idempotency-key": current.key }), current);
      if (active.current) { held.current = null; setAttempt(null); done.current(); }
    } catch (failure) {
      if (active.current) {
        setError(errorMessage(failure));
        if (failure instanceof ApiError && failure.status < 500 && failure.status !== 429) { held.current = null; setAttempt(null); }
      }
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  return { submit, attempt, pending, locked: attempt !== null, error };
}
