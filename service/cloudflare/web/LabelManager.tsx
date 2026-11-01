import { useState, type FormEvent } from "react";
import { LABEL_COLORS, type Label } from "./labels-api";
import { useTaxonomyMutation } from "./useTaxonomyMutation";

export function LabelManager({ labels, onChanged, disabled }: { labels: Label[]; onChanged: () => void; disabled: boolean }) {
  const [editing, setEditing] = useState<Label | null>(null), [name, setName] = useState(""), [color, setColor] = useState("blue");
  const action = useTaxonomyMutation("/labels", () => { setEditing(null); setName(""); setColor("blue"); onChanged(); });
  const { pending, unresolved, error, change } = action;
  function edit(label: Label | null) { setEditing(label); setName(label?.name ?? ""); setColor(label?.color ?? "blue"); action.clearError(); }
  function save(event: FormEvent) {
    event.preventDefault();
    void change({ id: editing?.id ?? crypto.randomUUID(), method: "PUT", body: { expectedRevision: editing?.revision ?? 0, name, color } });
  }
  const blocked = disabled || pending || unresolved !== null;
  return <details><summary>管理标签</summary>
    <form onSubmit={save}><fieldset disabled={blocked}>
      <div className="row"><label>标签名称<input value={name} maxLength={80} required onChange={event => setName(event.target.value)} /></label>
        <label>标签颜色<select value={color} onChange={event => setColor(event.target.value)}>{Object.entries(LABEL_COLORS).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
        <button>{editing ? "保存标签修改" : "创建标签"}</button>{editing && <button type="button" className="secondary" onClick={() => edit(null)}>取消编辑标签</button>}</div>
    </fieldset></form>
    <ul>{labels.map(label => <li key={label.id}><span className={`label-chip label-${label.color}`}>{label.name}</span>
      <div><button className="secondary" disabled={blocked} onClick={() => edit(label)}>编辑标签 {label.name}</button>
        <button className="secondary" disabled={blocked} onClick={() => {
          if (window.confirm(`删除标签“${label.name}”并从所有邮件移除此标签？邮件本身不会删除。`)) void change({ id: label.id, method: "DELETE", body: { expectedRevision: label.revision } });
        }}>删除标签 {label.name}</button></div></li>)}</ul>
    {error && <p role="alert">{error}</p>}
    {unresolved && !pending && <button onClick={() => change(unresolved)}>核对原标签操作</button>}
  </details>;
}
