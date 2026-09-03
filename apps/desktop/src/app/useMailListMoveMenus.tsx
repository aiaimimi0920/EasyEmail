import type { CSSProperties } from "react";
import { MailListToolbarIcon, SearchMagnifierIcon } from "../components/AppIcons";
import type { MailListPrimaryMoveAction } from "./appTypes";
import type { AppState } from "./useAppState";

type Dependencies = {
  moveSelectedMailMessages: (folderName: string) => Promise<void>;
  trashSelectedMailMessages: () => Promise<void>;
  archiveSelectedMailMessages: () => Promise<void>;
  deleteSelectedMailMessagesForever: () => Promise<void>;
  toggleSelectAllVisibleMailMessages: () => void;
  allVisibleMailMessagesSelected: boolean;
  replaceSelectionFromPredicate: (predicate: (message: import("./appTypes").VisibleMailMessage) => boolean) => void;
  clearMailMessageSelection: () => void;
  moveAllDisplayedMailMessagesToTrash: () => Promise<void>;
  archiveAllDisplayedMailMessages: () => Promise<void>;
  localFolderOptions: import("../api/mailTaxonomyClient").MailTaxonomyItemDto[];
  closeMailListToolbarMenus: () => void;
  createMailTaxonomyItem: (kind: import("../api/mailTaxonomyClient").MailTaxonomyKind) => void;
  applyMailListMoveTarget: () => Promise<void>;
};

