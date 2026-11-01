import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, dateText, errorMessage } from "./api";
import { retentionCounts, retentionFields, type RetentionPolicy, type RetentionPreview, type RetentionRun, type RetentionState, type NormalObjectCleanup } from "./retention";

interface Attempt { key: string; revision: number; uncertain: boolean }

export function RetentionPanel({ visible }: { visible: boolean }) {
  const [state, setState] = useState<RetentionState | null>(null), [draft, setDraft] = useState<RetentionPolicy | null>(null);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [status, setStatus] = useState("");
  const [unresolved, setUnresolved] = useState(false), [refresh, setRefresh] = useState(0);
  const attempt = useRef<Attempt | null>(null), busy = useRef(false), active = useRef(false);
  const locked = !!attempt.current;
  const changed = !!state && JSON.stringify(state.policy) !== JSON.stringify(draft);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!visible || busy.current || attempt.current) return;
    let current = true;
    setPending(true); setError(""); setPreview(null);
    api<RetentionState>("/admin/retention").then((value) => {
      if (current) { setState(value); setDraft(value.policy); }
    }).catch((failure) => { if (current) setError(errorMessage(failure)); })
      .finally(() => { if (current) setPending(false); });
    return () => { current = false; };
  }, [visible, refresh]);

  function update(fields: Partial<RetentionPolicy>) {
    setDraft((old) => old ? { ...old, ...fields } : old); setPreview(null); setStatus("");
  }
  async function action(task: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(""); setStatus("");
    try { await task(); } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  async function inspect() {
    if (!state || !draft) return;
    const value = await api<{ preview: RetentionPreview; normalObjects: NormalObjectCleanup }>("/admin/retention/preview", "POST", { expectedRevision: state.revision, policy: draft });
    if (active.current) { setPreview(value.preview); setState(old => old ? { ...old, normalObjects: value.normalObjects } : old); }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!state || !draft || !preview || !changed || locked || busy.current) return;
    if (!window.confirm("保存此平台保留策略？缓存清除不可恢复；新邮箱期限仅适用于后续分配，已设期限不会因关闭策略而延长。不删除上游资源。")) return;
    void action(async () => {
      const value = await api<RetentionState>("/admin/retention", "PUT", { expectedRevision: state.revision, policy: draft, confirm: "APPLY RETENTION" });
      if (active.current) { setState(value); setDraft(value.policy); setPreview(null); setStatus("保留策略已保存，请重新预览后维护"); }
    });
  }
  function maintain() {
    if (!state || busy.current || (!attempt.current && (!preview || changed))) return;
    if (!attempt.current && !window.confirm("确认执行一批平台维护？每类最多 100 条，永久清除符合条件的临时及普通邮箱缓存、发送内容、供应商审计和到期凭据；保留防重放记录，不删除上游资源。普通原文和附件对象按批重试回收。")) return;
    void action(async () => {
      attempt.current ??= { key: crypto.randomUUID(), revision: state.revision, uncertain: false };
      const current = attempt.current;
      try {
        const value = await api<{ run: RetentionRun; replayed: boolean; normalObjects: NormalObjectCleanup }>("/admin/retention/run", "POST",
          { expectedRevision: current.revision, confirm: "RUN RETENTION" }, { "idempotency-key": current.key });
        if (active.current) {
          attempt.current = null; setUnresolved(false); setPreview(null);
          setState((old) => old ? { ...old, lastRun: value.run, normalObjects: value.normalObjects } : old);
          setStatus(value.replayed ? "已核对原维护结果，未再执行一批" : "本批维护已完成，继续前请重新预览");
        }
      } catch (failure) {
        if (!current.uncertain && failure instanceof ApiError && failure.status < 500) attempt.current = null;
        else { current.uncertain = true; if (active.current) setUnresolved(true); }
        throw failure;
      }
    });
  }

  return <section className="card" aria-label="数据保留"><h2>数据保留</h2>
    <button className="secondary" disabled={pending || locked} onClick={() => setRefresh((value) => value + 1)}>刷新保留策略</button>
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    {state && draft && <>
      <p>策略版本：{state.revision} · {state.policy.enabled ? "自动保留已启用" : "自动保留已关闭"}</p>
      {state.normalObjects && <p role="status">普通对象待确认回收：{state.normalObjects.pending} · {state.normalObjects.available ? "后台分批重试" : "存储未配置"}</p>}
      <form onSubmit={save}>
        <fieldset disabled={pending || locked}>
          <label className="check"><input type="checkbox" checked={draft.enabled} onChange={(event) => update({ enabled: event.target.checked })} />启用自动保留策略</label>
          <div className="row">{Object.entries(retentionFields).map(([key, label]) => <label key={key}>{label}<input type="number" min="0" max="3650" step="1" required
            value={Number.isNaN(draft[key as keyof typeof retentionFields]) ? "" : draft[key as keyof typeof retentionFields]} onChange={(event) => update({ [key]: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>)}</div>
          <p>0 表示不自动清理。邮箱期限仅用于新分配；关闭策略不延长已设期限。仅影响平台数据，不删除上游资源；缓存清除不可恢复。</p>
          <div className="row"><button type="button" className="secondary" onClick={() => action(inspect)}>预览保留影响</button>
            <button disabled={!changed || !preview}>保存保留策略</button></div>
        </fieldset>
      </form>
      {preview && <section aria-label="保留预览"><h3>下一批预览</h3><small>{dateText(preview.checkedAt)} · 每类最多 {preview.batchLimit} 条 · 非锁定快照</small>
        <dl>{Object.entries(preview.counts).map(([key, value]) => <div key={key}><dt>{retentionCounts[key]}</dt><dd>{value}{preview.more[key] ? "（仍有积压）" : ""}</dd></div>)}</dl>
      </section>}
      <button disabled={pending || (!locked && (!preview || changed))} onClick={maintain}>{unresolved ? "检查维护结果" : "执行一批维护"}</button>
      {unresolved && <p role="status">维护结果待确认，请使用原幂等键核对，不要另起一批。</p>}
      {attempt.current && <p>维护幂等键：<code data-testid="retention-attempt-key">{attempt.current.key}</code></p>}
      {state.lastRun && <section aria-label="最近维护"><h3>最近维护结果</h3><small>{dateText(state.lastRun.completedAt)} · 策略版本 {state.lastRun.revision}</small>
        <dl>{Object.entries(state.lastRun.counts).map(([key, value]) => <div key={key}><dt>{retentionCounts[key]}</dt><dd>{value}</dd></div>)}</dl>
      </section>}
    </>}
  </section>;
}
