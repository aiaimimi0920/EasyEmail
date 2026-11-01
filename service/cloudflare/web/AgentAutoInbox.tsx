import { dateText, errorMessage, ApiError } from "./api";
import type { useAgentAutoInbox } from "./useAgentAutoInbox";
const states = { idle: "尚未运行", running: "收件中", committed: "本次收件已提交", failed: "本次收件失败", interrupted: "本次收件已中断" };
export function AgentAutoInbox({ state, disabled, canAct }: { state: ReturnType<typeof useAgentAutoInbox>; disabled: boolean; canAct: () => boolean }) {
  const locked = disabled || state.locked, config = state.config;
  return <section aria-label="Agent 自动收件"><h3>自动收件</h3>
    <button className="secondary" disabled={locked} onClick={() => { if (canAct() && (!state.dirty || window.confirm("丢弃未保存的自动收件配置并刷新？"))) void state.refresh(); }}>刷新自动收件</button>
    {config && <><p>配置版本 {config.revision} · {config.enabled ? config.ready ? "已启用" : "需重新确认账号" : "已关闭"}</p>
      <form onSubmit={event => { event.preventDefault(); if (canAct()) void state.save(); }}>
        <label><input type="checkbox" checked={state.enabled} disabled={locked} onChange={event => state.changeEnabled(event.target.checked)} />启用 Agent 自动收件</label>
        <label>自动收件间隔<select value={state.interval} disabled={locked} onChange={event => state.changeInterval(Number(event.target.value))}>
          <option value={5}>5 分钟</option><option value={15}>15 分钟</option><option value={60}>60 分钟</option></select></label>
        <button disabled={locked}>保存自动收件</button>
      </form>
      <p role="status">{states[config.lastState]} · 最近开始：{dateText(config.lastStartedAt)} · 下次：{dateText(config.nextDueAt)}</p>
      {config.lastErrorCode && <p>{errorMessage(new ApiError(503, config.lastErrorCode))}</p>}
    </>}
    {state.dirty && <p role="status">自动收件配置有未保存修改</p>}
    {state.attempt && <button disabled={state.pending} onClick={() => void state.save()}>核对原自动收件配置</button>}
    {state.error && <p role="alert">{state.error}</p>}{state.notice && <p role="status">{state.notice}</p>}
  </section>;
}
