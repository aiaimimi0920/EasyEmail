import type { CSSProperties } from "react";
import { MailListToolbarIcon, SearchMagnifierIcon } from "../components/AppIcons";
import type { AppState } from "./useAppState";

type Dependencies = {
  localLabelOptions: import("../api/mailTaxonomyClient").MailTaxonomyItemDto[];
  closeMailListToolbarMenus: () => void;
  createMailTaxonomyItem: (kind: import("../api/mailTaxonomyClient").MailTaxonomyKind) => void;
  toggleMailListLabelDraft: (labelId: string) => void;
  applyMailListLabelDraft: () => Promise<void>;
  snoozeSelectedMailMessages: (label: string) => Promise<void>;
  setMailListReadFilterAndClose: (nextFilter: import("./appTypes").MailListReadFilter) => void;
  setMailListSortModeAndClose: (nextSortMode: import("../mail/mailSelectors").MailListSortMode) => void;
};

export function useMailListFilterMenus(appState: AppState, dependencies: Dependencies) {
  const {
    mailListLabelMenuOpen, mailListLabelSearch, setMailListLabelSearch, mailListLabelDraftIds, mailListLabelArchiveAfterApply, setMailListLabelArchiveAfterApply, busy, mailListSnoozeMenuOpen,
    mailListFilterMenuOpen, mailListReadFilter, mailListHasAttachmentOnly, setMailListHasAttachmentOnly, setMailListFilterMenuOpen, mailListSortMode,
  } = appState;
  const {
    localLabelOptions, closeMailListToolbarMenus, createMailTaxonomyItem, toggleMailListLabelDraft, applyMailListLabelDraft, snoozeSelectedMailMessages, setMailListReadFilterAndClose, setMailListSortModeAndClose,
  } = dependencies;
  function renderMailListLabelMenu() {
      if (!mailListLabelMenuOpen) {
        return null;
      }

      const normalizedLabelSearch = mailListLabelSearch.trim().toLowerCase();
      const filteredLocalLabelOptions = localLabelOptions.filter((label) =>
        normalizedLabelSearch ? label.name.toLowerCase().includes(normalizedLabelSearch) : true,
      );

      return (
        <div
          id="mail-list-label-panel"
          className="nt-mail-list-toolbar__panel nt-mail-list-toolbar__panel--label"
          role="dialog"
          aria-label="为选中邮件添加标签"
          data-nonmodal-layer="mail-list-label"
        >
          <div className="nt-mail-list-toolbar__panel-head">
            <strong>加标签</strong>
            <button
              type="button"
              className="nt-mail-list-toolbar__create"
              aria-label="新建标签"
              onClick={() => {
                closeMailListToolbarMenus();
                createMailTaxonomyItem("label");
              }}
            >
              <MailListToolbarIcon kind="label" />
              <span>+</span>
            </button>
          </div>
          <label className="nt-mail-list-toolbar__panel-search">
            <SearchMagnifierIcon />
            <input
              data-nonmodal-initial-focus
              value={mailListLabelSearch}
              placeholder="搜索标签"
              aria-label="搜索标签"
              onChange={(event) => setMailListLabelSearch(event.currentTarget.value)}
            />
          </label>
          <div className="nt-mail-list-toolbar__panel-options" role="group" aria-label="标签选项">
            {filteredLocalLabelOptions.length === 0 ? (
              <div
                className="nt-mail-list-toolbar__empty"
                role="status"
                aria-live="polite"
                data-empty-state
              >
                暂无匹配标签
              </div>
            ) : (
              filteredLocalLabelOptions.map((label) => {
                const checked = mailListLabelDraftIds.includes(label.id);
                return (
                  <button
                    type="button"
                    key={label.id}
                    className={`nt-mail-list-toolbar__panel-option ${
                      checked ? "nt-mail-list-toolbar__panel-option--active" : ""
                    }`}
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => toggleMailListLabelDraft(label.id)}
                  >
                    <span className="nt-mail-list-toolbar__checkbox" aria-hidden="true">
                      {checked ? "✓" : ""}
                    </span>
                    <span
                      className="nt-mail-list-toolbar__menu-color"
                      style={{ "--taxonomy-color": label.color } as CSSProperties}
                      aria-hidden="true"
                    />
                    <span>{label.name}</span>
                  </button>
                );
              })
            )}
          </div>
          <label className="nt-mail-list-toolbar__option-check">
            <input
              type="checkbox"
              checked={mailListLabelArchiveAfterApply}
              onChange={(event) => setMailListLabelArchiveAfterApply(event.currentTarget.checked)}
            />
            <span>同时归档</span>
          </label>
          <button
            type="button"
            className="nt-mail-list-toolbar__apply"
            onClick={() => void applyMailListLabelDraft()}
            disabled={busy}
          >
            应用
          </button>
        </div>
      );
    }
  function renderMailListSnoozeMenu() {
      if (!mailListSnoozeMenuOpen) {
        return null;
      }

      return (
        <div
          id="mail-list-snooze-panel"
          className="nt-mail-list-toolbar__panel nt-mail-list-toolbar__panel--snooze"
          role="dialog"
          aria-label="推迟选中邮件"
          data-nonmodal-layer="mail-list-snooze"
        >
          <div className="nt-mail-list-toolbar__snooze-head">
            <strong>推迟邮件通知</strong>
            <span>您希望此邮件何时重新出现在您的收件箱中?</span>
          </div>
          <button type="button" className="nt-mail-list-toolbar__snooze-row" onClick={() => void snoozeSelectedMailMessages("明天上午 9:00")}>
            <span>明天</span>
            <span>上午 9:00</span>
          </button>
          <button type="button" className="nt-mail-list-toolbar__snooze-row" onClick={() => void snoozeSelectedMailMessages("本周末上午 9:00")}>
            <span>本周末</span>
            <span>周六 上午 9:00</span>
          </button>
          <button type="button" className="nt-mail-list-toolbar__snooze-row" onClick={() => void snoozeSelectedMailMessages("下一周上午 9:00")}>
            <span>下一周</span>
            <span>周一 上午 9:00</span>
          </button>
          <button type="button" className="nt-mail-list-toolbar__snooze-custom" onClick={() => void snoozeSelectedMailMessages("自定义时间")}>
            <span>请选择日期与时间</span>
            <span className="nt-mail-list-toolbar__snooze-plus">
              <MailListToolbarIcon kind="mark-read" />
              +
            </span>
          </button>
        </div>
      );
    }
  function renderMailListFilterMenu() {
      if (!mailListFilterMenuOpen) {
        return null;
      }

      return (
        <div
          id="mail-list-filter-menu"
          className="nt-mail-list-toolbar__menu nt-mail-list-toolbar__menu--filter"
          role="menu"
          aria-label="筛选和排序"
          data-nonmodal-layer="mail-list-filter"
        >
          <strong>筛选</strong>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mailListReadFilter === "unread"}
            className={mailListReadFilter === "unread" ? "nt-mail-list-toolbar__menu-item--active" : ""}
            onClick={() => setMailListReadFilterAndClose("unread")}
          >
            未读
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mailListReadFilter === "read"}
            className={mailListReadFilter === "read" ? "nt-mail-list-toolbar__menu-item--active" : ""}
            onClick={() => setMailListReadFilterAndClose("read")}
          >
            已读
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={mailListHasAttachmentOnly}
            className={mailListHasAttachmentOnly ? "nt-mail-list-toolbar__menu-item--active" : ""}
            onClick={() => {
              setMailListHasAttachmentOnly((current) => !current);
              setMailListFilterMenuOpen(false);
            }}
          >
            包含附件
          </button>
          <span className="nt-mail-list-toolbar__divider" role="separator" />
          <strong>排序</strong>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mailListSortMode === "newest"}
            className={mailListSortMode === "newest" ? "nt-mail-list-toolbar__menu-item--active" : ""}
            onClick={() => setMailListSortModeAndClose("newest")}
          >
            从新到旧
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mailListSortMode === "oldest"}
            className={mailListSortMode === "oldest" ? "nt-mail-list-toolbar__menu-item--active" : ""}
            onClick={() => setMailListSortModeAndClose("oldest")}
          >
            从旧到新
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mailListSortMode === "largest"}
            className={mailListSortMode === "largest" ? "nt-mail-list-toolbar__menu-item--active" : ""}
            onClick={() => setMailListSortModeAndClose("largest")}
          >
            从大到小
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mailListSortMode === "smallest"}
            className={mailListSortMode === "smallest" ? "nt-mail-list-toolbar__menu-item--active" : ""}
            onClick={() => setMailListSortModeAndClose("smallest")}
          >
            从小到大
          </button>
        </div>
      );
    }
  return {
    renderMailListLabelMenu, renderMailListSnoozeMenu, renderMailListFilterMenu,
  };
}

export type UseMailListFilterMenusResult = ReturnType<typeof useMailListFilterMenus>;
