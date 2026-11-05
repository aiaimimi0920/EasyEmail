import { Button, Field, Select } from '@neuro/ui';
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
      <Button disabled={blocked} onClick={selectPage} variant="quiet" wrap>选择当前页邮件</Button>
      <Button disabled={blocked || !ids.length} onClick={clear} variant="quiet" wrap>清空选择</Button></div>
    <fieldset disabled={blocked || !ids.length}>
      <div className="row">
        <Button onClick={() => action.submit(ids, { isRead: true })} wrap>批量标为已读</Button>
        <Button onClick={() => action.submit(ids, { isRead: false })} wrap>批量标为未读</Button>
        <Button onClick={() => action.submit(ids, { starred: true })} wrap>批量加星标</Button>
        <Button onClick={() => action.submit(ids, { starred: false })} wrap>批量取消星标</Button>
        <Button onClick={() => action.submit(ids, { archived: true })} wrap>批量归档</Button>
        <Button onClick={() => action.submit(ids, { archived: false })} wrap>批量移回收件箱</Button>
        <Button onClick={() => action.submit(ids, { trashed: true })} wrap>批量移到平台回收站</Button>
        <Button onClick={() => action.submit(ids, { trashed: false })} wrap>批量恢复平台邮件</Button>
      </div>
      <div className="row"><Field label="批量标签"><Select value={labelId} onChange={event => setLabelId(event.target.value)}>
        <option value="">请选择标签</option>{labels.map(label => <option key={label.id} value={label.id}>{label.name}</option>)}</Select></Field>
        <Button disabled={!labels.some(label => label.id === labelId)} onClick={() => action.submit(ids, { addLabelIds: [labelId] })} wrap>批量添加标签</Button>
        <Button disabled={!labels.some(label => label.id === labelId)} onClick={() => action.submit(ids, { removeLabelIds: [labelId] })} wrap>批量移除标签</Button></div>
      <div className="row"><Field label="批量目标文件夹"><Select value={folderId} onChange={event => setFolderId(event.target.value)}>
        <option value="">默认收件箱</option>{folderOptions(folders).map(({ folder, path }) => <option key={folder.id} value={folder.id}>{path}</option>)}</Select></Field>
        <Button disabled={folderId !== "" && !folders.some(folder => folder.id === folderId)} onClick={() => action.submit(ids, { folderId: folderId || null })} wrap>批量移动位置</Button></div>
    </fieldset>
    <OrganizationStatus action={action} />
  </section>;
}
