import type { AppController } from "../../app/useAppController";

export function ComposeEncryptionDialog({ controller }: { controller: AppController }) {
  const {
    submitComposeEncryptionModal, composeEncryptionPasswordVisible, composeEncryptionPassword, setComposeEncryptionPassword, setComposeEncryptionPasswordVisible, copyComposeEncryptionPassword, composeEncryptionHint, setComposeEncryptionHint,
    setComposeEncryptionModalOpen,
  } = controller;
  return (
    <form
      id="compose-encryption-modal"
      className="nt-compose-encryption-modal"
      role="dialog"
      aria-modal="true"
      aria-label="邮件加密"
      data-modal-id="compose-encryption"
      tabIndex={-1}
      onSubmit={submitComposeEncryptionModal}
    >
      <header>
        <strong>邮件加密</strong>
        <span className="nt-compose-modal-note">预览能力</span>
      </header>
      <p>
        为这封邮件设置访问密码。对方需要输入密码才能查看受保护内容。
        <br />
        这是本地预览设置，当前不会对外发送真正加密的邮件内容。
      </p>
      <div className="nt-compose-encryption-field">
        <label htmlFor="compose-encryption-password">
          密码 <em>ⓘ</em>
        </label>
        <div className="nt-compose-encryption-password-row">
          <input
            id="compose-encryption-password"
            aria-label="密码"
            type={composeEncryptionPasswordVisible ? "text" : "password"}
            data-modal-initial-focus
            value={composeEncryptionPassword}
            placeholder="密码"
            minLength={8}
            onChange={(event) => setComposeEncryptionPassword(event.currentTarget.value)}
            required
          />
          <button
            type="button"
            aria-label="显示或隐藏加密密码"
            onClick={() => setComposeEncryptionPasswordVisible((value) => !value)}
          >
            {composeEncryptionPasswordVisible ? "🙈" : "👁"}
          </button>
          <button
            type="button"
            aria-label="复制加密密码"
            onClick={copyComposeEncryptionPassword}
          >
            ⧉
          </button>
        </div>
      </div>
      <label>
        <span>密码提示 <em>可选的</em></span>
        <input
          value={composeEncryptionHint}
          placeholder="提示"
          onChange={(event) => setComposeEncryptionHint(event.currentTarget.value)}
        />
      </label>
      <footer>
        <button type="submit">设置加密</button>
        <button type="button" onClick={() => setComposeEncryptionModalOpen(false)}>
          取消
        </button>
      </footer>
    </form>
  );
}
