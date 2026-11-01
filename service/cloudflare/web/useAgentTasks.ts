import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage, type Page } from "./api";
import { readAgentTask, readAgentTaskPage, type AgentTask, type AgentTaskInput, type AgentTaskAttempt } from "./agent-tasks-api";

export function useAgentTasks(visible: boolean) {
  const [page, setPage] = useState<Page<AgentTask> | null>(null), [selected, setSelected] = useState<AgentTask | null>(null);
  const [attempt, setAttempt] = useState<AgentTaskAttempt | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const held = useRef<AgentTaskAttempt | null>(null), busy = useRef(false), active = useRef(false), generation = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; held.current = null; }; }, []);
  async function reload(cursor = "") {
    const current = ++generation.current, value = readAgentTaskPage(await api(`/agent-tasks${cursor ? `?cursor=${cursor}` : ""}`));
    if (active.current && current === generation.current) setPage(old => cursor ? { ...value, items: [...(old?.items ?? []), ...value.items] } : value);
  }
  async function refresh() {
    if (busy.current || held.current) return; busy.current = true; setPending(true); setError("");
    try { await reload(); } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  useEffect(() => { if (visible) void refresh(); }, [visible]);
  async function submit(body?: AgentTaskInput) {
    if (busy.current) return;
    const recovering = !!held.current, current = held.current ?? (body ? { key: crypto.randomUUID(), body: { ...body }, uncertain: false } : null);
    if (!current) return; held.current = current; busy.current = true; generation.current++; setAttempt(current); setPending(true); setError("");
    try {
      let task = null;
      if (recovering) {
        try { task = readAgentTask(await api(`/agent-tasks?requestKey=${current.key}`), current); }
        catch (failure) { if (!(failure instanceof ApiError && failure.status === 404)) throw failure; }
      }
      task ??= readAgentTask(await api("/agent-tasks", "POST", current.body, { "idempotency-key": current.key }), current);
      if (!active.current) return; held.current = null; setAttempt(null); setSelected(task);
      try { await reload(); } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    } catch (failure) {
      if (active.current) {
        setError(errorMessage(failure));
        if (!current.uncertain && failure instanceof ApiError && failure.status < 500 && failure.status !== 429) { held.current = null; setAttempt(null); }
        else { current.uncertain = true; setAttempt({ ...current }); }
      }
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  async function read(id: string, cancel = false) {
    if (busy.current || held.current) return; busy.current = true; setPending(true); setError(""); const current = ++generation.current;
    try {
      const task = readAgentTask(await api(`/agent-tasks/${id}${cancel ? "/cancel" : ""}`, cancel ? "POST" : "GET", cancel ? { expectedRevision: selected!.revision } : undefined));
      if (task.id !== id) throw new ApiError(502, "agent_task_response_invalid");
      if (active.current && current === generation.current) setSelected(task); await reload();
    } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  async function more() {
    if (busy.current || held.current || !page?.nextCursor) return; busy.current = true; setPending(true);
    try { await reload(page.nextCursor); } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  function newTask() {
    if (busy.current) return false;
    if ((held.current || selected) && !window.confirm("原任务可能已经排队或提交。另建任务不会撤销原任务，重复内容可能再次发送，确认另建？")) return false;
    held.current = null; generation.current++; setAttempt(null); setSelected(null); setError(""); return true;
  }
  return { page, selected, attempt, pending, locked: pending || !!attempt, error, submit, read, refresh, more, newTask };
}
