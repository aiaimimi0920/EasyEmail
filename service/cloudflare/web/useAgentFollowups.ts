import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage, type Page } from "./api";
import type { AgentThread } from "./agent-threads-api";
import { agentFollowupReceiptIdentity, readAgentFollowup, readAgentFollowupContext, readAgentFollowupPage, type AgentFollowup,
  type AgentFollowupAttempt, type AgentFollowupContext, type AgentFollowupInput } from "./agent-followups-api";

type Attempt = ({ kind: "send" } & AgentFollowupAttempt) | { kind: "cancel"; row: AgentFollowup; threadId: string; uncertain: boolean };
export interface FollowupAnchor { type: AgentFollowupInput["replyToType"]; id: string; subject: string }
interface Options { visible: boolean; thread: AgentThread | null; threadLocked: boolean; threadBusy: () => boolean; guard: { current: boolean } }
export function useAgentFollowups({ visible, thread, threadLocked, threadBusy, guard }: Options) {
  const [page, setPage] = useState<Page<AgentFollowup> | null>(null), [context, setContext] = useState<AgentFollowupContext | null>(null);
  const [selected, setSelected] = useState<AgentFollowup | null>(null), [anchor, setAnchor] = useState<(FollowupAnchor & { threadId: string }) | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null), [pending, setPending] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [completedKey, setCompletedKey] = useState("");
  const active = useRef(false), busy = useRef(false), held = useRef<Attempt | null>(null), generation = useRef(0), root = useRef("");
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; held.current = null; guard.current = false; }; }, []);
  const current = (id: number) => active.current && id === generation.current;
  function begin() { busy.current = true; guard.current = true; setPending(true); setError(""); return ++generation.current; }
  function finish() { busy.current = false; guard.current = !!held.current; if (active.current) setPending(false); }
  async function load(target: AgentThread, id: number, cursor = "") {
    const list = api(`/agent-threads/${target.id}/followups?limit=20${cursor ? `&cursor=${cursor}` : ""}`)
      .then(value => readAgentFollowupPage(value, target, cursor));
    const source = cursor ? Promise.resolve(context) : api(`/agent-threads/${target.id}/followup-context`).then(value => readAgentFollowupContext(value, target));
    const [rows, sourceResult] = await Promise.allSettled([list, source]);
    if (!current(id)) return;
    if (rows.status === "fulfilled") setPage(old => cursor ? { ...rows.value, items: [...(old?.items ?? []), ...rows.value.items] } : rows.value);
    if (!cursor) setContext(sourceResult.status === "fulfilled" ? sourceResult.value : null);
    if (rows.status === "rejected") throw rows.reason;
    if (sourceResult.status === "rejected") throw sourceResult.reason;
  }
  async function refresh(cursor = "") {
    if (!thread || busy.current || held.current || threadBusy()) return;
    const id = begin();
    if (root.current !== thread.id) { root.current = thread.id; setContext(null); setPage(null); setSelected(null); setAnchor(null); setNotice(""); }
    try { await load(thread, id, cursor); } catch (failure) { if (current(id)) setError(errorMessage(failure)); }
    finally { finish(); }
  }
  useEffect(() => {
    if (!thread && !held.current) { generation.current++; root.current = ""; setContext(null); setPage(null); setSelected(null); setAnchor(null); setError(""); setNotice(""); }
    else if (visible && !threadLocked) void refresh();
  }, [visible, thread?.id, thread?.management.revision, thread?.management.state, threadLocked]);
  async function read(id: string) {
    if (!thread || busy.current || held.current || threadBusy()) return;
    const operation = begin();
    try {
      const row = readAgentFollowup(await api(`/agent-followups/${id}`));
      if (row.id !== id || row.threadId !== thread.id || row.threadKind !== thread.kind) throw new ApiError(502, "agent_followup_response_invalid");
      if (current(operation)) setSelected(row);
    } catch (failure) { if (current(operation)) setError(errorMessage(failure)); }
    finally { finish(); }
  }
  function choose(value: FollowupAnchor) {
    if (!thread || busy.current || held.current || threadBusy()) return; setAnchor({ ...value, threadId: thread.id });
  }
  async function execute(action: Attempt, recovering: boolean) {
    if (busy.current || threadBusy() || !thread || action.threadId !== thread.id || held.current && held.current !== action) return;
    held.current = action; const operation = begin(); setAttempt({ ...action }); setNotice("");
    try {
      let row: AgentFollowup;
      if (action.kind === "send") {
        let receipt: AgentFollowup | null = null;
        if (recovering) {
          try { receipt = readAgentFollowup(await api(`/agent-followups?requestKey=${action.key}`), action); }
          catch (failure) { if (!(failure instanceof ApiError && failure.status === 404)) throw failure; }
        }
        row = receipt ?? readAgentFollowup(await api(`/agent-threads/${action.threadId}/followups`, "POST", action.body, { "idempotency-key": action.key }), action);
      } else {
        row = readAgentFollowup(await api(`/agent-followups/${action.row.id}${recovering ? "" : "/cancel"}`, recovering ? "GET" : "POST",
          recovering ? undefined : { expectedRevision: action.row.revision }), agentFollowupReceiptIdentity(action.row));
        if (row.id !== action.row.id || row.requestKey !== action.row.requestKey || row.threadId !== action.threadId || row.threadKind !== action.row.threadKind
          || row.revision < action.row.revision || !recovering && row.state !== "cancelled") throw new ApiError(502, "agent_followup_response_invalid");
      }
      if (!current(operation)) return;
      held.current = null; setAttempt(null); setSelected(row);
      setNotice(action.kind === "send" ? "跟进请求已保存" : row.state === "cancelled" ? "跟进派发已取消" : "取消已核对，当前状态见发送记录");
      if (action.kind === "send") setCompletedKey(action.key);
      // A confirmed write must not become uncertain because a subsequent source/list read failed.
      try { await load(thread, operation); } catch (failure) { if (current(operation)) setError(errorMessage(failure)); }
    } catch (failure) {
      if (!current(operation)) return; setError(errorMessage(failure));
      if (!action.uncertain && failure instanceof ApiError && failure.status < 500 && failure.status !== 429) { held.current = null; setAttempt(null); }
      else { action.uncertain = true; setAttempt({ ...action }); }
    } finally { finish(); }
  }
  async function submit(input: AgentFollowupInput) {
    if (!thread || !context || context.threadId !== thread.id || context.threadRevision !== thread.management.revision
      || context.threadState !== thread.management.state || busy.current || held.current || threadBusy()) return;
    await execute({ kind: "send", key: crypto.randomUUID(), threadId: thread.id, threadKind: thread.kind,
      body: { ...input }, from: context.from, to: context.to, uncertain: false }, false);
  }
  const recover = () => held.current ? execute(held.current, true) : Promise.resolve();
  const cancel = () => selected?.cancellable && thread ? execute({ kind: "cancel", row: { ...selected }, threadId: thread.id, uncertain: false }, false) : Promise.resolve();
  function abandon() {
    if (busy.current || !held.current || !window.confirm("原跟进可能已经排队、提交或取消。放弃本页核对不会撤销或重发原请求；确认放弃？")) return;
    held.current = null; guard.current = false; generation.current++; setAttempt(null); setContext(null); setPage(null); setSelected(null); setAnchor(null);
    setNotice("已放弃本页核对，原意图未撤销"); setError("");
  }
  return { page: page && page.items.every(row => row.threadId === thread?.id) ? page : null,
    context: context?.threadId === thread?.id && context?.threadRevision === thread?.management.revision && context?.threadState === thread?.management.state ? context : null,
    selected: selected?.threadId === thread?.id ? selected : null, anchor: anchor?.threadId === thread?.id ? anchor : null,
    attempt, pending, locked: pending || !!attempt, error, notice, completedKey, refresh, read, choose, submit, recover, cancel, abandon };
}
