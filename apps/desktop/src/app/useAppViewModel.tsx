import type { CSSProperties } from "react";
import { useMemo } from "react";
import { buildMailRailCounts, filterVisibleMailMessagesForMailbox, normalizeMailToken } from "../mail/mailSelectors";
import { buildMailTaxonomyFolderTree, isMailTaxonomyFolderDescendant, mailTaxonomyItemMatchesName } from "../mail/mailTaxonomy";
import { MAIL_RAIL_ITEMS, formatRailBadgeCount } from "./appConfig";
import type { AppState } from "./useAppState";

type Dependencies = {
  visibleMailMessages: import("./appTypes").VisibleMailMessage[];
  selectMailTaxonomyItem: (item: import("../api/mailTaxonomyClient").MailTaxonomyItemDto) => void;
  senderAvatarFor: (sender: string) => import("../mail/senderAvatar").SenderAvatarDto | null;
};

export function useAppViewModel(appState: AppState, dependencies: Dependencies) {
  const {
    platformSession, platformAccountSignedIn, error, lastPlatformQuery, railMode, sendQueue, agentThreads, mailFolders,
    mailLabels, mailTaxonomyEditingId, mailboxView, selectedMailTaxonomyFilter, avatarEditor,
  } = appState;
  const {
    visibleMailMessages, selectMailTaxonomyItem, senderAvatarFor,
  } = dependencies;
  const platformAccount = platformSession?.account ?? null;
  const platformAccountInitial = platformAccount?.avatar_initial ?? "N";
  const platformAccountName = platformAccount?.display_name ?? "NMail 开发预览账户";
  const platformAccountEmail = platformAccount?.email ?? "dev.user@nmail.local";
  const platformAccountPopoverTitle = platformAccountSignedIn
      ? platformAccountName
      : "NMail 平台账户";
  const platformAccountPopoverEmail = platformAccountSignedIn
      ? platformAccountEmail
      : "当前未登录平台账户";
  const platformAccountMeta =
      !platformAccountSignedIn
        ? "已退出登录"
        : error !== null
        ? error.user_message
        : lastPlatformQuery !== null
          ? `最近查询：${lastPlatformQuery.resource} / ${lastPlatformQuery.status}`
          : platformSession === null
        ? "正在加载开发预览会话"
            : `开发预览 · ${platformSession.server_kind} / ${platformSession.auth_mode}`;
  const activeRailModeLabel = railMode === "mail" ? "Mail" : "Agent";
  const queueRailBadgeCount = sendQueue.filter((item) => item.status !== "sent").length;
  const agentRailBadgeCount = agentThreads.filter((thread) => thread.status === "needs_attention").length;
  const mailRailCounts = useMemo(() => buildMailRailCounts(visibleMailMessages), [visibleMailMessages]);
  const {
      mailFolderStats,
      mailLabelStats,
      mailFolderTreeItems,
      mailTaxonomyParentOptions,
    } = useMemo(() => {
      const folderStatsByKey = new Map<string, { total: number; unread: number }>();
      const labelStatsByKey = new Map<string, { total: number; unread: number }>();
      for (const message of visibleMailMessages) {
        const folderKey = normalizeMailToken(message.local_folder);
        const folderStats = folderStatsByKey.get(folderKey) ?? { total: 0, unread: 0 };
        folderStats.total += 1;
        if (!message.is_read) folderStats.unread += 1;
        folderStatsByKey.set(folderKey, folderStats);

        const messageLabelKeys = new Set(message.labels.map(normalizeMailToken));
        for (const labelKey of messageLabelKeys) {
          const labelStats = labelStatsByKey.get(labelKey) ?? { total: 0, unread: 0 };
          labelStats.total += 1;
          if (!message.is_read) labelStats.unread += 1;
          labelStatsByKey.set(labelKey, labelStats);
        }
      }
      const mailFolderStats = new Map(
        mailFolders.map((folder) => [
          folder.name,
          folderStatsByKey.get(normalizeMailToken(folder.name)) ?? { total: 0, unread: 0 },
        ] as const),
      );
      const mailLabelStats = new Map(
        mailLabels.map((labelItem) => [
          labelItem.name,
          labelStatsByKey.get(normalizeMailToken(labelItem.name)) ?? { total: 0, unread: 0 },
        ] as const),
      );
      const mailFolderTreeItems = buildMailTaxonomyFolderTree(mailFolders);
      const mailTaxonomyParentOptions = mailFolderTreeItems.filter(({ item }) => {
        if (!mailTaxonomyEditingId) {
          return true;
        }
        return (
          item.id !== mailTaxonomyEditingId &&
          !isMailTaxonomyFolderDescendant(mailFolders, item.id, mailTaxonomyEditingId)
        );
      });

      return {
        mailFolderStats,
        mailLabelStats,
        mailFolderTreeItems,
        mailTaxonomyParentOptions,
      };
    }, [
      mailFolders,
      mailLabels,
      mailTaxonomyEditingId,
      visibleMailMessages,
    ]);
  function renderMailTaxonomyFolderItems() {
      return mailFolderTreeItems.map(({ item: folder, depth }) => {
        const stats = mailFolderStats.get(folder.name);
        const active =
          mailboxView === "folders" &&
          selectedMailTaxonomyFilter?.kind === "folder" &&
          mailTaxonomyItemMatchesName(folder, selectedMailTaxonomyFilter.name);
        const badge = formatRailBadgeCount(stats?.unread ?? 0);
        return (
          <button
            key={folder.id}
            type="button"
            className={`nt-mail-taxonomy__item nt-mail-taxonomy__item--folder ${
              active ? "nt-mail-taxonomy__item--active" : ""
            }`}
            onClick={() => selectMailTaxonomyItem(folder)}
            title={folder.name}
            style={{ "--taxonomy-depth": depth } as CSSProperties}
          >
            <span
              className="nt-mail-taxonomy__folder-icon"
              style={{ "--taxonomy-color": folder.color } as CSSProperties}
              aria-hidden="true"
            />
            <span className="nt-mail-taxonomy__name nt-rail-text">{folder.name}</span>
            {badge ? <span className="nt-mail-taxonomy__badge">{badge}</span> : null}
          </button>
        );
      });
    }
  function renderMailTaxonomyLabelItems() {
      return mailLabels.map((labelItem) => {
        const stats = mailLabelStats.get(labelItem.name);
        const active =
          mailboxView === "labels" &&
          selectedMailTaxonomyFilter?.kind === "label" &&
          mailTaxonomyItemMatchesName(labelItem, selectedMailTaxonomyFilter.name);
        const badge = formatRailBadgeCount(stats?.unread ?? 0);
        return (
          <button
            key={labelItem.id}
            type="button"
            className={`nt-mail-taxonomy__item nt-mail-taxonomy__item--label ${
              active ? "nt-mail-taxonomy__item--active" : ""
            }`}
            onClick={() => selectMailTaxonomyItem(labelItem)}
            title={labelItem.name}
          >
            <span
              className="nt-mail-taxonomy__dot"
              style={{ "--taxonomy-color": labelItem.color } as CSSProperties}
              aria-hidden="true"
            />
            <span className="nt-mail-taxonomy__name nt-rail-text">{labelItem.name}</span>
            {badge ? <span className="nt-mail-taxonomy__badge">{badge}</span> : null}
          </button>
        );
      });
    }
  const selectedMailboxLabel =
      selectedMailTaxonomyFilter?.name ??
      (mailboxView === "folders" ? "Folders" : mailboxView === "labels" ? "Labels" : null) ??
      MAIL_RAIL_ITEMS.find((item) => item.id === mailboxView)?.label ??
      "Inbox";
  const agentRailBadge = formatRailBadgeCount(agentRailBadgeCount);
  const queueRailBadge = formatRailBadgeCount(queueRailBadgeCount);
  const trashMessageCount = useMemo(
      () => filterVisibleMailMessagesForMailbox(visibleMailMessages, "trash").length,
      [visibleMailMessages],
    );
  const localLabelOptions = mailLabels;
  const localFolderOptions = mailFolders;
  const avatarEditorAvatar = avatarEditor ? senderAvatarFor(avatarEditor.sender) : null;
  const avatarEditorHasCustomIcon = avatarEditorAvatar?.source_kind === "contact";
  return {
    platformAccountInitial, platformAccountName, platformAccountEmail, platformAccountPopoverTitle, platformAccountPopoverEmail, platformAccountMeta, activeRailModeLabel, queueRailBadgeCount,
    agentRailBadgeCount, mailRailCounts, mailFolderTreeItems, mailTaxonomyParentOptions, renderMailTaxonomyFolderItems, renderMailTaxonomyLabelItems, selectedMailboxLabel, agentRailBadge,
    queueRailBadge, trashMessageCount, localLabelOptions, localFolderOptions, avatarEditorAvatar, avatarEditorHasCustomIcon,
  };
}

export type UseAppViewModelResult = ReturnType<typeof useAppViewModel>;
