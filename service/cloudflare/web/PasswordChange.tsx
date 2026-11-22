import { Button, Field, Input, Notice, Panel } from '@neuro/ui';
import { useRef, useState, type FormEvent } from "react";
import { api, errorMessage } from "./api";

export function PasswordChange({ onSignedOut }: { onSignedOut: (message: string) => void }) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    if (data.get("newPassword") !== data.get("confirmation")) {
      setError("两次新密码不一致");
      return;
    }
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await api("/account/password", "POST", {
        currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword"),
      });
      form.reset();
      onSignedOut("密码已修改，全部会话和 API Key 已撤销，请重新登录");
    } catch (failure) { setError(errorMessage(failure)); }
    finally { busy.current = false; setPending(false); }
  }

  return <Panel className="card" aria-label="账号安全">
    <h2>账号安全</h2>
    <form onSubmit={submit}>
      <fieldset disabled={pending}>
        <Field label="当前密码"><Input name="currentPassword" type="password" autoComplete="current-password" maxLength={128} required /></Field>
        <Field label="新密码"><Input name="newPassword" type="password" autoComplete="new-password" minLength={15} maxLength={128} required /></Field>
        <Field label="确认新密码"><Input name="confirmation" type="password" autoComplete="new-password" minLength={15} maxLength={128} required /></Field>
        <p>修改后将退出所有设备并撤销全部 API Key，程序需要重新创建 Key。</p>
        {error && <Notice role="alert" tone="danger">{error}</Notice>}
        <Button type="submit" wrap>{pending ? "处理中…" : "修改密码并退出所有设备"}</Button>
      </fieldset>
    </form>
  </Panel>;
}
