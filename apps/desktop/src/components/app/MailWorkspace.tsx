import type { ManualImapAccountCreateRequest } from "../../api/mailAccountClient";
import type { AppController } from "../../app/useAppController";

import { MailListPane } from "./MailListPane";
import { MailListToolbar } from "./MailListToolbar";
import { MailReadingPane } from "./MailReadingPane";
import { MailSearchBar } from "./MailSearchBar";
import { MailSearchOverlay } from "./MailSearchOverlay";
import { MailSourceDrawer } from "./MailSourceDrawer";
import { MailTopbarActions } from "./MailTopbarActions";

export function MailWorkspace({ controller }: { controller: AppController }) {
  const {
    submitMailSearch,
    mailSearchOverlayOpen,
    mailReadingExpanded,
    mailAccountPanelOpen,
    setMailAccountPanelOpen,
    applyQqMailPreset,
    normalDisplayName,
    setNormalDisplayName,
    normalEmailAddress,
    updateNormalEmailAddress,
    normalImapPassword,
    updateMailboxAuthorizationCode,
    mailboxLoginUsername,
    normalImapHost,
    normalImapPort,
    setMailAccountPanelAdvancedOpen,
    mailAccountPanelAdvancedOpen,
    setNormalImapHost,
    setNormalImapPort,
    normalImapSecurity,
    setNormalImapSecurity,
    addManualImapAccount,
    mailSourceDrawerOpen,
    visibleMailMessages,
    busy,
  } = controller;

  return (
    <section className="nt-board-view nt-board-view--mail">
      <div className="nt-mail-topbar">
        <form className="nt-mail-search-region" role="search" onSubmit={submitMailSearch}>
          <MailSearchBar controller={controller} />

          {mailSearchOverlayOpen ? <MailSearchOverlay controller={controller} /> : null}
        </form>

        <MailTopbarActions controller={controller} />
      </div>

      {mailAccountPanelOpen ? (
        <div className="nt-mail-account-panel-scrim" role="presentation">
          <aside
            className="nt-mail-account-panel"
            role="dialog"
            aria-modal="true"
            aria-label="添加长效邮箱"
            data-modal-id="mail-account"
            tabIndex={-1}
          >
            <div className="nt-mail-account-panel__head">
              <div>
                <p className="nt-kicker">长效邮箱</p>
                <h2>添加邮箱</h2>
              </div>
              <button
                type="button"
                className="nt-mini-btn"
                onClick={() => setMailAccountPanelOpen(false)}
              >
                关闭
              </button>
            </div>

            <div className="nt-mail-account-panel__preset">
              <button
                type="button"
                className="nt-btn nt-btn--secondary"
                onClick={applyQqMailPreset}
              >
                QQ 邮箱预设
              </button>
              <span>QQ 邮箱 / IMAP 993 / TLS / 使用授权码（SMTP 在 M5）</span>
            </div>

            <div className="nt-scroll-pane nt-mail-account-panel__body">
              <div className="nt-form-grid">
                <label>
                  显示名称
                  <input
                    data-modal-initial-focus
                    value={normalDisplayName}
                    placeholder="QQ Mail"
                    onChange={(event) => setNormalDisplayName(event.currentTarget.value)}
                  />
                </label>
                <label>
                  邮箱地址
                  <input
                    value={normalEmailAddress}
                    placeholder="123456@qq.com"
                    onChange={(event) => updateNormalEmailAddress(event.currentTarget.value)}
                  />
                </label>
                <label className="nt-wide-field">
                  授权码
                  <input
                    type="password"
                    value={normalImapPassword}
                    placeholder="QQ 邮箱授权码"
                    onChange={(event) => updateMailboxAuthorizationCode(event.currentTarget.value)}
                  />
                </label>
                <div className="nt-derived-grid nt-wide-field">
                  <span>登录</span>
                  <strong>{mailboxLoginUsername() || "邮箱地址"}</strong>
                  <span>收取</span>
                  <strong>
                    {normalImapHost || "imap.qq.com"}:{normalImapPort || "993"}
                  </strong>
                  <span>发送</span>
                  <strong>SMTP 将在 M5 迁移</strong>
                </div>
                <button
                  type="button"
                  className="nt-mini-btn nt-wide-field"
                  onClick={() => setMailAccountPanelAdvancedOpen((value) => !value)}
                >
                  {mailAccountPanelAdvancedOpen ? "隐藏高级设置" : "高级服务器设置"}
                </button>
                {mailAccountPanelAdvancedOpen ? (
                  <>
                    <label>
                      IMAP 主机
                      <input
                        value={normalImapHost}
                        placeholder="imap.qq.com"
                        onChange={(event) => setNormalImapHost(event.currentTarget.value)}
                      />
                    </label>
                    <label>
                      IMAP 端口
                      <input
                        value={normalImapPort}
                        inputMode="numeric"
                        placeholder="993"
                        onChange={(event) => setNormalImapPort(event.currentTarget.value)}
                      />
                    </label>
                    <label>
                      IMAP 安全模式
                      <select
                        value={normalImapSecurity}
                        onChange={(event) =>
                          setNormalImapSecurity(
                            event.currentTarget.value as ManualImapAccountCreateRequest["imap_security"],
                          )
                        }
                      >
                        <option value="tls">TLS</option>
                        <option value="starttls">STARTTLS</option>
                      </select>
                    </label>
                    <p className="nt-form-note nt-wide-field">
                      当前 M3 只保存 IMAP 配置。SMTP 主机、端口和发信凭据将在 M5 发送队列切片中迁移。
                    </p>
                  </>
                ) : null}
              </div>
            </div>

            <div className="nt-mail-account-panel__foot">
              <button
                type="button"
                className="nt-btn nt-btn--primary"
                onClick={() => void addManualImapAccount()}
                disabled={busy}
              >
                保存并测试 IMAP
              </button>
            </div>
          </aside>
        </div>
      ) : null}

      <div
        className={`nt-mail-adaptive ${
          mailSourceDrawerOpen ? "nt-mail-adaptive--drawer-open" : ""
        } ${mailReadingExpanded ? "nt-mail-adaptive--reading" : ""} ${
          visibleMailMessages.length === 0 ? "nt-mail-adaptive--empty" : ""
        }`}
      >
        <MailListToolbar controller={controller} />

        <MailListPane controller={controller} />

        {visibleMailMessages.length > 0 ? (
          <MailReadingPane controller={controller} />
        ) : null}

        {mailSourceDrawerOpen ? <MailSourceDrawer controller={controller} /> : null}
      </div>
    </section>
  );
}
