import { useEffect, useId, useRef, useState } from "react";
import { api, dateText, errorMessage } from "./api";
import { OUTBOX_MAX_FILES, OUTBOX_TOTAL_BYTES, outboxPath, type OutboxAsset, type OutboxAttachment } from "./outbox-attachments";
import { useOutboxUpload } from "./useOutboxUpload";

interface Props {
  value: OutboxAttachment[]; disabled: boolean; supported: boolean;
  onChange: (value: OutboxAttachment[]) => void; onLock: (value: boolean) => void; onReady: (value: boolean) => void;
}
export function OutboxAttachments({ value, disabled, supported, onChange, onLock, onReady }: Props) {
  const id = useId(), generation = useRef(0);
  const [available, setAvailable] = useState<boolean | null>(null), [states, setStates] = useState<Record<string, string>>({});
  const [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const upload = useOutboxUpload(asset => { onChange([...value, asset]); }, onLock);
  const refs = value.map(item => `${item.id}:${item.version}`).join(",");
  const bytes = value.reduce((sum, item) => sum + item.size, 0);
  useEffect(() => {
    const current = ++generation.current; let timer: ReturnType<typeof setTimeout>;
    if (!value.length) { onReady(true); setStates({}); return; }
    onReady(false);
    Promise.all(value.map(item => api<{ attachment: OutboxAsset }>(outboxPath(item.id)).then(({ attachment }) => ({ item, attachment }))))
      .then(items => {
        if (current !== generation.current) return;
        const statuses = Object.fromEntries(items.map(({ item, attachment }) => [item.id,
          attachment.version !== item.version ? "unavailable" : attachment.state]));
        setStates(statuses); onReady(items.every(({ item, attachment }) => attachment.version === item.version && attachment.state === "ready"));
        const next = Math.min(...items.map(({ attachment }) => attachment.expiresAt * 1000));
        if (next > Date.now()) timer = setTimeout(() => setRefresh(old => old + 1), Math.min(next - Date.now() + 50, 2147483647));
      }).catch(failure => { if (current === generation.current) { setError(errorMessage(failure)); onReady(false); } });
    return () => { generation.current++; clearTimeout(timer); };
  }, [refs, refresh]);
  useEffect(() => {
    let active = true;
    api<{ policy: { available: boolean } }>("/outbox-attachments").then(({ policy }) => { if (active) setAvailable(policy.available); })
      .catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, []);
  return <fieldset disabled={disabled} aria-label="发送附件"><legend>发送附件</legend>
    <label htmlFor={id}>添加发送附件</label><input id={id} type="file" disabled={upload.hasJob || available !== true || value.length >= OUTBOX_MAX_FILES}
      onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
        if (bytes + file.size > OUTBOX_TOTAL_BYTES) { setError("单封附件总大小不能超过 3 MiB"); return; }
        setError(""); upload.start(file);
      }} />
    <small>每个文件 1 字节至 2 MiB，每封最多 5 个、合计 3 MiB；上传后保留 24 小时，保存草稿不续期。</small>
    {available === false && <p role="status">发送附件存储未配置</p>}
    {!!value.length && !supported && <p role="status">此发送通道不支持附件；保留原引用，不会去掉附件后发送。</p>}
    <ul>{value.map(item => <li key={item.id}><div><strong>{item.filename}</strong><small>{item.size} 字节 · 到期 {dateText(item.expiresAt)}</small>
      {states[item.id] && states[item.id] !== "ready" && <span role="status">附件不可用，请移除引用或重新上传</span>}</div>
      <button type="button" className="secondary" disabled={upload.hasJob} onClick={() => onChange(value.filter(row => row.id !== item.id))}>移除引用</button></li>)}</ul>
    {!!value.length && <button type="button" className="secondary" disabled={upload.hasJob} onClick={() => { setError(""); setRefresh(old => old + 1); }}>核对附件状态</button>}
    {upload.hasJob && <div><p role="status">{upload.pending ? "附件上传处理中" : "上传待确认，请核对原上传"} · {upload.filename}</p>
      <button type="button" disabled={upload.pending} onClick={() => void upload.check()}>核对原上传</button>
      <button type="button" disabled={upload.pending} onClick={() => void upload.retry()}>继续原上传</button>
      <button type="button" className="secondary" disabled={upload.pending} onClick={() => void upload.discard()}>取消原上传</button></div>}
    {(error || upload.error) && <p role="alert">{error || upload.error}</p>}
  </fieldset>;
}
