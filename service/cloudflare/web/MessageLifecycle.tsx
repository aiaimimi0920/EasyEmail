import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";

export function MessageLifecycle({ path, id, trashed, onRemoved }: {
  path: string; id: string; trashed: boolean; onRemoved: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false), busy = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function change(action: "trash" | "restore" | "purge") {
    if (busy.current) return;
    if (action === "trash" && !window.confirm("移到平台回收站？不会删除上游邮件。")) return;
    if (action === "purge" && !window.confirm("永久清除此邮件的平台正文与附件元数据？无法恢复；不会删除上游邮件或发送记录。")) return;
    busy.current = true; setPending(true); setError("");
    try {
      await api(action === "trash" ? path : `${path}/${action}`, action === "trash" ? "DELETE" : "POST",
        action === "purge" ? { confirmMessageId: id } : action === "restore" ? {} : undefined);
      if (active.current) onRemoved();
    } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  return <section aria-label="邮件生命周期">
    <div className="row">{trashed ? <>
      <button className="secondary" disabled={pending} onClick={() => change("restore")}>恢复平台邮件</button>
      <button className="secondary" disabled={pending} onClick={() => change("purge")}>永久清除平台缓存</button>
    </> : <button className="secondary" disabled={pending} onClick={() => change("trash")}>移到平台回收站</button>}</div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
