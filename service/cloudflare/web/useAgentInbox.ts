import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import { agentInboxPath, agentIncomingPage, agentIncomingThreadId, readAgentIncoming, readAgentInboxOperation,
  type AgentIncoming, type AgentInboxAttempt, type AgentInboxOperation, type AgentInboxPage } from "./agent-inbox-api";

export function useAgentInbox(accountId: string, revision: number, visible: boolean, threadId = "", review = "") {
  const [page, setPage] = useState<AgentInboxPage | null>(null), [message, setMessage] = useState<AgentIncoming | null>(null);
  const [attempt, setAttempt] = useState<AgentInboxAttempt | null>(null), [operation, setOperation] = useState<AgentInboxOperation | null>(null);
  const [pending, setPending] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState("");
  const held = useRef<AgentInboxAttempt | null>(null), busy = useRef(false), active = useRef(false), generation = useRef(0);
  const reader = useRef<AbortController | null>(null), detail = useRef<AbortController | null>(null), path = agentInboxPath(accountId);
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; reader.current?.abort(); detail.current?.abort(); held.current = null; }; }, []);
  async function refresh(cursor = "") {
    const current = ++generation.current, controller = new AbortController(); reader.current?.abort(); reader.current = controller;
    detail.current?.abort(); setMessage(null); setReading(true); setError("");
    try {
      const next = await agentIncomingPage(accountId, threadId, cursor, controller.signal, review);
      if (active.current && !controller.signal.aborted && current === generation.current)
        setPage(old => cursor && old?.epochId === next.epochId ? { ...next, items: [...old.items, ...next.items] } : next);
    } catch (failure) { if (active.current && !controller.signal.aborted && current === generation.current) setError(errorMessage(failure)); }
    finally { if (reader.current === controller) { reader.current = null; if (active.current) setReading(false); } }
  }
  useEffect(() => { if (visible) void refresh(); return () => { generation.current++; reader.current?.abort(); detail.current?.abort(); }; }, [visible, accountId, revision, threadId, review]);
  async function synchronize() {
    if (busy.current) return;
    const recovering = !!held.current, current = held.current ?? { key: crypto.randomUUID(), accountId, revision, uncertain: false };
    held.current = current; setAttempt({ ...current }); busy.current = true; setPending(true); setError("");
    try {
      let result: AgentInboxOperation | null = null;
      if (recovering) {
        try { result = readAgentInboxOperation(await api(`${path}/sync-requests/${current.key}`), current); }
        catch (failure) { if (!(failure instanceof ApiError && failure.status === 404)) throw failure; }
      }
      result ??= readAgentInboxOperation(await api(`${path}/sync`, "POST", { expectedRevision: current.revision }, { "idempotency-key": current.key }), current);
      if (!active.current) return;
      setOperation(result);
      if (result.state === "pending") { current.uncertain = true; setAttempt({ ...current }); }
      else {
        held.current = null; setAttempt(null); await refresh();
        if (result.state === "failed" && active.current) setError(errorMessage(new ApiError(503, result.errorCode ?? "agent_inbox_interrupted")));
      }
    } catch (failure) {
      if (!active.current) return; setError(errorMessage(failure));
      if (!current.uncertain && failure instanceof ApiError && failure.status < 500) { held.current = null; setAttempt(null); }
      else { current.uncertain = true; setAttempt({ ...current }); }
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  async function open(id: string) {
    const controller = new AbortController(); detail.current?.abort(); detail.current = controller; setMessage(null); setError("");
    try {
      const next = readAgentIncoming(await api(`${path}/messages/${id}`, "GET", undefined, undefined, controller.signal), accountId, id);
      if (threadId && agentIncomingThreadId(next) !== threadId) throw new ApiError(502, "agent_inbox_response_invalid");
      if (active.current && !controller.signal.aborted) setMessage(next);
    } catch (failure) { if (active.current && !controller.signal.aborted) setError(errorMessage(failure)); }
  }
  return { page, message, attempt, operation, pending, reading, error, synchronize, open, refresh, locked: pending || !!attempt };
}
