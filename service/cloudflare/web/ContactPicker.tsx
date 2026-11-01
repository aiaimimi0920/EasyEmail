import { useState } from "react";
import { useContacts } from "./useContacts";
import type { RecipientTarget } from "./compose-recipients";

export function ContactPicker({ visible, disabled, onPick }: { visible: boolean; disabled: boolean; onPick: (address: string, target: RecipientTarget, append: boolean) => void }) {
  const [opened, setOpened] = useState(false), [query, setQuery] = useState(""), [selected, setSelected] = useState("");
  const [target, setTarget] = useState<RecipientTarget>("to");
  const list = useContacts(visible && opened), contact = list.page?.items.find(item => item.id === selected);
  return <section aria-label="写信联系人">
    <button type="button" className="secondary" disabled={disabled} onClick={() => { setOpened(value => !value); list.refresh(); }}>从联系人选择</button>
    {opened && <>
      <form className="row" onSubmit={event => { event.preventDefault(); setSelected(""); list.search(query); }}>
        <label>查找收件联系人<input disabled={disabled} value={query} maxLength={160} onChange={event => setQuery(event.target.value)} /></label>
        <button disabled={disabled || list.pending}>查找收件联系人</button>
      </form>
      <div className="row"><label>收件联系人<select disabled={disabled || list.pending} value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="">请选择联系人</option>{list.page?.items.map(item => <option key={item.id} value={item.id}>{item.displayName} · {item.emailAddress}</option>)}</select></label>
        <label>联系人目标<select aria-label="联系人目标" disabled={disabled} value={target} onChange={event => setTarget(event.target.value as RecipientTarget)}>
          <option value="to">收件地址</option><option value="cc">抄送地址</option><option value="bcc">密送地址</option></select></label>
        <button type="button" disabled={disabled || list.pending || !contact} onClick={() => { if (contact && !disabled) onPick(contact.emailAddress, target, false); }}>使用此收件地址</button>
        <button type="button" disabled={disabled || list.pending || !contact} onClick={() => { if (contact && !disabled) onPick(contact.emailAddress, target, true); }}>追加此地址</button></div>
      {list.error && <p role="alert">{list.error}</p>}
      {!list.pending && list.page?.items.length === 0 && <p role="status">没有匹配的联系人</p>}
      {list.page?.nextCursor && <button type="button" disabled={disabled || list.pending} onClick={list.loadMore}>加载更多收件联系人</button>}
    </>}
  </section>;
}
