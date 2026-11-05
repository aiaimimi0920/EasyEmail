import { useConfirmation } from "./Confirmation";
import { Button, Disclosure, Field, Input, Notice, Select } from '@neuro/ui';
import { useState, type FormEvent } from "react";
import { LABEL_COLORS } from "./labels-api";
import { folderOptions, type Folder } from "./folders-api";
import { useTaxonomyMutation } from "./useTaxonomyMutation";

export function FolderManager({ folders, onChanged, disabled }: { folders: Folder[]; onChanged: () => void; disabled: boolean }) {
  const [editing, setEditing] = useState<Folder | null>(null), [name, setName] = useState(""), [color, setColor] = useState("blue"), [parentId, setParentId] = useState("");
  const action = useTaxonomyMutation("/folders", () => { reset(null); onChanged(); });
  function reset(folder: Folder | null) {
    setEditing(folder); setName(folder?.name ?? ""); setColor(folder?.color ?? "blue"); setParentId(folder?.parentId ?? ""); action.clearError();
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void action.change({ id: editing?.id ?? crypto.randomUUID(), method: "PUT",
      body: { name, color, parentId: parentId || null, expectedRevision: editing?.revision ?? 0 } });
  }
  const blocked = disabled || action.pending || action.unresolved !== null;
  const confirm = useConfirmation([folders, blocked]);
  return <Disclosure title="管理文件夹">
    <form onSubmit={save}><fieldset disabled={blocked}>
      <div className="row"><Field label="文件夹名称"><Input value={name} maxLength={80} required onChange={event => setName(event.target.value)} /></Field>
        <Field label="父文件夹"><Select value={parentId} onChange={event => setParentId(event.target.value)}><option value="">根目录</option>
          {folderOptions(folders, editing?.id).map(item => <option key={item.folder.id} value={item.folder.id}>{item.path}</option>)}</Select></Field>
        <Field label="文件夹颜色"><Select value={color} onChange={event => setColor(event.target.value)}>{Object.entries(LABEL_COLORS).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</Select></Field>
        <Button type="submit" wrap>{editing ? "保存文件夹修改" : "创建文件夹"}</Button>{editing && <Button type="button" onClick={() => reset(null)} variant="quiet" wrap>取消编辑文件夹</Button>}</div>
    </fieldset></form>
    <ul>{folderOptions(folders).map(({ folder, path }) => <li key={folder.id}><span className={`label-chip label-${folder.color}`}>{path}</span>
      <div><Button disabled={blocked} onClick={() => reset(folder)} variant="quiet" wrap>编辑文件夹 {folder.name}</Button>
        <Button disabled={blocked} onClick={async () => {
          if ((await confirm(`删除文件夹“${folder.name}”？直属子文件夹移到根目录，其中邮件移回默认收件箱；回收站邮件仍保留在回收站。`))) {
            void action.change({ id: folder.id, method: "DELETE", body: { expectedRevision: folder.revision } });
          }
        }} variant="quiet" wrap>删除文件夹 {folder.name}</Button></div></li>)}</ul>
    {action.error && <Notice role="alert" tone="danger">{action.error}</Notice>}
    {action.unresolved && !action.pending && <Button onClick={() => action.change(action.unresolved!)} wrap>核对原文件夹操作</Button>}
  </Disclosure>;
}
