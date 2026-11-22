import { useConfirmation } from "./Confirmation";
import { Button, Disclosure, Field, Input, Notice, Select } from '@neuro/ui';
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
  const confirm = useConfirmation([labels, blocked]);
  return <Disclosure title="管理标签">
    <form onSubmit={save}><fieldset disabled={blocked}>
      <div className="row"><Field label="标签名称"><Input value={name} maxLength={80} required onChange={event => setName(event.target.value)} /></Field>
        <Field label="标签颜色"><Select value={color} onChange={event => setColor(event.target.value)}>{Object.entries(LABEL_COLORS).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</Select></Field>
        <Button type="submit" wrap>{editing ? "保存标签修改" : "创建标签"}</Button>{editing && <Button type="button" onClick={() => edit(null)} variant="quiet" wrap>取消编辑标签</Button>}</div>
    </fieldset></form>
    <ul>{labels.map(label => <li key={label.id}><span className={`label-chip label-${label.color}`}>{label.name}</span>
      <div><Button disabled={blocked} onClick={() => edit(label)} variant="quiet" wrap>编辑标签 {label.name}</Button>
        <Button disabled={blocked} onClick={async () => {
          if ((await confirm(`删除标签“${label.name}”并从所有邮件移除此标签？邮件本身不会删除。`))) void change({ id: label.id, method: "DELETE", body: { expectedRevision: label.revision } });
        }} variant="quiet" wrap>删除标签 {label.name}</Button></div></li>)}</ul>
    {error && <Notice role="alert" tone="danger">{error}</Notice>}
    {unresolved && !pending && <Button onClick={() => change(unresolved)} wrap>核对原标签操作</Button>}
  </Disclosure>;
}