export function useMailListMoveMenus(appState: AppState, dependencies: Dependencies) {
  const {
    busy, mailListSelectionMenuOpen, mailListBulkMenuOpen, mailListMoveMenuOpen, mailListMoveSearch, setMailListMoveSearch, mailListMoveTarget, setMailListMoveTarget,
  } = appState;
  const {
    moveSelectedMailMessages, trashSelectedMailMessages, archiveSelectedMailMessages, deleteSelectedMailMessagesForever, toggleSelectAllVisibleMailMessages, allVisibleMailMessagesSelected, replaceSelectionFromPredicate, clearMailMessageSelection,
    moveAllDisplayedMailMessagesToTrash, archiveAllDisplayedMailMessages, localFolderOptions, closeMailListToolbarMenus, createMailTaxonomyItem, applyMailListMoveTarget,
  } = dependencies;
  function renderMailListPrimaryMoveAction(action: MailListPrimaryMoveAction) {
      const config: Record<
        MailListPrimaryMoveAction,
        {
          icon: "inbox" | "trash" | "archive" | "spam" | "nospam" | "delete";
          ariaLabel: string;
          title: string;
          run: () => void;
        }
      > = {
        inbox: {
          icon: "inbox",
          ariaLabel: "将选中邮件移至收件箱",
          title: "移至收件箱",
          run: () => void moveSelectedMailMessages("inbox"),
        },
        trash: {
          icon: "trash",
          ariaLabel: "将选中邮件移至回收站",
          title: "移至回收站",
          run: () => void trashSelectedMailMessages(),
        },
        archive: {
          icon: "archive",
          ariaLabel: "归档选中邮件",
          title: "归档",
          run: () => void archiveSelectedMailMessages(),
        },
        spam: {
          icon: "spam",
          ariaLabel: "将选中邮件移至垃圾邮件",
          title: "移至垃圾邮件",
          run: () => void moveSelectedMailMessages("spam"),
        },
        nospam: {
          icon: "nospam",
          ariaLabel: "将选中邮件移出垃圾邮件",
          title: "不是垃圾邮件",
          run: () => void moveSelectedMailMessages("inbox"),
        },
        delete: {
          icon: "delete",
          ariaLabel: "永久删除选中邮件",
          title: "彻底删除",
          run: () => void deleteSelectedMailMessagesForever(),
        },
      };
      const item = config[action];

      return (
        <button
          type="button"
          key={action}
          className="nt-mail-list-toolbar__action"
          aria-label={item.ariaLabel}
          title={item.title}
          onClick={item.run}
          disabled={busy}
        >
          <MailListToolbarIcon kind={item.icon} />
        </button>
      );
    }
  function renderMailListSelectionMenu() {
      if (!mailListSelectionMenuOpen) {
        return null;
      }

      return (
        <div
          id="mail-list-selection-menu"
          className="nt-mail-list-toolbar__menu nt-mail-list-toolbar__menu--selection"
          role="menu"
          aria-label="选择邮件"
          data-nonmodal-layer="mail-list-selection"
        >
          <button type="button" role="menuitem" onClick={toggleSelectAllVisibleMailMessages}>
            {allVisibleMailMessagesSelected ? "取消本页全选" : "全选"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => replaceSelectionFromPredicate((message) => !message.is_read)}
          >
            所有未读邮件
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => replaceSelectionFromPredicate((message) => message.is_read)}
          >
            所有已读邮件
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => replaceSelectionFromPredicate((message) => message.is_starred)}
          >
            所有星标邮件
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => replaceSelectionFromPredicate((message) => !message.is_starred)}
          >
            所有非星标邮件
          </button>
          <button type="button" role="menuitem" onClick={clearMailMessageSelection}>
            清空选择
          </button>
        </div>
      );
    }
  function renderMailListMoreMenu() {
      if (!mailListBulkMenuOpen) {
        return null;
      }

      return (
        <div
          id="mail-list-more-menu"
          className="nt-mail-list-toolbar__menu nt-mail-list-toolbar__menu--more"
          role="menu"
          aria-label="更多邮箱操作"
          data-nonmodal-layer="mail-list-more"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => void moveAllDisplayedMailMessagesToTrash()}
            disabled={busy}
          >
            <MailListToolbarIcon kind="trash" />
            全部移至回收站
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void archiveAllDisplayedMailMessages()}
            disabled={busy}
          >
            <MailListToolbarIcon kind="archive" />
            全部归档
          </button>
        </div>
      );
    }
  function renderMailListMoveMenu() {
      if (!mailListMoveMenuOpen) {
        return null;
      }

      const normalizedMoveSearch = mailListMoveSearch.trim().toLowerCase();
      const builtInMoveOptions: Array<{
        id: string;
        label: string;
        icon: "inbox" | "archive" | "spam" | "trash";
      }> = [
        { id: "inbox", label: "收件箱", icon: "inbox" },
        { id: "archive", label: "归档", icon: "archive" },
        { id: "spam", label: "垃圾邮件", icon: "spam" },
        { id: "trash", label: "移至回收站", icon: "trash" },
      ];
      const filteredBuiltInMoveOptions = builtInMoveOptions.filter((option) =>
        normalizedMoveSearch ? option.label.toLowerCase().includes(normalizedMoveSearch) : true,
      );
      const filteredCustomMoveOptions = localFolderOptions.filter((folder) =>
        normalizedMoveSearch ? folder.name.toLowerCase().includes(normalizedMoveSearch) : true,
      );

      return (
        <div
          id="mail-list-move-panel"
          className="nt-mail-list-toolbar__panel nt-mail-list-toolbar__panel--move"
          role="dialog"
          aria-label="移动选中邮件"
          data-nonmodal-layer="mail-list-move"
        >
          <div className="nt-mail-list-toolbar__panel-head">
            <strong>移动到</strong>
            <button
              type="button"
              className="nt-mail-list-toolbar__create"
              aria-label="新建文件夹"
              onClick={() => {
                closeMailListToolbarMenus();
                createMailTaxonomyItem("folder");
              }}
            >
              <MailListToolbarIcon kind="move" />
              <span>+</span>
            </button>
          </div>
          <label className="nt-mail-list-toolbar__panel-search">
            <SearchMagnifierIcon />
            <input
              data-nonmodal-initial-focus
              value={mailListMoveSearch}
              placeholder="搜索文件夹"
              aria-label="搜索文件夹"
              onChange={(event) => setMailListMoveSearch(event.currentTarget.value)}
            />
          </label>
          <div className="nt-mail-list-toolbar__panel-options" role="radiogroup" aria-label="移动目标">
            {filteredBuiltInMoveOptions.map((option) => (
              <button
                type="button"
                key={option.id}
                className={`nt-mail-list-toolbar__panel-option ${
                  mailListMoveTarget === option.id ? "nt-mail-list-toolbar__panel-option--active" : ""
                }`}
                role="radio"
                aria-checked={mailListMoveTarget === option.id}
                onClick={() => setMailListMoveTarget(option.id)}
              >
                <span className="nt-mail-list-toolbar__radio" aria-hidden="true" />
                <MailListToolbarIcon kind={option.icon} />
                <span>{option.label}</span>
              </button>
            ))}
            {filteredCustomMoveOptions.map((folder) => {
              const targetId = `folder:${folder.id}`;
              return (
                <button
                  type="button"
                  key={folder.id}
                  className={`nt-mail-list-toolbar__panel-option ${
                    mailListMoveTarget === targetId ? "nt-mail-list-toolbar__panel-option--active" : ""
                  }`}
                  role="radio"
                  aria-checked={mailListMoveTarget === targetId}
                  onClick={() => setMailListMoveTarget(targetId)}
                >
                  <span className="nt-mail-list-toolbar__radio" aria-hidden="true" />
                  <span
                    className="nt-mail-list-toolbar__menu-color"
                    style={{ "--taxonomy-color": folder.color } as CSSProperties}
                    aria-hidden="true"
                  />
                  <span>{folder.name}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="nt-mail-list-toolbar__apply"
            onClick={() => void applyMailListMoveTarget()}
            disabled={!mailListMoveTarget || busy}
          >
            应用
          </button>
        </div>
      );
    }
  return {
    renderMailListPrimaryMoveAction, renderMailListSelectionMenu, renderMailListMoreMenu, renderMailListMoveMenu,
  };
}

export type UseMailListMoveMenusResult = ReturnType<typeof useMailListMoveMenus>;
