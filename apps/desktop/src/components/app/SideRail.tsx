import type { MailboxView } from "../../app/useAppController";
import type { AppController } from "../../app/useAppController";
import { MailTaxonomySection } from "./MailTaxonomySection";

export function SideRail({ controller }: { controller: AppController }) {
  const {
    railCollapsed, EasyEmailAppIcon, activeRailModeLabel, railModePickerOpen, toggleRailModePicker, RailIcon, railMode, selectRailMode,
    railNavScrollState, railNavRef, updateRailNavScrollState, MAIL_RAIL_ITEMS, mailRailCounts, formatRailBadgeCount, composePopoverOpen, activeView,
    mailboxView, openComposePopover, selectMailRailItem, mailTaxonomySectionExpanded, openMailTaxonomySectionFromIcon, railExpandedReady, createMailTaxonomyItem, toggleMailTaxonomySection,
    isMailTaxonomyDrawerOpen, mailFolders, renderMailTaxonomyFolderItems, mailLabels, renderMailTaxonomyLabelItems, agentRailBadge, agentRailBadgeCount, setRailMode,
    setActiveView, queueRailBadge, queueRailBadgeCount, expandRail, RailChevronIcon, platformAccountSignedIn, platformAccountAvatarDataUrl,
    platformAccountInitial, platformAccountName, platformAccountEmail, platformAccountMeta, platformAccountMenuOpen, openPlatformAccountPopover,
    collapseRail,
  } = controller;
  return (
    <aside
      className="nt-side-rail"
          aria-label="应用导航"
      data-collapsed={railCollapsed ? "true" : "false"}
    >
      <div className="nt-brand" data-tauri-drag-region>
        <button
          type="button"
          className="nt-shell-rail-toggle"
          aria-label={railCollapsed ? "展开侧栏" : "收起侧栏"}
          title={railCollapsed ? "展开侧栏" : "收起侧栏"}
          aria-expanded={!railCollapsed}
          onClick={railCollapsed ? expandRail : collapseRail}
        >
          <span className="nt-shell-rail-toggle__icon">
            <RailChevronIcon direction={railCollapsed ? "right" : "left"} />
          </span>
          <span className="nt-shell-rail-toggle__mark">
            <EasyEmailAppIcon />
          </span>
        </button>
        <span className="nt-brand__product-mark">
          <EasyEmailAppIcon />
        </span>
        <strong className="nt-brand__product-name nt-rail-text">NMail</strong>
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
              <MailTaxonomySection
                kind="folder"
                expanded={mailTaxonomySectionExpanded.folder}
                railExpandedReady={railExpandedReady}
                drawerOpen={isMailTaxonomyDrawerOpen("folder")}
                itemCount={mailFolders.length}
                icon={<RailIcon kind="folders" />}
                renderItems={renderMailTaxonomyFolderItems}
                onOpenFromIcon={() => openMailTaxonomySectionFromIcon("folder")}
                onCreate={() => void createMailTaxonomyItem("folder")}
                onToggle={() => toggleMailTaxonomySection("folder")}
                onSelect={() => selectMailRailItem("folders")}
              />
              <MailTaxonomySection
                kind="label"
                expanded={mailTaxonomySectionExpanded.label}
                railExpandedReady={railExpandedReady}
                drawerOpen={isMailTaxonomyDrawerOpen("label")}
                itemCount={mailLabels.length}
                icon={<RailIcon kind="labels" />}
                renderItems={renderMailTaxonomyLabelItems}
                onOpenFromIcon={() => openMailTaxonomySectionFromIcon("label")}
                onCreate={() => void createMailTaxonomyItem("label")}
                onToggle={() => toggleMailTaxonomySection("label")}
                onSelect={() => selectMailRailItem("labels")}
              />
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

        <button
          type="button"
          className={`nt-rail-account-action ${
            platformAccountSignedIn
              ? "nt-rail-account-action--signed-in"
              : "nt-rail-account-action--signed-out"
          }`}
          aria-label={platformAccountSignedIn ? `账号：${platformAccountName}` : "账号：未登录"}
          title={
            platformAccountSignedIn
              ? `${platformAccountName} / ${platformAccountEmail} / ${platformAccountMeta}`
              : "账号 / 未登录"
          }
          aria-expanded={platformAccountMenuOpen && !railCollapsed}
          aria-haspopup="dialog"
          data-nonmodal-trigger="platform-account"
          onClick={() => {
            if (railCollapsed) expandRail();
            openPlatformAccountPopover();
          }}
        >
          <span className="nt-platform-avatar" aria-hidden="true">
            {platformAccountSignedIn && platformAccountAvatarDataUrl ? (
              <img src={platformAccountAvatarDataUrl} alt="" />
            ) : platformAccountSignedIn ? (
              platformAccountInitial
            ) : (
              "N"
            )}
          </span>
          <span className="nt-rail-text nt-platform-account-copy">
            <strong>账号</strong>
          </span>
        </button>
      </div>
    </aside>
  );
}
