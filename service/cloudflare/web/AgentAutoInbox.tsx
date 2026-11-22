import { useConfirmation } from "./Confirmation";
import { Button, Checkbox, Field, Notice, Select } from '@neuro/ui';
import { dateText, errorMessage, ApiError } from "./api";
import type { useAgentAutoInbox } from "./useAgentAutoInbox";
const states = { idle: "尚未运行", running: "收件中", committed: "本次收件已提交", failed: "本次收件失败", interrupted: "本次收件已中断" };
export function AgentAutoInbox({ state, disabled, canAct }: { state: ReturnType<typeof useAgentAutoInbox>; disabled: boolean; canAct: () => boolean }) {
  const locked = disabled || state.locked, config = state.config;
  const confirm = useConfirmation([config, state.enabled, state.interval, locked]);
  return <section aria-label="Agent 自动收件"><h3>自动收件</h3>
    <Button disabled={locked} onClick={async () => { if (canAct() && (!state.dirty || (await confirm("丢弃未保存的自动收件配置并刷新？")))) void state.refresh(); }} variant="quiet" wrap>刷新自动收件</Button>
    {config && <><p>配置版本 {config.revision} · {config.enabled ? config.ready ? "已启用" : "需重新确认账号" : "已关闭"}</p>
      <form onSubmit={event => { event.preventDefault(); if (canAct()) void state.save(); }}>
        <Checkbox checked={state.enabled} disabled={locked} onChange={event => state.changeEnabled(event.target.checked)} label="启用 Agent 自动收件" />
        <Field label="自动收件间隔"><Select value={state.interval} disabled={locked} onChange={event => state.changeInterval(Number(event.target.value))}>
          <option value={5}>5 分钟</option><option value={15}>15 分钟</option><option value={60}>60 分钟</option></Select></Field>
        <Button disabled={locked} type="submit" wrap>保存自动收件</Button>
      </form>
      <Notice role="status" tone="info">{states[config.lastState]} · 最近开始：{dateText(config.lastStartedAt)} · 下次：{dateText(config.nextDueAt)}</Notice>
      {config.lastErrorCode && <p>{errorMessage(new ApiError(503, config.lastErrorCode))}</p>}
    </>}
    {state.dirty && <Notice role="status" tone="info">自动收件配置有未保存修改</Notice>}
    {state.attempt && <Button disabled={state.pending} onClick={() => void state.save()} wrap>核对原自动收件配置</Button>}
    {state.error && <Notice role="alert" tone="danger">{state.error}</Notice>}{state.notice && <Notice role="status" tone="info">{state.notice}</Notice>}
  </section>;
}
