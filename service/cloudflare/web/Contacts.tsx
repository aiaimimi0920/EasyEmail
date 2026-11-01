import { useState, type FormEvent } from "react";
import type { Contact } from "./contacts-api";
import { useContacts } from "./useContacts";
import { useContactMutation } from "./useContactMutation";

export function Contacts({ visible }: { visible: boolean }) {
  const list = useContacts(visible), [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Contact | null>(null), [name, setName] = useState(""), [email, setEmail] = useState(""), [note, setNote] = useState("");
  const action = useContactMutation(() => { edit(null); list.refresh(); });
  function edit(contact: Contact | null) { setEditing(contact); setName(contact?.displayName ?? ""); setEmail(contact?.emailAddress ?? ""); setNote(contact?.note ?? ""); }
  function save(event: FormEvent) {
    event.preventDefault();
    void action.submit({ path: editing ? `/contacts/${editing.id}` : "/contacts", method: editing ? "PATCH" : "POST",
      body: { displayName: name, emailAddress: email, note, ...(editing ? { expectedVersion: editing.version } : {}) } });
  }
  return <section className="card" aria-label="联系人管理"><h2>联系人</h2>
    <form onSubmit={save}><fieldset disabled={action.locked}>
      <label>联系人姓名<input value={name} maxLength={160} onChange={event => setName(event.target.value)} /></label>
      <label>联系人邮箱<input value={email} maxLength={512} required onChange={event => setEmail(event.target.value)} /></label>
      <label>联系人备注<textarea value={note} maxLength={2000} onChange={event => setNote(event.target.value)} /></label>
      <div className="row"><button>{editing ? "保存联系人修改" : "新增或更新联系人"}</button>
        {editing && <button type="button" className="secondary" onClick={() => edit(null)}>取消编辑联系人</button>}</div>
    </fieldset></form>
    {action.error && <p role="alert">{action.error}</p>}
    {action.attempt && <p>联系人操作键：<code data-testid="contact-operation-key">{action.attempt.key}</code></p>}
    {action.locked && !action.pending && <button onClick={() => action.submit()}>核对并完成原联系人操作</button>}
    <form className="row" onSubmit={event => { event.preventDefault(); list.search(query); }}>
      <label>搜索联系人<input value={query} maxLength={160} onChange={event => setQuery(event.target.value)} /></label>
      <button disabled={list.pending || action.locked}>搜索联系人</button>
      <button type="button" className="secondary" disabled={list.pending || action.locked} onClick={list.refresh}>刷新联系人</button>
    </form>
    {list.error && <p role="alert">{list.error}</p>}
    <p role="status">{list.pending ? "读取联系人…" : `已加载 ${list.page?.items.length ?? 0} 位联系人`}</p>
    <ul>{list.page?.items.map(contact => <li key={contact.id}><article>
      <strong>{contact.displayName}</strong><small>{contact.emailAddress}</small>{contact.note && <pre>{contact.note}</pre>}
      <small>版本 {contact.version}</small>
      <div className="row"><button className="secondary" disabled={action.locked || list.pending} onClick={() => edit(contact)}>编辑联系人 {contact.displayName}</button>
        <button className="secondary" disabled={action.locked || list.pending} onClick={() => {
          if (window.confirm(`删除联系人“${contact.displayName}”（${contact.emailAddress}）？不会删除邮件。`)) {
            void action.submit({ path: `/contacts/${contact.id}`, method: "DELETE", body: { expectedVersion: contact.version } });
          }
        }}>删除联系人 {contact.displayName}</button></div>
    </article></li>)}</ul>
    {list.page?.nextCursor && <button disabled={list.pending || action.locked} onClick={list.loadMore}>加载更多联系人</button>}
  </section>;
}
