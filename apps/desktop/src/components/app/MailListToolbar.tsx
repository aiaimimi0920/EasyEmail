import type { AppController } from "../../app/useAppController";

export function MailListToolbar({ controller }: { controller: AppController }) {
  const {
    displayedMailMessages, allVisibleMailMessagesSelected, someVisibleMailMessagesSelected, toggleSelectAllVisibleMailMessages, mailListSelectionMenuOpen, closeMailListToolbarMenus, setMailListSelectionMenuOpen, MailListToolbarIcon,
    renderMailListSelectionMenu, mailListHasSelection, selectedMailMessagesHaveUnread, markSelectedMailMessagesRead, busy, mailListPrimaryMoveActions,
    renderMailListPrimaryMoveAction, mailListMoveMenuOpen, setMailListMoveTarget, setMailListMoveSearch, setMailListMoveMenuOpen, renderMailListMoveMenu, mailListLabelMenuOpen, resetMailListLabelDraftFromSelection,
    setMailListLabelSearch, setMailListLabelArchiveAfterApply, setMailListLabelMenuOpen, renderMailListLabelMenu, mailListSnoozeMenuOpen, setMailListSnoozeMenuOpen, renderMailListSnoozeMenu, mailListBulkMenuOpen,
    setMailListBulkMenuOpen, renderMailListMoreMenu, visibleMailMessages, mailListReadFilter, mailListHasAttachmentOnly, toggleMailListUnreadOnly, mailListFilterMenuOpen, setMailListFilterMenuOpen,
    renderMailListFilterMenu, goToMailListPage, clampedMailListCurrentPage, displayedMailConversations, mailListPageStart, mailListPageEnd, mailListTotalPages,
  } = controller;
  const toolbarHasContent =
    displayedMailMessages.length > 0 ||
    visibleMailMessages.length > 0 ||
    mailListReadFilter !== "all" ||
    mailListHasAttachmentOnly;
  if (!toolbarHasContent) return null;

  return (
    <div className="nt-mail-list-toolbar">
      <div className="nt-mail-list-toolbar__row-main">
        <div className="nt-mail-list-toolbar__group">
          {displayedMailMessages.length > 0 ? (
            <div className="nt-mail-list-toolbar__menu-anchor">
              <div className="nt-mail-list-toolbar__select-group">
                <button
                  type="button"
                  className={`nt-mail-list-select ${
                    allVisibleMailMessagesSelected ? "nt-mail-list-select--checked" : ""
                  } ${someVisibleMailMessagesSelected ? "nt-mail-list-select--partial" : ""}`}
                  aria-label="选择当前页邮件"
                  aria-pressed={allVisibleMailMessagesSelected}
                  onClick={toggleSelectAllVisibleMailMessages}
                >
                  <span className="nt-mail-list-select__box" aria-hidden="true">
                    {allVisibleMailMessagesSelected ? "✓" : someVisibleMailMessagesSelected ? "−" : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className="nt-mail-list-toolbar__trigger"
                  aria-label="打开选择菜单"
                  aria-haspopup="menu"
                  aria-expanded={mailListSelectionMenuOpen}
                  aria-controls="mail-list-selection-menu"
                  data-nonmodal-trigger="mail-list-selection"
                  onClick={() => {
                    const nextOpen = !mailListSelectionMenuOpen;
                    closeMailListToolbarMenus();
                    setMailListSelectionMenuOpen(nextOpen);
                  }}
                >
                  <MailListToolbarIcon kind="chevron-down" />
                </button>
              </div>
              {renderMailListSelectionMenu()}
            </div>
          ) : null}
          <span
            className="nt-mail-list-toolbar__mailbox-count"
            aria-label={`${displayedMailMessages.length} 封邮件`}
            title={`${displayedMailMessages.length} 封邮件`}
          >
            {displayedMailMessages.length}
          </span>
          {mailListHasSelection ? (
    <div className="nt-mail-list-toolbar__selected-actions" aria-label="选中邮件操作">
              <button
                type="button"
                className="nt-mail-list-toolbar__action"
        aria-label="标记选中邮件"
                title={selectedMailMessagesHaveUnread ? "标记为已读" : "标记为未读"}
                onClick={() => void markSelectedMailMessagesRead(selectedMailMessagesHaveUnread)}
                disabled={busy}
              >
                <MailListToolbarIcon kind="mark-read" />
              </button>
              <span className="nt-mail-list-toolbar__divider--vertical" aria-hidden="true" />
              {mailListPrimaryMoveActions.map((action) => renderMailListPrimaryMoveAction(action))}
              <span className="nt-mail-list-toolbar__divider--vertical" aria-hidden="true" />
              <div className="nt-mail-list-toolbar__menu-anchor">
                <button
                  type="button"
                  className="nt-mail-list-toolbar__action"
                  aria-label="移动选中邮件"
                  title="移动"
                  aria-haspopup="dialog"
                  aria-expanded={mailListMoveMenuOpen}
                  aria-controls="mail-list-move-panel"
                  data-nonmodal-trigger="mail-list-move"
                  onClick={() => {
                    const nextOpen = !mailListMoveMenuOpen;
                    closeMailListToolbarMenus();
                    setMailListMoveTarget("");
                    setMailListMoveSearch("");
                    setMailListMoveMenuOpen(nextOpen);
                  }}
                  disabled={busy}
                >
                  <MailListToolbarIcon kind="move" />
                </button>
                {renderMailListMoveMenu()}
              </div>
              <div className="nt-mail-list-toolbar__menu-anchor">
                <button
                  type="button"
                  className="nt-mail-list-toolbar__action"
                  aria-label="为选中邮件添加标签"
                  title="标签"
                  aria-haspopup="dialog"
                  aria-expanded={mailListLabelMenuOpen}
                  aria-controls="mail-list-label-panel"
                  data-nonmodal-trigger="mail-list-label"
                  onClick={() => {
                    const nextOpen = !mailListLabelMenuOpen;
                    closeMailListToolbarMenus();
                    if (nextOpen) {
                      resetMailListLabelDraftFromSelection();
                      setMailListLabelSearch("");
                      setMailListLabelArchiveAfterApply(false);
                    }
                    setMailListLabelMenuOpen(nextOpen);
                  }}
                  disabled={busy}
                >
                  <MailListToolbarIcon kind="label" />
                </button>
                {renderMailListLabelMenu()}
              </div>
              <div className="nt-mail-list-toolbar__menu-anchor">
                <button
                  type="button"
                  className="nt-mail-list-toolbar__action"
                  aria-label="推迟选中邮件"
                  title="推迟通知"
                  aria-haspopup="dialog"
                  aria-expanded={mailListSnoozeMenuOpen}
                  aria-controls="mail-list-snooze-panel"
                  data-nonmodal-trigger="mail-list-snooze"
                  onClick={() => {
                    const nextOpen = !mailListSnoozeMenuOpen;
                    closeMailListToolbarMenus();
                    setMailListSnoozeMenuOpen(nextOpen);
                  }}
                  disabled={busy}
                >
                  <MailListToolbarIcon kind="clock" />
                </button>
                {renderMailListSnoozeMenu()}
              </div>
            </div>
          ) : displayedMailMessages.length > 0 ? (
            <>
              <div className="nt-mail-list-toolbar__menu-anchor">
                <button
                  type="button"
                  className="nt-mail-list-toolbar__action nt-mail-list-toolbar__action--more"
                  aria-label="更多邮箱操作"
                  title="更多"
                  aria-haspopup="menu"
                  aria-expanded={mailListBulkMenuOpen}
                  aria-controls="mail-list-more-menu"
                  data-nonmodal-trigger="mail-list-more"
                  onClick={() => {
                    const nextOpen = !mailListBulkMenuOpen;
                    closeMailListToolbarMenus();
                    setMailListBulkMenuOpen(nextOpen);
                  }}
                  disabled={busy || displayedMailMessages.length === 0}
                >
                  <MailListToolbarIcon kind="more" />
                </button>
                {renderMailListMoreMenu()}
              </div>
            </>
          ) : null}
        </div>

        {visibleMailMessages.length > 0 ||
        mailListReadFilter !== "all" ||
        mailListHasAttachmentOnly ? (
        <div className="nt-mail-list-toolbar__right">
          <button
            type="button"
            className={`nt-mail-list-toolbar__unread-toggle ${
              mailListReadFilter === "unread" ? "nt-mail-list-toolbar__unread-toggle--active" : ""
            }`}
            aria-label="只显示未读邮件"
            aria-pressed={mailListReadFilter === "unread"}
            onClick={toggleMailListUnreadOnly}
          >
            <span className="nt-mail-list-toolbar__unread-check" aria-hidden="true">
              {mailListReadFilter === "unread" ? "✓" : ""}
            </span>
            未读
          </button>
          <div className="nt-mail-list-toolbar__menu-anchor">
            <button
              type="button"
              className="nt-mail-list-toolbar__filter"
              aria-label="打开列表筛选"
              aria-haspopup="menu"
              aria-expanded={mailListFilterMenuOpen}
              aria-controls="mail-list-filter-menu"
              data-nonmodal-trigger="mail-list-filter"
              onClick={() => {
                const nextOpen = !mailListFilterMenuOpen;
                closeMailListToolbarMenus();
                setMailListFilterMenuOpen(nextOpen);
              }}
            >
              <MailListToolbarIcon kind="filter" />
              <span className="nt-mail-list-toolbar__filter-label">筛选器</span>
            </button>
            {renderMailListFilterMenu()}
          </div>
    <div className="nt-mail-list-toolbar__pager" aria-label="邮件列表分页">
            <button
              type="button"
        aria-label="上一页邮件"
              onClick={() => goToMailListPage(clampedMailListCurrentPage - 1)}
              disabled={clampedMailListCurrentPage === 0}
            >
              <MailListToolbarIcon kind="chevron-left" />
            </button>
            <span>
              {displayedMailConversations.length === 0
                ? "0/0"
                : `${mailListPageStart + 1}-${mailListPageEnd}/${displayedMailConversations.length}`}
            </span>
            <button
              type="button"
        aria-label="下一页邮件"
              onClick={() => goToMailListPage(clampedMailListCurrentPage + 1)}
              disabled={clampedMailListCurrentPage >= mailListTotalPages - 1}
            >
              <MailListToolbarIcon kind="chevron-right" />
            </button>
          </div>
        </div>
        ) : null}
      </div>
    </div>
  );
}
