import type { ComposeLinkType } from "../../compose/composeLink";
import type { AppController } from "../../app/useAppController";

export function ComposeLinkDialog({ controller }: { controller: AppController }) {
  const {
    submitComposeLinkModal, setComposeLinkModalOpen, composeLinkType, setComposeLinkType, composeLinkUrl, setComposeLinkUrl, composeLinkText, setComposeLinkText,
    normalizedComposeLinkHref,
  } = controller;
  return (
    <form
      className="nt-compose-link-modal"
      role="dialog"
      aria-modal="true"
      aria-label="插入链接"
      data-modal-id="compose-link"
      tabIndex={-1}
      onSubmit={submitComposeLinkModal}
    >
      <header>
        <strong>插入链接</strong>
        <button type="button" onClick={() => setComposeLinkModalOpen(false)} aria-label="关闭">
          ×
        </button>
      </header>
      <p>请选择链接类型并填写相关信息。</p>
      <label>
        <span>链接类型</span>
        <select
          value={composeLinkType}
          onChange={(event) => setComposeLinkType(event.currentTarget.value as ComposeLinkType)}
        >
          <option value="web">网址</option>
          <option value="email">电子邮件地址</option>
          <option value="phone">电话号码</option>
        </select>
      </label>
      <label>
        <span>
          {composeLinkType === "web"
            ? "网址"
            : composeLinkType === "email"
              ? "电子邮件地址"
              : "电话号码"}
        </span>
        <input
          value={composeLinkUrl}
          onChange={(event) => setComposeLinkUrl(event.currentTarget.value)}
          placeholder={
            composeLinkType === "web"
              ? "链接"
              : composeLinkType === "email"
                ? "name@example.com"
                : "+86 138 0000 0000"
          }
          data-modal-initial-focus
          required
        />
      </label>
      <label>
        <span>要显示的文字</span>
        <input
          value={composeLinkText}
          onChange={(event) => setComposeLinkText(event.currentTarget.value)}
          placeholder="文本"
          required
        />
      </label>
      <div className="nt-compose-link-modal__test">
        <span>测试链接</span>
        {normalizedComposeLinkHref && composeLinkText.trim() ? (
          <a
            href={normalizedComposeLinkHref}
            target="_blank"
            rel="noreferrer"
          >
            {composeLinkText}
          </a>
        ) : composeLinkUrl.trim() && composeLinkText.trim() ? (
          <em role="alert">链接格式无效</em>
        ) : (
          <em>请先输入链接内容</em>
        )}
      </div>
      <footer>
        <button type="button" onClick={() => setComposeLinkModalOpen(false)}>
          取消
        </button>
        <button
          type="submit"
          disabled={!normalizedComposeLinkHref || !composeLinkText.trim()}
        >
          插入
        </button>
      </footer>
    </form>
  );
}
