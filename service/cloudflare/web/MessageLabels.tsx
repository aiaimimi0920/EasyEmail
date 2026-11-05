import { Button, Field, Notice, Select } from '@neuro/ui';
import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { loadLabels, type Label, type TaxonomyController } from "./labels-api";
import { useOrganization } from "./useOrganization";
import { OrganizationStatus } from "./OrganizationStatus";

export function MessageLabels({ path, id, onChanged, controller }: { path: string; id: string; onChanged?: () => void; controller?: TaxonomyController }) {
  const [labels, setLabels] = useState<Label[]>([]), [attached, setAttached] = useState<Label[]>([]), [labelId, setLabelId] = useState("");
  const [error, setError] = useState(""), [revision, setRevision] = useState(0), [pending, setPending] = useState(true);
  const fallback = useOrganization(() => { setRevision(value => value + 1); onChanged?.(); }), action = controller ?? fallback;
  useEffect(() => {
    let active = true; setPending(true); setError("");
    Promise.all([loadLabels(), api<{ items: Label[] }>(`${path}/labels`)]).then(([all, current]) => {
      if (active) { setLabels(all.items); setAttached(current.items); }
    }).catch(failure => { if (active) setError(errorMessage(failure)); }).finally(() => { if (active) setPending(false); });
    return () => { active = false; };
  }, [path, revision, controller?.revision]);
  return <section aria-label="邮件标签"><h4>邮件标签</h4>
    <div className="row">{attached.map(label => <span key={label.id} className={`label-chip label-${label.color}`}>{label.name}
      <Button disabled={pending || action.locked} onClick={() => action.submit([id], { removeLabelIds: [label.id] })} variant="quiet" wrap>移除标签 {label.name}</Button></span>)}</div>
    <div className="row"><Field label="添加邮件标签"><Select disabled={pending || action.locked} value={labelId} onChange={event => setLabelId(event.target.value)}>
      <option value="">请选择标签</option>{labels.filter(label => !attached.some(item => item.id === label.id)).map(label => <option key={label.id} value={label.id}>{label.name}</option>)}</Select></Field>
      <Button disabled={pending || action.locked || !labels.some(label => label.id === labelId) || attached.some(label => label.id === labelId)} onClick={() => action.submit([id], { addLabelIds: [labelId] })} wrap>添加到此邮件</Button></div>
    {error && <Notice role="alert" tone="danger">{error}</Notice>}{!controller && <OrganizationStatus action={fallback} />}
  </section>;
}
