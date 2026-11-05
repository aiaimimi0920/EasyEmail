import { Button, Field, Input, Notice, Panel } from '@neuro/ui';
import { useState, type FormEvent } from "react";
import { api, errorMessage, type User } from "./api";
import { BrandIcon } from './BrandIcon';

export function Authentication({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [registering, setRegistering] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError("");
    try {
      await api<{ user: User }>(`/auth/${registering ? "register" : "login"}`, "POST", {
        username: data.get("username"), password: data.get("password"), invite: data.get("invite"),
      });
      form.reset();
      onAuthenticated((await api<{ user: User }>("/me")).user);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  return <Panel className="card auth">
    <BrandIcon />
    <h1>EasyEmail</h1>
    <h2>{registering ? "注册" : "登录"}</h2>
    <form onSubmit={submit}>
      <Field label="用户名"><Input name="username" autoComplete="username" minLength={3} maxLength={64} required disabled={pending} /></Field>
      <Field label="密码"><Input name="password" type="password" autoComplete={registering ? "new-password" : "current-password"} minLength={registering ? 15 : 1} maxLength={128} required disabled={pending} /></Field>
      {registering && <Field label="邀请口令"><Input name="invite" type="password" autoComplete="off" maxLength={256} required disabled={pending} /></Field>}
      {error && <Notice role="alert" tone="danger">{error}</Notice>}
      <Button type="submit" disabled={pending} variant="primary" wrap>{pending ? "处理中…" : registering ? "注册" : "登录"}</Button>
    </form>
    <Button disabled={pending} onClick={() => { setRegistering(!registering); setError(""); }} variant="quiet" wrap>
      {registering ? "返回登录" : "使用邀请口令注册"}
    </Button>
  </Panel>;
}
