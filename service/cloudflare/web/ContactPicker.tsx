import { Button, Field, Input, Notice, Select } from '@neuro/ui';
import { useState } from "react";
import { useContacts } from "./useContacts";
import type { RecipientTarget } from "./compose-recipients";

export function ContactPicker({ visible, disabled, onPick }: { visible: boolean; disabled: boolean; onPick: (address: string, target: RecipientTarget, append: boolean) => void }) {
  const [opened, setOpened] = useState(false), [query, setQuery] = useState(""), [selected, setSelected] = useState("");
  const [target, setTarget] = useState<RecipientTarget>("to");
  const list = useContacts(visible && opened), contact = list.page?.items.find(item => item.id === selected);
  return <section aria-label="写信联系人">
    <Button type="button" disabled={disabled} onClick={() => { setOpened(value => !value); list.refresh(); }} variant="quiet" wrap>从联系人选择</Button>
    {opened && <>
      <form className="row" onSubmit={event => { event.preventDefault(); setSelected(""); list.search(query); }}>
        <Field label="查找收件联系人"><Input disabled={disabled} value={query} maxLength={160} onChange={event => setQuery(event.target.value)} /></Field>
        <Button disabled={disabled || list.pending} type="submit" wrap>查找收件联系人</Button>
      </form>
      <div className="row"><Field label="收件联系人"><Select disabled={disabled || list.pending} value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="">请选择联系人</option>{list.page?.items.map(item => <option key={item.id} value={item.id}>{item.displayName} · {item.emailAddress}</option>)}</Select></Field>
        <Field label="联系人目标"><Select aria-label="联系人目标" disabled={disabled} value={target} onChange={event => setTarget(event.target.value as RecipientTarget)}>
          <option value="to">收件地址</option><option value="cc">抄送地址</option><option value="bcc">密送地址</option></Select></Field>
        <Button type="button" disabled={disabled || list.pending || !contact} onClick={() => { if (contact && !disabled) onPick(contact.emailAddress, target, false); }} wrap>使用此收件地址</Button>
        <Button type="button" disabled={disabled || list.pending || !contact} onClick={() => { if (contact && !disabled) onPick(contact.emailAddress, target, true); }} wrap>追加此地址</Button></div>
      {list.error && <Notice role="alert" tone="danger">{list.error}</Notice>}
      {!list.pending && list.page?.items.length === 0 && <Notice role="status" tone="info">没有匹配的联系人</Notice>}
      {list.page?.nextCursor && <Button type="button" disabled={disabled || list.pending} onClick={list.loadMore} wrap>加载更多收件联系人</Button>}
    </>}
  </section>;
}
