import { Button, Notice } from '@neuro/ui';
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import type { SendJob } from "./send-jobs";

export function UndoSendBanner({ job, basePath = "/send-jobs", onUndone, onStatusError }: {
  job: SendJob | null;
  basePath?: string;
  onUndone(cancelledJob: SendJob): void;
  onStatusError?(msg: string): void;
}) {
  const [remainingSec, setRemainingSec] = useState<number>(0);
  const [cancelling, setCancelling] = useState(false);
  const cancelKeyRef = useRef<string>("");

  useEffect(() => {
    if (!job || !job.cancellable || job.state !== "queued") {
      setRemainingSec(0);
      cancelKeyRef.current = "";
      return;
    }
    const updateRemaining = () => {
      const diff = Math.max(0, job.dueAt - Math.floor(Date.now() / 1000));
      setRemainingSec(diff);
    };
    updateRemaining();
    const timer = window.setInterval(updateRemaining, 500);
    return () => window.clearInterval(timer);
  }, [job]);

  if (!job || !job.cancellable || job.state !== "queued" || remainingSec <= 0 || remainingSec > 60) {
    return null;
  }

  async function undoNow() {
    if (!job || cancelling) return;
    setCancelling(true);
    if (!cancelKeyRef.current) cancelKeyRef.current = crypto.randomUUID();
    try {
      const res = await api<{ job: SendJob }>(
        `${basePath}/${job.id}/cancel`,
        "POST",
        { expectedRevision: job.revision },
        { "idempotency-key": cancelKeyRef.current },
      );
      cancelKeyRef.current = "";
      onUndone(res.job);
    } catch (err) {
      onStatusError?.(errorMessage(err));
    } finally {
      setCancelling(false);
    }
  }

  return <div className="row" role="region" aria-label="撤回发送缓冲">
    <Notice role="status" tone="info">
      邮件将在 <strong>{remainingSec} 秒</strong>后进入派发队列（当前尚未向收件方发起任何网络投递）
    </Notice>
    <Button type="button" variant="primary" disabled={cancelling} onClick={() => void undoNow()} wrap>
      {cancelling ? "正在撤回…" : `撤回发送 (${remainingSec}s)`}
    </Button>
  </div>;
}
