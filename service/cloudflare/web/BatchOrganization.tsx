import { useState } from "react";
import type { Label } from "./labels-api";
import type { OrganizationController } from "./useOrganization";
import { OrganizationStatus } from "./OrganizationStatus";
import { folderOptions, type Folder } from "./folders-api";

export function BatchOrganization({ ids, labels, folders, action, disabled, selectPage, clear }: {
  ids: string[]; labels: Label[]; folders: Folder[]; action: OrganizationController; disabled: boolean; selectPage: () => void; clear: () => void;
}) {
  const [labelId, setLabelId] = useState("");
  const [folderId, setFolderId] = useState("");
  const blocked = disabled || action.locked;
  return <section aria-label="批量整理">
    <div className="row"><span role="status">已选择 {ids.length} 封（最多 50 封）</span>
      <button className="secondary" disabled={blocked} onClick={selectPage}>选择当前页邮件</button>
      <button className="secondary" disabled={blocked || !ids.length} onClick={clear}>清空选择</button></div>
    <fieldset disabled={blocked || !ids.length}>
      <div className="row">
        <button onClick={() => action.submit(ids, { isRead: true })}>批量标为已读</button>
        <button onClick={() => action.submit(ids, { isRead: false })}>批量标为未读</button>
        <button onClick={() => action.submit(ids, { starred: true })}>批量加星标</button>
        <button onClick={() => action.submit(ids, { starred: false })}>批量取消星标</button>
        <button onClick={() => action.submit(ids, { archived: true })}>批量归档</button>
        <button onClick={() => action.submit(ids, { archived: false })}>批量移回收件箱</button>
        <button onClick={() => action.submit(ids, { trashed: true })}>批量移到平台回收站</button>
        <button onClick={() => action.submit(ids, { trashed: false })}>批量恢复平台邮件</button>
      </div>
      <div className="row"><label>批量标签<select value={labelId} onChange={event => setLabelId(event.target.value)}>
        <option value="">请选择标签</option>{labels.map(label => <option key={label.id} value={label.id}>{label.name}</option>)}</select></label>
        <button disabled={!labels.some(label => label.id === labelId)} onClick={() => action.submit(ids, { addLabelIds: [labelId] })}>批量添加标签</button>
        <button disabled={!labels.some(label => label.id === labelId)} onClick={() => action.submit(ids, { removeLabelIds: [labelId] })}>批量移除标签</button></div>
      <div className="row"><label>批量目标文件夹<select value={folderId} onChange={event => setFolderId(event.target.value)}>
        <option value="">默认收件箱</option>{folderOptions(folders).map(({ folder, path }) => <option key={folder.id} value={folder.id}>{path}</option>)}</select></label>
        <button disabled={folderId !== "" && !folders.some(folder => folder.id === folderId)} onClick={() => action.submit(ids, { folderId: folderId || null })}>批量移动位置</button></div>
    </fieldset>
    <OrganizationStatus action={action} />
  </section>;
}
