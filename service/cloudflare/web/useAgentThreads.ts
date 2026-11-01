import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage, type Page } from "./api";
import { readAgentThread, readAgentThreadOperation, readAgentThreadPage, type AgentThread, type AgentThreadAttempt, type AgentThreadState } from "./agent-threads-api";

export function useAgentThreads(visible: boolean, blocked?: { current: boolean }) {
  const [page, setPage] = useState<Page<AgentThread> | null>(null), [selected, setSelected] = useState<AgentThread | null>(null);
  const [filter, setFilter] = useState(""), [pending, setPending] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState<AgentThreadAttempt | null>(null);
  const held = useRef<AgentThreadAttempt | null>(null), busy = useRef(false), active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; held.current = null; }; }, []);
  async function reload(state = filter, cursor = "") {
    const params = new URLSearchParams(); if (state) params.set("state", state); if (cursor) params.set("cursor", cursor);
    const next = readAgentThreadPage(await api(`/agent-threads${params.size ? `?${params}` : ""}`), state, cursor);
    if (active.current) setPage(old => cursor ? { ...next, items: [...(old?.items ?? []), ...next.items] } : next);
  }
  async function refresh(state = filter, cursor = "") {
    if (busy.current || held.current || blocked?.current) return; busy.current = true; setPending(true); setError("");
    if (state !== filter) { setFilter(state); setSelected(null); setPage(null); }
    try {
      await reload(state, cursor);
      if (!cursor && state === filter && selected) {
        const next = readAgentThread(await api(`/agent-threads/${selected.id}`)); if (next.id !== selected.id) throw new ApiError(502, "agent_thread_response_invalid");
        if (active.current) setSelected(next);
      }
    } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  useEffect(() => { if (visible) void refresh(); }, [visible]);
  async function read(id: string) {
    if (busy.current || held.current || blocked?.current) return; busy.current = true; setPending(true); setError(""); setNotice("");
    try {
      const next = readAgentThread(await api(`/agent-threads/${id}`)); if (next.id !== id) throw new ApiError(502, "agent_thread_response_invalid");
      if (active.current) setSelected(next);
    } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  async function submit(state?: AgentThreadState) {
    if (busy.current || blocked?.current) return;
    const recovering = !!held.current, current = held.current ?? (selected && state ? { key: crypto.randomUUID(), threadId: selected.id,
      body: { expectedRevision: selected.management.revision, state }, uncertain: false } : null);
    if (!current) return; held.current = current; busy.current = true; setAttempt({ ...current }); setPending(true); setError(""); setNotice("");
    try {
      let operation = null;
      if (recovering) {
        try { operation = readAgentThreadOperation(await api(`/agent-thread-operations/${current.key}`), current); }
        catch (failure) { if (!(failure instanceof ApiError && failure.status === 404)) throw failure; }
      }
      operation ??= readAgentThreadOperation(await api(`/agent-threads/${current.threadId}/state`, "PUT", current.body, { "idempotency-key": current.key }), current);
      if (!active.current) return;
      held.current = null; setAttempt(null); setNotice("线程状态已保存");
      // A confirmed receipt stays confirmed even if its subsequent read fails.
      try {
        const next = readAgentThread(await api(`/agent-threads/${current.threadId}`)); if (next.id !== current.threadId) throw new ApiError(502, "agent_thread_response_invalid");
        if (active.current) setSelected(next); await reload();
      } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    } catch (failure) {
      if (!active.current) return; setError(errorMessage(failure));
      if (!current.uncertain && failure instanceof ApiError && failure.status < 500 && failure.status !== 429) { held.current = null; setAttempt(null); }
      else { current.uncertain = true; setAttempt({ ...current }); }
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  function abandon() {
    if (busy.current || blocked?.current || !held.current || !window.confirm("原线程状态可能已保存。放弃本页核对不会撤销该操作；请刷新线程后再操作。确认放弃？")) return;
    held.current = null; setAttempt(null); setNotice(""); setError(""); setSelected(null); setPage(null);
  }
  return { page, selected, filter, pending, locked: pending || !!attempt, isBusy: () => busy.current || !!held.current, error, notice, attempt, refresh, read, submit, abandon };
}
