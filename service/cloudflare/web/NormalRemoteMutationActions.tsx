import { useEffect, useState } from "react";
import { dateText } from "./api";
import type { NormalMail } from "./normal-inbox";
import { useNormalRemoteFlags } from "./NormalRemoteFlags";
import { useNormalRemoteMutations } from "./NormalRemoteMutations";
import type { NormalMutationRecord } from "./useNormalMutationRecord";
import { useNormalMutationDestination } from "./useNormalMutationDestination";

export function NormalRemoteMutationActions({ message, record, disabled }: { message: NormalMail; record: NormalMutationRecord; disabled: boolean }) {
  const action = useNormalRemoteMutations(), flags = useNormalRemoteFlags(), target = useNormalMutationDestination(message);
  const [moveConfirmed, setMoveConfirmed] = useState(false), [deleteConfirmed, setDeleteConfirmed] = useState(false);
  useEffect(() => { setMoveConfirmed(false); }, [target.id, target.epochId, action.revision]);
  useEffect(() => { setDeleteConfirmed(false); }, [action.revision]);
  const locked = disabled || record.locked || flags.locked, operation = record.operation;
  return <section aria-label="服务器邮件移动与删除"><h5>服务器邮件移动与删除</h5>
    {record.error && <p role="alert">{record.error}</p>}{record.reading && <p role="status">读取服务器移动／删除记录…</p>}
    {operation && <><p>原请求 <code>{operation.requestKey}</code> · {operation.action === "move" ? "移动" : "永久删除"}</p>
      {operation.state === "pending" && <p role="status">原操作仍在处理中，不会另起请求</p>}
      {operation.state === "unknown" && <p role="alert">原移动／删除结果未知，禁止重试；请到服务器核对，平台缓存仍可阅读。</p>}
      {operation.state === "confirmed" && <p role="status">源邮件移除已确认：{dateText(operation.finishedAt)}；平台缓存保留，目标目录须显式同步。</p>}
      {operation.state === "failed" && <p role="status">原操作未派发</p>}
      {operation.phase && <p>已记录阶段：{operation.phase}{operation.destination ? ` · 目标 UID ${operation.destination.uid} / UIDVALIDITY ${operation.destination.uidValidity}` : ""}</p>}</>}
    <button className="secondary" disabled={record.reading || action.locked} onClick={record.refresh}>只读刷新移动／删除记录</button>
    <div className="row"><button className="secondary" disabled={locked || target.reading} onClick={target.open}>选择服务器移动目标</button></div>
    {target.opened && <><label>服务器移动目标<select value={target.id} disabled={locked || target.reading} onChange={event => { setMoveConfirmed(false); target.select(event.target.value); }}>
      <option value="">请选择目标目录</option>{target.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
      {target.reading && <p role="status">只读检查目标目录缓存…</p>}{target.error && <p role="alert">{target.error}</p>}
      <label><input type="checkbox" checked={moveConfirmed} disabled={locked || target.reading || !target.epochId}
        onChange={event => setMoveConfirmed(event.target.checked)} />确认从 {message.serverFolderName || "INBOX"} 移动到 {target.folder?.name || "所选目标"}，会改变服务器邮件，平台缓存保留</label>
      <button disabled={locked || target.reading || !target.folder || !target.epochId || !moveConfirmed} onClick={() => {
        if (!target.folder || !target.epochId || !moveConfirmed || locked) return;
        setMoveConfirmed(false); void action.submit(message, { expectedRevision: message.accountRevision, epochId: message.epochId, action: "move",
          destinationFolderId: target.folder.id, destinationEpochId: target.epochId, confirmRemoteChange: true }, target.folder.name);
      }}>移动服务器邮件</button></>}
    <label><input type="checkbox" checked={deleteConfirmed} disabled={locked} onChange={event => setDeleteConfirmed(event.target.checked)}
      />确认永久删除服务器邮件，无法撤销；这不是平台回收站操作</label>
    <button disabled={locked || !deleteConfirmed} onClick={() => {
      if (!deleteConfirmed || locked) return; setDeleteConfirmed(false);
      void action.submit(message, { expectedRevision: message.accountRevision, epochId: message.epochId, action: "delete", confirmPermanentDelete: true });
    }}>永久删除服务器邮件</button>
  </section>;
}
