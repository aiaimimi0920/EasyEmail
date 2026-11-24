import { Button, ButtonLink, Field, Input, Notice, Panel } from '@neuro/ui';
import { useRef, useState, type FormEvent } from "react";
import { api, errorMessage } from "./api";
import { useConfirmation } from "./Confirmation";
import { buildNaccountLogoutUrl, type AuthConfig, type NaccountAuthConfig } from "./naccount-auth";

export function PasswordChange({ userId, authConfig, onSignedOut }: {
  userId: string; authConfig: AuthConfig; onSignedOut: (message: string) => void;
}) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const confirm = useConfirmation([userId, authConfig.mode]);

  async function revokeAllCredentials() {
    if (busy.current) return;
    const accepted = await confirm("将退出 EasyEmail 所有设备会话并撤销全部 API Key，程序需要重新创建 Key。确认继续？");
    if (!accepted || busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await api("/account/revoke-credentials", "POST", {});
      onSignedOut("全部会话和 API Key 已撤销，请重新登录");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function ssoLogout(config: NaccountAuthConfig) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await api("/auth/logout", "POST");
      window.location.assign(buildNaccountLogoutUrl(config));
    } catch (failure) {
      setError(errorMessage(failure));
      busy.current = false;
      setPending(false);
    }
  }

  if (authConfig.mode === "naccount") {
    return <Panel className="card" aria-label="账号安全">
      <h2>账号安全</h2>
      <p>密码、双重验证、通行密钥与绑定邮箱由 NAccount 统一管理。</p>
      {error && <Notice role="alert" tone="danger">{error}</Notice>}
      <div className="row">
        <ButtonLink href={authConfig.accountUrl} target="_blank" rel="noopener noreferrer" variant="primary" wrap>
          前往 NAccount 账号中心
        </ButtonLink>
        <Button type="button" disabled={pending} onClick={() => void revokeAllCredentials()} variant="quiet" wrap>
          {pending ? "处理中…" : "撤销本应用全部会话与 API Key"}
        </Button>
        <Button type="button" disabled={pending} onClick={() => void ssoLogout(authConfig)} variant="quiet" wrap>
          退出 EasyEmail 与 NAccount 全站登录
        </Button>
      </div>
    </Panel>;
  }

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
