import { useId } from "react";

export type SendMode = "direct" | "queued" | "scheduled";
export function scheduledValue(mode: SendMode, localTime: string): number | null | undefined {
  if (mode === "direct") return undefined;
  if (mode === "queued") return null;
  const time = new Date(localTime).getTime(), now = Date.now();
  if (!Number.isFinite(time) || time <= now || time > now + 30 * 86400000) throw new Error("请选择未来 30 天内的计划发送时间");
  return Math.floor(time / 1000);
}
export function SendSchedule({ mode, time, disabled, onChange }: {
  mode: SendMode; time: string; disabled: boolean; onChange: (mode: SendMode, time: string) => void;
}) {
  const id = useId(), date = new Date(time);
  return <fieldset disabled={disabled}><legend>发送安排</legend>
    <label htmlFor={`${id}-mode`}>发送方式</label><select id={`${id}-mode`} value={mode} onChange={e => onChange(e.target.value as SendMode, time)}>
      <option value="direct">立即发送</option><option value="queued">后台排队</option><option value="scheduled">定时发送</option>
    </select>
    {mode === "scheduled" && <><label htmlFor={`${id}-time`}>计划发送时间</label>
      <input id={`${id}-time`} type="datetime-local" value={time} required onChange={e => onChange(mode, e.target.value)} />
      {Number.isFinite(date.getTime()) && <small>{date.toLocaleString()} · UTC {date.toISOString()}</small>}</>}
    {mode !== "direct" && <p>页面关闭后任务继续。到期后由后台处理，不保证准点；仅预约前可取消，附件有效期不会延长。</p>}
  </fieldset>;
}
