import { useConfirmation } from "./Confirmation";
import { Button, Field, Input, Notice, Panel, Textarea } from '@neuro/ui';
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
  const confirm = useConfirmation([list.page, action.locked, visible, editing, name, email, note]);
  return <Panel className="card" aria-label="联系人管理"><h2>联系人</h2>
    <form onSubmit={save}><fieldset disabled={action.locked}>
      <Field label="联系人姓名"><Input value={name} maxLength={160} onChange={event => setName(event.target.value)} /></Field>
      <Field label="联系人邮箱"><Input value={email} maxLength={512} required onChange={event => setEmail(event.target.value)} /></Field>
      <Field label="联系人备注"><Textarea value={note} maxLength={2000} onChange={event => setNote(event.target.value)} /></Field>
      <div className="row"><Button type="submit" wrap>{editing ? "保存联系人修改" : "新增或更新联系人"}</Button>
        {editing && <Button type="button" onClick={() => edit(null)} variant="quiet" wrap>取消编辑联系人</Button>}</div>
    </fieldset></form>
    {action.error && <Notice role="alert" tone="danger">{action.error}</Notice>}
    {action.attempt && <p>联系人操作键：<code data-testid="contact-operation-key">{action.attempt.key}</code></p>}
    {action.locked && !action.pending && <Button onClick={() => action.submit()} wrap>核对并完成原联系人操作</Button>}
    <form className="row" onSubmit={event => { event.preventDefault(); list.search(query); }}>
      <Field label="搜索联系人"><Input value={query} maxLength={160} onChange={event => setQuery(event.target.value)} /></Field>
      <Button disabled={list.pending || action.locked} type="submit" wrap>搜索联系人</Button>
      <Button type="button" disabled={list.pending || action.locked} onClick={list.refresh} variant="quiet" wrap>刷新联系人</Button>
    </form>
    {list.error && <Notice role="alert" tone="danger">{list.error}</Notice>}
    <Notice role="status" tone="info">{list.pending ? "读取联系人…" : `已加载 ${list.page?.items.length ?? 0} 位联系人`}</Notice>
    <ul>{list.page?.items.map(contact => <li key={contact.id}><article>
      <strong>{contact.displayName}</strong><small>{contact.emailAddress}</small>{contact.note && <pre>{contact.note}</pre>}
      <small>版本 {contact.version}</small>
      <div className="row"><Button disabled={action.locked || list.pending} onClick={() => edit(contact)} variant="quiet" wrap>编辑联系人 {contact.displayName}</Button>
        <Button disabled={action.locked || list.pending} onClick={async () => {
          if ((await confirm(`删除联系人“${contact.displayName}”（${contact.emailAddress}）？不会删除邮件。`))) {
            void action.submit({ path: `/contacts/${contact.id}`, method: "DELETE", body: { expectedVersion: contact.version } });
          }
        }} variant="quiet" wrap>删除联系人 {contact.displayName}</Button></div>
    </article></li>)}</ul>
    {list.page?.nextCursor && <Button disabled={list.pending || action.locked} onClick={list.loadMore} wrap>加载更多联系人</Button>}
  </Panel>;
}
