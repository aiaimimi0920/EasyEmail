import { Button, Checkbox, Field, Notice, Select } from '@neuro/ui';
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
    {record.error && <Notice role="alert" tone="danger">{record.error}</Notice>}{record.reading && <Notice role="status" tone="info">读取服务器移动／删除记录…</Notice>}
    {operation && <><p>原请求 <code>{operation.requestKey}</code> · {operation.action === "move" ? "移动" : "永久删除"}</p>
      {operation.state === "pending" && <Notice role="status" tone="info">原操作仍在处理中，不会另起请求</Notice>}
      {operation.state === "unknown" && <Notice role="alert" tone="danger">原移动／删除结果未知，禁止重试；请到服务器核对，平台缓存仍可阅读。</Notice>}
      {operation.state === "confirmed" && <Notice role="status" tone="info">源邮件移除已确认：{dateText(operation.finishedAt)}；平台缓存保留，目标目录须显式同步。</Notice>}
      {operation.state === "failed" && <Notice role="status" tone="info">原操作未派发</Notice>}
      {operation.phase && <p>已记录阶段：{operation.phase}{operation.destination ? ` · 目标 UID ${operation.destination.uid} / UIDVALIDITY ${operation.destination.uidValidity}` : ""}</p>}</>}
    <Button disabled={record.reading || action.locked} onClick={record.refresh} variant="quiet" wrap>只读刷新移动／删除记录</Button>
    <div className="row"><Button disabled={locked || target.reading} onClick={target.open} variant="quiet" wrap>选择服务器移动目标</Button></div>
    {target.opened && <><Field label="服务器移动目标"><Select value={target.id} disabled={locked || target.reading} onChange={event => { setMoveConfirmed(false); target.select(event.target.value); }}>
      <option value="">请选择目标目录</option>{target.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</Select></Field>
      {target.reading && <Notice role="status" tone="info">只读检查目标目录缓存…</Notice>}{target.error && <Notice role="alert" tone="danger">{target.error}</Notice>}
      <Checkbox checked={moveConfirmed} disabled={locked || target.reading || !target.epochId} onChange={event => setMoveConfirmed(event.target.checked)} label={<>确认从 {message.serverFolderName || "INBOX"}移动到 {target.folder?.name || "所选目标"}，会改变服务器邮件，平台缓存保留</>} />
      <Button disabled={locked || target.reading || !target.folder || !target.epochId || !moveConfirmed} onClick={() => {
        if (!target.folder || !target.epochId || !moveConfirmed || locked) return;
        setMoveConfirmed(false); void action.submit(message, { expectedRevision: message.accountRevision, epochId: message.epochId, action: "move",
          destinationFolderId: target.folder.id, destinationEpochId: target.epochId, confirmRemoteChange: true }, target.folder.name);
      }} wrap>移动服务器邮件</Button></>}
    <Checkbox checked={deleteConfirmed} disabled={locked} onChange={event => setDeleteConfirmed(event.target.checked)} label="确认永久删除服务器邮件，无法撤销；这不是平台回收站操作" />
    <Button disabled={locked || !deleteConfirmed} onClick={() => {
      if (!deleteConfirmed || locked) return; setDeleteConfirmed(false);
      void action.submit(message, { expectedRevision: message.accountRevision, epochId: message.epochId, action: "delete", confirmPermanentDelete: true });
    }} wrap>永久删除服务器邮件</Button>
  </section>;
}
