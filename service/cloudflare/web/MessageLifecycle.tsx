import { useConfirmation } from "./Confirmation";
import { Button, Notice } from '@neuro/ui';
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
    if (action === "trash" && !(await confirm("移到平台回收站？不会删除上游邮件。"))) return;
    if (action === "purge" && !(await confirm("永久清除此邮件的平台正文与附件元数据？无法恢复；不会删除上游邮件或发送记录。"))) return;
    if (!active.current || busy.current) return;
    busy.current = true; setPending(true); setError("");
    try {
      await api(action === "trash" ? path : `${path}/${action}`, action === "trash" ? "DELETE" : "POST",
        action === "purge" ? { confirmMessageId: id } : action === "restore" ? {} : undefined);
      if (active.current) onRemoved();
    } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  const confirm = useConfirmation([path, id, trashed, pending]);
  return <section aria-label="邮件生命周期">
    <div className="row">{trashed ? <>
      <Button disabled={pending} onClick={() => change("restore")} variant="quiet" wrap>恢复平台邮件</Button>
      <Button disabled={pending} onClick={() => change("purge")} variant="quiet" wrap>永久清除平台缓存</Button>
    </> : <Button disabled={pending} onClick={() => change("trash")} variant="quiet" wrap>移到平台回收站</Button>}</div>
    {error && <Notice role="alert" tone="danger">{error}</Notice>}
  </section>;
}
