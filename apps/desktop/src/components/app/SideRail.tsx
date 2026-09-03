import type { MailboxView } from "../../app/useAppController";
import type { AppController } from "../../app/useAppController";

export function SideRail({ controller }: { controller: AppController }) {
  const {
    railCollapsed, EasyEmailAppIcon, activeRailModeLabel, railModePickerOpen, toggleRailModePicker, RailIcon, railMode, selectRailMode,
    railNavScrollState, railNavRef, updateRailNavScrollState, MAIL_RAIL_ITEMS, mailRailCounts, formatRailBadgeCount, composePopoverOpen, activeView,
    mailboxView, openComposePopover, selectMailRailItem, mailTaxonomySectionExpanded, openMailTaxonomySectionFromIcon, railExpandedReady, createMailTaxonomyItem, toggleMailTaxonomySection,
    isMailTaxonomyDrawerOpen, mailFolders, renderMailTaxonomyFolderItems, mailLabels, renderMailTaxonomyLabelItems, agentRailBadge, agentRailBadgeCount, setRailMode,
    setActiveView, queueRailBadge, queueRailBadgeCount, expandRail, RailChevronIcon, platformAccountSignedIn, choosePlatformAvatarFile, platformAccountAvatarDataUrl,
    platformAccountInitial, platformAccountName, platformAccountEmail, platformAccountMeta, platformAccountMenuOpen, openPlatformAccountPopover, signInPlatformAccount, busy,
    collapseRail,
  } = controller;
  return (
    <aside
      className="nt-side-rail"
          aria-label="应用导航"
      data-collapsed={railCollapsed ? "true" : "false"}
    >
      <div className="nt-brand">
        <span className="nt-brand__mark">
          <EasyEmailAppIcon />
        </span>
        <div className="nt-rail-text nt-brand__text">
          <strong>NMail</strong>
        </div>
      </div>

      <div
        className={`nt-mode-switch ${
          railCollapsed ? "nt-mode-switch--collapsed" : "nt-mode-switch--expanded"
        }`}
                aria-label="邮件模式"
      >
        {railCollapsed ? (
          <button
            type="button"
            className="nt-mode-current"
            aria-label={`Current mode: ${activeRailModeLabel}. Open mode picker`}
            aria-haspopup="menu"
            aria-expanded={railModePickerOpen}
            data-nonmodal-trigger="rail-mode"
            title={activeRailModeLabel}
            onClick={toggleRailModePicker}
          >
            <span className="nt-mode-option__icon">
              <RailIcon kind={railMode} />
            </span>
          </button>
        ) : (
          <>
            <button
              type="button"
              data-mode="mail"
              className={`nt-mode-option ${railMode === "mail" ? "nt-mode-option--active" : ""}`}
              aria-pressed={railMode === "mail"}
                  title="邮件"
              onClick={() => selectRailMode("mail")}
            >
              <span className="nt-mode-option__icon">
                <RailIcon kind="mail" />
              </span>
            </button>
            <button
              type="button"
              data-mode="agent"
              className={`nt-mode-option ${railMode === "agent" ? "nt-mode-option--active" : ""}`}
              aria-pressed={railMode === "agent"}
                  title="代理"
              onClick={() => selectRailMode("agent")}
            >
              <span className="nt-mode-option__icon">
                <RailIcon kind="agent" />
              </span>
            </button>
          </>
        )}
      </div>

      <div className="nt-nav-shell">
        {railNavScrollState.top ? (
          <span className="nt-nav-scroll-hint nt-nav-scroll-hint--top" aria-hidden="true" />
        ) : null}
        <nav ref={railNavRef} className="nt-nav" onScroll={updateRailNavScrollState}>
          {railMode === "mail" ? (
          MAIL_RAIL_ITEMS.filter((item) => item.id !== "folders" && item.id !== "labels").map((item) => {
            const count = mailRailCounts[item.id];
            const badge = formatRailBadgeCount(count);
            const active =
              item.id === "compose"
                ? composePopoverOpen
                : activeView === "mail" && mailboxView === item.id;
            return (
              <button
                type="button"
                key={item.id}
                data-view={item.id === "compose" ? "compose" : "mail"}
                data-mail-rail-item={item.id}
                aria-label={badge ? `${item.label}, ${count} unread or pending` : item.label}
                aria-expanded={item.id === "compose" ? composePopoverOpen : undefined}
                aria-controls={item.id === "compose" ? "compose-popover" : undefined}
                data-nonmodal-trigger={item.id === "compose" ? "compose-popover" : undefined}
                title={item.label}
                className={`nt-nav__item ${
                  item.id === "compose" ? "nt-nav__item--primary" : ""
                } ${active ? "nt-nav__item--active" : ""}`}
                onClick={
                  item.id === "compose"
                    ? openComposePopover
                    : () => selectMailRailItem(item.id as MailboxView)
                }
              >
                <span className="nt-nav__icon">
                  <RailIcon kind={item.id} />
                  {badge ? <span className="nt-nav__badge">{badge}</span> : null}
                </span>
                <strong className="nt-nav__label nt-rail-text">{item.label}</strong>
              </button>
            );
          })
          ) : null}
          {railMode === "mail" ? (
        <div className="nt-mail-taxonomy" aria-label="文件夹与标签">
            <section className="nt-mail-taxonomy__section">
              <div className="nt-mail-taxonomy__head">
                <button
                  type="button"
                  className="nt-mail-taxonomy__icon-toggle"
                  data-modal-return-focus="mail-taxonomy"
                  aria-label={mailTaxonomySectionExpanded.folder ? "收起文件夹" : "展开文件夹"}
                  aria-expanded={mailTaxonomySectionExpanded.folder}
                  aria-controls="mail-taxonomy-folders"
                  onClick={() => openMailTaxonomySectionFromIcon("folder")}
                >
                  <span className="nt-nav__icon nt-mail-taxonomy__icon">
                    <RailIcon kind="folders" />
                  </span>
                </button>
                {railExpandedReady ? (
                  <div className="nt-mail-taxonomy__row">
                    <button
                      type="button"
                      className="nt-mail-taxonomy__add"
                      aria-label="新建文件夹"
                      onClick={() => void createMailTaxonomyItem("folder")}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="nt-mail-taxonomy__chevron"
                      aria-label={mailTaxonomySectionExpanded.folder ? "收起文件夹" : "展开文件夹"}
                      aria-expanded={mailTaxonomySectionExpanded.folder}
                      aria-controls="mail-taxonomy-folders"
                      onClick={() => toggleMailTaxonomySection("folder")}
                    >
                      {mailTaxonomySectionExpanded.folder ? "⌃" : "⌄"}
                    </button>
                  </div>
                ) : null}
              </div>
              <div id="mail-taxonomy-folders" hidden={!mailTaxonomySectionExpanded.folder}>
                {mailTaxonomySectionExpanded.folder ? (
                  isMailTaxonomyDrawerOpen("folder") ? (
                  <div className="nt-mail-taxonomy__drawer" role="group" aria-label="文件夹">
                    <div className="nt-mail-taxonomy__drawer-head">
                      <button type="button" className="nt-mail-taxonomy__drawer-title" onClick={() => selectMailRailItem("folders")}>
                        <strong>文件夹</strong>
                      </button>
                      <button
                        type="button"
                        className="nt-mail-taxonomy__add"
                        aria-label="新建文件夹"
                        onClick={() => void createMailTaxonomyItem("folder")}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        className="nt-mail-taxonomy__chevron"
                        aria-label="收起文件夹"
                        onClick={() => toggleMailTaxonomySection("folder")}
                      >
                        ⌃
                      </button>
                    </div>
                    {mailFolders.length === 0 ? (
                      <p
                        className="nt-mail-taxonomy__empty nt-rail-text"
                        role="status"
                        aria-live="polite"
                        data-empty-state
                      >
                        无文件夹
                      </p>
                    ) : renderMailTaxonomyFolderItems()}
                  </div>
                ) : mailFolders.length === 0 ? (
                  <p
                    className="nt-mail-taxonomy__empty nt-rail-text"
                    role="status"
                    aria-live="polite"
                    data-empty-state
                  >
                    无文件夹
                  </p>
                ) : (
                  renderMailTaxonomyFolderItems()
                  )
                ) : null}
              </div>
            </section>

            <section className="nt-mail-taxonomy__section">
              <div className="nt-mail-taxonomy__head">
                <button
                  type="button"
                  className="nt-mail-taxonomy__icon-toggle"
                  data-modal-return-focus="mail-taxonomy"
                  aria-label={mailTaxonomySectionExpanded.label ? "收起标签" : "展开标签"}
                  aria-expanded={mailTaxonomySectionExpanded.label}
                  aria-controls="mail-taxonomy-labels"
                  onClick={() => openMailTaxonomySectionFromIcon("label")}
                >
                  <span className="nt-nav__icon nt-mail-taxonomy__icon">
                    <RailIcon kind="labels" />
                  </span>
                </button>
                {railExpandedReady ? (
                  <div className="nt-mail-taxonomy__row">
                    <button
                      type="button"
                      className="nt-mail-taxonomy__add"
                      aria-label="新建标签"
                      onClick={() => void createMailTaxonomyItem("label")}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="nt-mail-taxonomy__chevron"
                      aria-label={mailTaxonomySectionExpanded.label ? "收起标签" : "展开标签"}
                      aria-expanded={mailTaxonomySectionExpanded.label}
                      aria-controls="mail-taxonomy-labels"
                      onClick={() => toggleMailTaxonomySection("label")}
                    >
                      {mailTaxonomySectionExpanded.label ? "⌃" : "⌄"}
                    </button>
                  </div>
                ) : null}
              </div>
              <div id="mail-taxonomy-labels" hidden={!mailTaxonomySectionExpanded.label}>
                {mailTaxonomySectionExpanded.label ? (
                  isMailTaxonomyDrawerOpen("label") ? (
                  <div className="nt-mail-taxonomy__drawer" role="group" aria-label="标签">
                    <div className="nt-mail-taxonomy__drawer-head">
                      <button type="button" className="nt-mail-taxonomy__drawer-title" onClick={() => selectMailRailItem("labels")}>
                        <strong>标签</strong>
                      </button>
                      <button
                        type="button"
                        className="nt-mail-taxonomy__add"
                        aria-label="新建标签"
                        onClick={() => void createMailTaxonomyItem("label")}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        className="nt-mail-taxonomy__chevron"
                        aria-label="收起标签"
                        onClick={() => toggleMailTaxonomySection("label")}
                      >
                        ⌃
                      </button>
                    </div>
                    {mailLabels.length === 0 ? (
                      <p
                        className="nt-mail-taxonomy__empty nt-rail-text"
                        role="status"
                        aria-live="polite"
                        data-empty-state
                      >
                        无标签
                      </p>
                    ) : renderMailTaxonomyLabelItems()}
                  </div>
                ) : mailLabels.length === 0 ? (
                  <p
                    className="nt-mail-taxonomy__empty nt-rail-text"
                    role="status"
                    aria-live="polite"
                    data-empty-state
                  >
                    无标签
                  </p>
                ) : (
                  renderMailTaxonomyLabelItems()
                  )
                ) : null}
              </div>
            </section>
          </div>
          ) : null}
          {railMode === "agent" ? (
          <button
            type="button"
            data-view="agent"
            aria-label={
              agentRailBadge ? `Agent Mail, ${agentRailBadgeCount} needs attention` : "Agent Mail"
            }
            title="代理邮件"
            className={`nt-nav__item ${activeView === "agent" ? "nt-nav__item--active" : ""}`}
            onClick={() => {
              setRailMode("agent");
              setActiveView("agent");
            }}
          >
            <span className="nt-nav__icon">
              <RailIcon kind="agent" />
              {agentRailBadge ? <span className="nt-nav__badge">{agentRailBadge}</span> : null}
            </span>
            <strong className="nt-nav__label nt-rail-text">代理邮件</strong>
          </button>
          ) : null}
          {railMode === "agent" ? (
          <button
            type="button"
            data-view="queue"
            aria-label={queueRailBadge ? `Queue, ${queueRailBadgeCount} pending` : "Queue"}
            title="发送队列"
            className={`nt-nav__item ${activeView === "queue" ? "nt-nav__item--active" : ""}`}
            onClick={() => setActiveView("queue")}
          >
            <span className="nt-nav__icon">
              <RailIcon kind="queue" />
              {queueRailBadge ? <span className="nt-nav__badge">{queueRailBadge}</span> : null}
            </span>
            <strong className="nt-nav__label nt-rail-text">发送队列</strong>
          </button>
          ) : null}
        </nav>
        {railNavScrollState.bottom ? (
          <span className="nt-nav-scroll-hint nt-nav-scroll-hint--bottom" aria-hidden="true" />
        ) : null}
      </div>

      <div className="nt-rail-footer">
        <button
          type="button"
          data-view="setup"
          className={`nt-rail-footer-action ${
            activeView === "setup" ? "nt-rail-footer-action--active" : ""
          }`}
          aria-label="设置"
          title="设置"
          onClick={() => setActiveView("setup")}
        >
          <span className="nt-rail-footer-action__icon">
            <RailIcon kind="setup" />
          </span>
          <span className="nt-rail-text nt-rail-footer-action__copy">
            <strong>设置</strong>
          </span>
        </button>

        {railCollapsed ? (
          <button
            type="button"
            className="nt-rail-toggle nt-platform-account-collapsed-toggle"
            aria-label="展开导航"
            title="展开导航"
            aria-pressed={railCollapsed}
            onClick={expandRail}
          >
            <span className="nt-rail-toggle__icon" aria-hidden="true">
              <RailChevronIcon direction="right" />
            </span>
            <span className="nt-rail-toggle__label nt-rail-text">展开</span>
          </button>
        ) : (
          <div
            className={`nt-platform-account-control nt-platform-account-control--expanded ${
              platformAccountSignedIn
                ? "nt-platform-account-control--signed-in"
                : "nt-platform-account-control--signed-out"
            }`}
          >
            {platformAccountSignedIn ? (
              <>
                <button
                  type="button"
                  className="nt-platform-avatar-button"
                  aria-label="上传平台账户图标"
                  title="上传平台账户图标"
                  onClick={choosePlatformAvatarFile}
                >
                  <span className="nt-platform-avatar" aria-hidden="true">
                    {platformAccountAvatarDataUrl ? (
                      <img src={platformAccountAvatarDataUrl} alt="" />
                    ) : (
                      platformAccountInitial
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  className="nt-platform-account-name-button"
                  aria-label="平台账户"
                  title={`${platformAccountName} / ${platformAccountEmail} / ${platformAccountMeta}`}
                  aria-expanded={platformAccountMenuOpen}
                  aria-haspopup="dialog"
                  data-nonmodal-trigger="platform-account"
                  onClick={openPlatformAccountPopover}
                >
                  <span className="nt-rail-text nt-platform-account-copy">
                    <strong className="nt-platform-account-name">{platformAccountName}</strong>
                  </span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="nt-platform-account-login-button"
                aria-label="登录平台账户"
                onClick={() => void signInPlatformAccount()}
                disabled={busy}
              >
                预览登录
              </button>
            )}
            <button
              type="button"
              className="nt-rail-toggle nt-platform-account-collapse-toggle"
              aria-label="收起导航"
              title="收起导航"
              aria-pressed={railCollapsed}
              onClick={collapseRail}
            >
              <span className="nt-rail-toggle__icon" aria-hidden="true">
                <RailChevronIcon direction="left" />
              </span>
              <span className="nt-rail-toggle__label nt-rail-text">收起</span>
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
