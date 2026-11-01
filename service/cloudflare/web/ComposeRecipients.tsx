import type { RecipientEditor } from "./compose-recipients";

export function ComposeRecipients({ ids, value, disabled, onChange }: {
  ids: string; value: RecipientEditor; disabled: boolean; onChange: (value: Partial<RecipientEditor>) => void;
}) {
  return <>{([ ["to", "收件地址"], ["cc", "抄送地址"], ["bcc", "密送地址"] ] as const).map(([key, label]) => <div key={key}>
    <label htmlFor={`${ids}-${key}`}>{label}</label>
    <input id={`${ids}-${key}`} type="email" multiple value={value[key] ?? ""} maxLength={12749}
      required={key === "to"} disabled={disabled} placeholder="多个地址用逗号分隔"
      onChange={event => onChange({ [key]: event.target.value })} />
  </div>)}</>;
}
