import { useEffect, useState } from "react";
import { dateText, errorMessage } from "./api";
import type { NormalMail } from "./normal-inbox";
import { latestRemoteFlag, type RemoteFlagOperation } from "./normal-remote-flags";
import { useNormalRemoteFlags } from "./NormalRemoteFlags";

export function NormalRemoteFlagActions({ message, disabled }: { message: NormalMail; disabled: boolean }) {
  const action = useNormalRemoteFlags(), [operation, setOperation] = useState<RemoteFlagOperation | null>(null);
  const [reading, setReading] = useState(true), [error, setError] = useState(""), [acknowledged, setAcknowledged] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setReading(true); setError(""); setOperation(null); setAcknowledged(false);
    latestRemoteFlag(message, controller.signal).then(row => { if (!controller.signal.aborted) setOperation(row); })
      .catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [message.accountId, message.id, message.serverFolderId, message.epochId, message.accountRevision, action.revision, refresh]);
  const unknown = operation?.state === "unknown", pending = operation?.state === "pending";
  const locked = disabled || action.locked || reading || !!error || pending || (unknown && !acknowledged);
  const seen = message.remoteFlags.some(flag => flag.toLowerCase() === "\\seen"), starred = message.remoteFlags.some(flag => flag.toLowerCase() === "\\flagged");
  return <section aria-label="服务器邮件标记"><p>服务器缓存：{seen ? "已读" : "未读"} · {starred ? "星标" : "无星标"}</p>
    {error && <p role="alert">{error}</p>}{reading && <p role="status">读取远端操作记录…</p>}
    {pending && <p role="status">原服务器标记操作处理中；不会另起请求</p>}
    {unknown && <><p role="alert">原操作结果未知；新操作不能撤回旧命令，可能与其他客户端的修改交错。</p>
      <label><input type="checkbox" checked={acknowledged} disabled={action.locked || reading} onChange={event => setAcknowledged(event.target.checked)} />我已核对服务器状态，知悉原操作结果仍未知</label></>}
    {operation?.state === "confirmed" && <p role="status">服务器标记核对时间：{dateText(operation.finishedAt)}（不保证此后未被其他客户端更改）</p>}
    <div className="row"><button className="secondary" disabled={locked} onClick={() => void action.submit(message, "\\Seen", !seen, unknown ? operation!.id : null)}>
      {seen ? "服务器标为未读" : "服务器标为已读"}</button>
      <button className="secondary" disabled={locked} onClick={() => void action.submit(message, "\\Flagged", !starred, unknown ? operation!.id : null)}>
        {starred ? "服务器取消星标" : "服务器加星标"}</button>
      <button className="secondary" disabled={reading || action.locked} onClick={() => setRefresh(value => value + 1)}>只读刷新远端操作记录</button></div>
  </section>;
}
