import type { AppController } from "../../app/useAppController";

export function ComposeExpirationDialog({ controller }: { controller: AppController }) {
  const {
    submitComposeExpirationModal, composeExpirationDate, setComposeExpirationDate, composeExpirationTime, setComposeExpirationTime, composeExpirationSendOutside, setComposeExpirationSendOutside, setComposeExpirationModalOpen,
  } = controller;
  return (
    <form
      className="nt-compose-expiration-modal"
      role="dialog"
      aria-modal="true"
      aria-label="邮件有效期"
      data-modal-id="compose-expiration"
      tabIndex={-1}
      onSubmit={submitComposeExpirationModal}
    >
      <header>
        <strong>邮件有效期</strong>
        <span className="nt-compose-modal-note">本地标记</span>
      </header>
      <p>
        您想何时将此邮件从对方的收件箱和您的已发送列表中删除?
        <br />
        当前这只会保存为本地预览标记，不会真正删除对方收件箱中的邮件。
      </p>
      <div className="nt-compose-modal-grid">
        <label>
          <span>日期</span>
          <input
            type="date"
            data-modal-initial-focus
            value={composeExpirationDate}
            onChange={(event) => setComposeExpirationDate(event.currentTarget.value)}
            required
          />
        </label>
        <label>
          <span>时间</span>
          <input
            type="time"
            value={composeExpirationTime}
            onChange={(event) => setComposeExpirationTime(event.currentTarget.value)}
            required
          />
        </label>
      </div>
      <label className="nt-compose-modal-check">
        <input
          type="checkbox"
          checked={composeExpirationSendOutside}
          onChange={() => setComposeExpirationSendOutside((value) => !value)}
        />
        <span>我需要将此邮件发给外部邮箱。</span>
      </label>
      <footer>
        <button type="submit">设置</button>
        <button type="button" onClick={() => setComposeExpirationModalOpen(false)}>
          取消
        </button>
      </footer>
    </form>
  );
}
