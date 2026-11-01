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
  return <details><summary>管理文件夹</summary>
    <form onSubmit={save}><fieldset disabled={blocked}>
      <div className="row"><label>文件夹名称<input value={name} maxLength={80} required onChange={event => setName(event.target.value)} /></label>
        <label>父文件夹<select value={parentId} onChange={event => setParentId(event.target.value)}><option value="">根目录</option>
          {folderOptions(folders, editing?.id).map(item => <option key={item.folder.id} value={item.folder.id}>{item.path}</option>)}</select></label>
        <label>文件夹颜色<select value={color} onChange={event => setColor(event.target.value)}>{Object.entries(LABEL_COLORS).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
        <button>{editing ? "保存文件夹修改" : "创建文件夹"}</button>{editing && <button type="button" className="secondary" onClick={() => reset(null)}>取消编辑文件夹</button>}</div>
    </fieldset></form>
    <ul>{folderOptions(folders).map(({ folder, path }) => <li key={folder.id}><span className={`label-chip label-${folder.color}`}>{path}</span>
      <div><button className="secondary" disabled={blocked} onClick={() => reset(folder)}>编辑文件夹 {folder.name}</button>
        <button className="secondary" disabled={blocked} onClick={() => {
          if (window.confirm(`删除文件夹“${folder.name}”？直属子文件夹移到根目录，其中邮件移回默认收件箱；回收站邮件仍保留在回收站。`)) {
            void action.change({ id: folder.id, method: "DELETE", body: { expectedRevision: folder.revision } });
          }
        }}>删除文件夹 {folder.name}</button></div></li>)}</ul>
    {action.error && <p role="alert">{action.error}</p>}
    {action.unresolved && !action.pending && <button onClick={() => action.change(action.unresolved!)}>核对原文件夹操作</button>}
  </details>;
}
