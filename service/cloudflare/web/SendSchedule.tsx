import { Field, Input, Select } from '@neuro/ui';
import { useId } from "react";

export type SendMode = "direct" | "undo-5s" | "undo-10s" | "undo-20s" | "queued" | "scheduled";

export function undoGraceSeconds(mode: SendMode): number | null {
  if (mode === "undo-5s") return 5;
  if (mode === "undo-10s") return 10;
  if (mode === "undo-20s") return 20;
  return null;
}

export function scheduledValue(mode: SendMode, localTime: string): number | null | undefined {
  if (mode === "direct") return undefined;
  const grace = undoGraceSeconds(mode);
  if (grace !== null) return Math.floor(Date.now() / 1000) + grace;
  if (mode === "queued") return null;
  const time = new Date(localTime).getTime(), now = Date.now();
  if (!Number.isFinite(time) || time <= now || time > now + 30 * 86400000) throw new Error("请选择未来 30 天内的计划发送时间");
  return Math.floor(time / 1000);
}

export function SendSchedule({ mode, time, disabled, onChange }: {
  mode: SendMode; time: string; disabled: boolean; onChange: (mode: SendMode, time: string) => void;
}) {
  const id = useId(), date = new Date(time);
  const grace = undoGraceSeconds(mode);
  return <fieldset disabled={disabled}><legend>发送安排</legend>
    <Field label="发送方式"><Select id={`${id}-mode`} value={mode} onChange={e => onChange(e.target.value as SendMode, time)}>
      <option value="direct">立即发送</option>
      <option value="undo-5s">防误发撤回缓冲（5 秒）</option>
      <option value="undo-10s">防误发撤回缓冲（10 秒）</option>
      <option value="undo-20s">防误发撤回缓冲（20 秒）</option>
      <option value="queued">后台排队</option>
      <option value="scheduled">定时发送</option>
    </Select></Field>
    {mode === "scheduled" && <><Field label="计划发送时间">
      <Input id={`${id}-time`} type="datetime-local" value={time} required onChange={e => onChange(mode, e.target.value)} /></Field>
      {Number.isFinite(date.getTime()) && <small>{date.toLocaleString()} · UTC {date.toISOString()}</small>}</>}
    {grace !== null && <p>已开启 {grace} 秒零网络真撤回缓冲：倒计时结束前可随时一键撤回并恢复草稿编辑，不产生外部发信请求。</p>}
    {mode !== "direct" && grace === null && <p>页面关闭后任务继续。到期后由后台处理，不保证准点；仅预约前可取消，附件有效期不会延长。</p>}
  </fieldset>;
}
