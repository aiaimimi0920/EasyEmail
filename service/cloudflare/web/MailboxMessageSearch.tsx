import { useRef, useState, type FormEvent } from "react";

export function MailboxMessageSearch({ disabled, onSearch }: { disabled: boolean; onSearch: (query: string) => void }) {
  const form = useRef<HTMLFormElement>(null), [error, setError] = useState("");

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
      <div className="row"><label>搜索当前邮箱邮件<input name="q" type="search" maxLength={256} /></label>
        <label>发件人筛选<input name="sender" maxLength={320} /></label></div>
      <div className="row"><label>收件时间从<input name="since" type="datetime-local" /></label>
        <label>收件时间至<input name="until" type="datetime-local" /></label>
        <button>搜索当前邮箱</button>
        <button type="button" className="secondary" onClick={() => { form.current?.reset(); setError(""); onSearch(""); }}>清除邮件筛选</button></div>
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </form>;
}
