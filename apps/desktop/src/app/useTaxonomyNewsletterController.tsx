import type { FormEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type MailTaxonomyDeleteDto, type MailTaxonomyItemDto, type MailTaxonomyKind } from "../api/mailTaxonomyClient";
import { mailTaxonomyDefaultColor, mailTaxonomyItemMatchesName } from "../mail/mailTaxonomy";
import { asErrorDto } from "./appDomain";
import { mailTaxonomyClient, newsletterClient } from "./appRuntime";
import type { VisibleNewsletterSubscription } from "./appTypes";
import type { AppState } from "./useAppState";

type Dependencies = {
  invalidateMessageDetailRequest: () => void;
  closeMailMessageActionMenus: () => void;
  rememberModalReturnFocus: () => void;
  expandRail: () => void;
  showStatusToast: (message: string) => void;
  loadMailTaxonomyItems: (isCurrent?: () => boolean) => Promise<{ folders: import("../api/mailTaxonomyClient").MailTaxonomyItemDto[]; labels: import("../api/mailTaxonomyClient").MailTaxonomyItemDto[]; }>;
  reloadMailListsAfterLocalAction: () => Promise<void>;
  loadNewsletterSubscriptions: (accountId: string, isCurrent?: () => boolean) => Promise<import("../api/newsletterClient").NewsletterSubscriptionDto[]>;
  showCopyToast: (message: string) => void;
};

