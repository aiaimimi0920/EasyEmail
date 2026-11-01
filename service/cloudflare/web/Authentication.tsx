import { useState, type FormEvent } from "react";
import { api, errorMessage, type User } from "./api";

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

  return <section className="card auth">
    <h1>EasyEmail</h1>
    <h2>{registering ? "注册" : "登录"}</h2>
    <form onSubmit={submit}>
      <label>用户名<input name="username" autoComplete="username" minLength={3} maxLength={64} required disabled={pending} /></label>
      <label>密码<input name="password" type="password" autoComplete={registering ? "new-password" : "current-password"}
        minLength={registering ? 15 : 1} maxLength={128} required disabled={pending} /></label>
      {registering && <label>邀请口令<input name="invite" type="password" autoComplete="off" maxLength={256} required disabled={pending} /></label>}
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={pending}>{pending ? "处理中…" : registering ? "注册" : "登录"}</button>
    </form>
    <button className="secondary" disabled={pending} onClick={() => { setRegistering(!registering); setError(""); }}>
      {registering ? "返回登录" : "使用邀请口令注册"}
    </button>
  </section>;
}
