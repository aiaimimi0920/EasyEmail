import { Button, Field, Input, Notice } from '@neuro/ui';
import { useRef, useState, type FormEvent } from "react";

export function MailboxMessageSearch({ disabled, onSearch }: { disabled: boolean; onSearch: (query: string) => void }) {
  const form = useRef<HTMLFormElement>(null), [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const values = new FormData(event.currentTarget), params = new URLSearchParams();
    for (const key of ["q", "sender", "since", "until"]) {
      const value = String(values.get(key) ?? "").trim();
      if (!value) continue;
      if (key === "since" || key === "until") {
        const seconds = Math.floor(new Date(value).getTime() / 1000);
        if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 99999999999) { setError("收件时间范围无效"); return; }
        params.set(key, String(seconds));
      } else params.set(key, value);
    }
    if (params.has("since") && params.has("until") && Number(params.get("since")) > Number(params.get("until"))) {
      setError("收件时间范围无效"); return;
    }
    setError(""); onSearch(params.toString());
  }

  return <form ref={form} aria-label="单邮箱邮件搜索" onSubmit={search}>
    <fieldset disabled={disabled}>
      <div className="row"><Field label="搜索当前邮箱邮件"><Input name="q" type="search" maxLength={256} /></Field></div>
      <div className="row"><Button type="submit" wrap>搜索当前邮箱</Button>
        <Button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} variant="quiet" wrap>{expanded ? '收起邮件筛选' : '展开邮件筛选'}</Button></div>
      <div hidden={!expanded} className="search-filters"><Field label="发件人筛选"><Input name="sender" maxLength={320} /></Field>
        <Field label="收件时间从"><Input name="since" type="datetime-local" /></Field>
        <Field label="收件时间至"><Input name="until" type="datetime-local" /></Field></div>
      <Button type="button" className="clear-search" onClick={() => { form.current?.reset(); setError(""); onSearch(""); }} variant="quiet" wrap>清除邮件筛选</Button>
    </fieldset>
    {error && <Notice role="alert" tone="danger">{error}</Notice>}
  </form>;
}