export function useTaxonomyNewsletterController(appState: AppState, dependencies: Dependencies) {
  const {
    setSelectedMailTaxonomyFilter, setMailTaxonomySectionExpanded, setMailboxView, setRailMode, setActiveView, setSelectedMailMessageId, setSelectedMailConversationKey, setSelectedMessageDetail,
    mailFolders, mailLabels, railCollapsed, mailTaxonomySectionExpanded, setMailTaxonomyEditingId, setMailTaxonomyDraftName, setMailTaxonomyDraftParentId, setMailTaxonomyDraftColor,
    setMailTaxonomyManagerKind, setPendingMailTaxonomyAutoOpenKind, mailTaxonomyManagerKind, mailTaxonomyDraftName, mailTaxonomyEditingId, mailTaxonomyDraftParentId, mailTaxonomyDraftColor, setError,
    selectedMailTaxonomyFilter, setSelectedNewsletterSubscription,
  } = appState;
  const {
    invalidateMessageDetailRequest, closeMailMessageActionMenus, rememberModalReturnFocus, expandRail, showStatusToast, loadMailTaxonomyItems, reloadMailListsAfterLocalAction, loadNewsletterSubscriptions,
    showCopyToast,
  } = dependencies;
  function selectMailTaxonomyItem(item: MailTaxonomyItemDto) {
      invalidateMessageDetailRequest();
      setSelectedMailTaxonomyFilter({ kind: item.kind, name: item.name });
      setMailTaxonomySectionExpanded((current) => ({
        ...current,
        [item.kind]: true,
      }));
      setMailboxView(item.kind === "folder" ? "folders" : "labels");
      setRailMode("mail");
      setActiveView("mail");
      setSelectedMailMessageId(null);
      setSelectedMailConversationKey(null);
      setSelectedMessageDetail(null);
      closeMailMessageActionMenus();
    }
  function mailTaxonomyKindLabel(kind: MailTaxonomyKind) {
      return kind === "folder" ? "文件夹" : "标签";
    }
  function mailTaxonomyItemsForKind(kind: MailTaxonomyKind) {
      return kind === "folder" ? mailFolders : mailLabels;
    }
  function isMailTaxonomyDrawerOpen(kind: MailTaxonomyKind) {
      return railCollapsed && mailTaxonomySectionExpanded[kind];
    }
  function resetMailTaxonomyDraft(kind: MailTaxonomyKind) {
      const existingItems = mailTaxonomyItemsForKind(kind);
      setMailTaxonomyEditingId(null);
      setMailTaxonomyDraftName("");
      setMailTaxonomyDraftParentId("");
      setMailTaxonomyDraftColor(mailTaxonomyDefaultColor(kind, existingItems.length));
    }
  function createMailTaxonomyItem(kind: MailTaxonomyKind) {
      rememberModalReturnFocus();
      setMailTaxonomySectionExpanded((current) => ({
        ...current,
        [kind]: true,
      }));
      setMailTaxonomyManagerKind(kind);
      resetMailTaxonomyDraft(kind);
    }
  function toggleMailTaxonomySection(kind: MailTaxonomyKind) {
      setMailTaxonomySectionExpanded((current) => {
        const nextExpanded = !current[kind];
        return kind === "folder"
          ? { folder: nextExpanded, label: false }
          : { folder: false, label: nextExpanded };
      });
    }
  function openMailTaxonomySectionFromIcon(kind: MailTaxonomyKind) {
      if (railCollapsed) {
        setPendingMailTaxonomyAutoOpenKind(kind);
        expandRail();
        return;
      }

      toggleMailTaxonomySection(kind);
    }
  function closeMailTaxonomyManager() {
      setMailTaxonomyManagerKind(null);
      setMailTaxonomyEditingId(null);
      setMailTaxonomyDraftName("");
      setMailTaxonomyDraftParentId("");
    }
  function editMailTaxonomyItem(item: MailTaxonomyItemDto) {
      rememberModalReturnFocus();
      setMailTaxonomyManagerKind(item.kind);
      setMailTaxonomyEditingId(item.id);
      setMailTaxonomyDraftName(item.name);
      setMailTaxonomyDraftParentId(item.kind === "folder" ? item.parent_id ?? "" : "");
      setMailTaxonomyDraftColor(item.color);
    }
  async function submitMailTaxonomyManager(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!mailTaxonomyManagerKind) {
        return;
      }
      const name = mailTaxonomyDraftName.trim();
      if (!name) {
        showStatusToast(`${mailTaxonomyKindLabel(mailTaxonomyManagerKind)}名称不能为空。`);
        return;
      }
      try {
        const item = mailTaxonomyEditingId
          ? await mailTaxonomyClient.updateMailTaxonomyItem({
              id: mailTaxonomyEditingId,
              name,
              parent_id:
                mailTaxonomyManagerKind === "folder" ? mailTaxonomyDraftParentId || null : null,
              color: mailTaxonomyDraftColor,
            })
          : await mailTaxonomyClient.upsertMailTaxonomyItem({
              kind: mailTaxonomyManagerKind,
              name,
              parent_id:
                mailTaxonomyManagerKind === "folder" ? mailTaxonomyDraftParentId || null : null,
              color: mailTaxonomyDraftColor,
            });
        await loadMailTaxonomyItems();
        if (mailTaxonomyEditingId) {
          await reloadMailListsAfterLocalAction();
        }
        selectMailTaxonomyItem(item);
        resetMailTaxonomyDraft(mailTaxonomyManagerKind);
        showStatusToast(
          mailTaxonomyEditingId
            ? `已更新${mailTaxonomyKindLabel(item.kind)} ${item.name}。`
            : `已创建${mailTaxonomyKindLabel(item.kind)} ${item.name}。`,
        );
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      }
    }
  async function deleteMailTaxonomyItem(item: MailTaxonomyItemDto) {
      const warning =
        item.kind === "folder"
          ? `删除文件夹“${item.name}”会把其中邮件移回 Inbox。`
          : `删除标签“${item.name}”会从所有邮件中移除此标签。`;
      if (!window.confirm(`${warning}\n\n确定继续？`)) {
        return;
      }
      try {
        const result: MailTaxonomyDeleteDto =
          await mailTaxonomyClient.deleteMailTaxonomyItem({ id: item.id });
        await loadMailTaxonomyItems();
        await reloadMailListsAfterLocalAction();
        if (
          selectedMailTaxonomyFilter?.kind === item.kind &&
          mailTaxonomyItemMatchesName(item, selectedMailTaxonomyFilter.name)
        ) {
          setSelectedMailTaxonomyFilter(null);
        }
        if (mailTaxonomyEditingId === item.id) {
          resetMailTaxonomyDraft(item.kind);
        }
        showStatusToast(
          result.changed
            ? `已删除${mailTaxonomyKindLabel(item.kind)} ${item.name}。`
            : `系统${mailTaxonomyKindLabel(item.kind)} ${item.name} 不能删除。`,
        );
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      }
    }
  function selectNewsletterSubscription(subscription: VisibleNewsletterSubscription) {
      setSelectedNewsletterSubscription((current) =>
        current?.accountId === subscription.account_id &&
        current.subscriptionId === subscription.id
          ? null
          : { accountId: subscription.account_id, subscriptionId: subscription.id },
      );
    }
  async function handleNewsletterSubscriptionHidden(
      subscription: VisibleNewsletterSubscription,
      hidden: boolean,
    ) {
      try {
        await newsletterClient.setNewsletterSubscriptionHidden({
          account_id: subscription.account_id,
          subscription_id: subscription.id,
          hidden,
        });
        await loadNewsletterSubscriptions(subscription.account_id);
        if (hidden) {
          setSelectedNewsletterSubscription((current) =>
            current?.accountId === subscription.account_id &&
            current.subscriptionId === subscription.id
              ? null
              : current,
          );
        }
        showStatusToast(hidden ? "Newsletter subscription hidden." : "Newsletter subscription restored.");
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      }
    }
  function normalizeNewsletterUnsubscribeMethod(method: string) {
      return method.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
    }
  async function handleNewsletterUnsubscribe(subscription: VisibleNewsletterSubscription) {
      const method = subscription.unsubscribe_methods
        .map(normalizeNewsletterUnsubscribeMethod)
        .find((value) => value.length > 0);
      if (!method) {
        showStatusToast("No unsubscribe method is available for this newsletter.");
        return;
      }

      try {
        if (/^https?:\/\//i.test(method) || /^mailto:/i.test(method)) {
          await openUrl(method);
          showStatusToast("Opened newsletter unsubscribe method.");
          return;
        }
        await navigator.clipboard.writeText(method);
        showCopyToast("Newsletter unsubscribe method copied.");
      } catch {
        try {
          await navigator.clipboard.writeText(method);
          showCopyToast("Newsletter unsubscribe method copied.");
        } catch {
          showStatusToast("Could not open or copy the unsubscribe method.");
        }
      }
    }
  async function copyVerificationCode(
      event: { stopPropagation: () => void },
      code: string,
    ) {
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(code);
        showCopyToast(`已复制 ${code}`);
      } catch {
        showCopyToast("复制失败");
      }
    }
  return {
    selectMailTaxonomyItem, mailTaxonomyKindLabel, mailTaxonomyItemsForKind, isMailTaxonomyDrawerOpen, resetMailTaxonomyDraft, createMailTaxonomyItem, toggleMailTaxonomySection, openMailTaxonomySectionFromIcon,
    closeMailTaxonomyManager, editMailTaxonomyItem, submitMailTaxonomyManager, deleteMailTaxonomyItem, selectNewsletterSubscription, handleNewsletterSubscriptionHidden, handleNewsletterUnsubscribe, copyVerificationCode,
  };
}

export type UseTaxonomyNewsletterControllerResult = ReturnType<typeof useTaxonomyNewsletterController>;
