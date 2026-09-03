import type { MailRailItem, MailSearchScopeOption } from "./appTypes";

export const COMPOSE_DRAFT_AUTOSAVE_MS = 5000;

export const COMPOSE_DRAFT_STORAGE_KEY = "easyemailam.composeDraft.v1";

export const TOAST_VISIBLE_MS = 3600;

export const TOAST_FADE_MS = 900;

export const MAIL_AUTO_SYNC_INTERVAL_MS = 120000;

export const MAIL_LIST_PAGE_SIZE = 20;

export const MAIL_RAIL_ITEMS: MailRailItem[] = [
  { id: "compose", label: "写邮件" },
  { id: "inbox", label: "收件箱" },
  { id: "drafts", label: "草稿" },
  { id: "sent", label: "已发送" },
  { id: "starred", label: "星标" },
  { id: "archive", label: "归档" },
  { id: "spam", label: "垃圾邮件" },
  { id: "trash", label: "回收站" },
  { id: "all-mail", label: "全部邮件" },
  { id: "newsletters", label: "订阅邮件" },
];

export const MAIL_SEARCH_PRIMARY_SCOPES: MailSearchScopeOption[] = [
  { id: "all-mail", label: "所有邮件", icon: "✉" },
  { id: "inbox", label: "收件箱", icon: "⌂" },
  { id: "drafts", label: "草稿", icon: "▤" },
  { id: "sent", label: "已发送", icon: "✈" },
];

export const MAIL_SEARCH_OTHER_SCOPES: MailSearchScopeOption[] = [
  { id: "all-mail", label: "所有邮件", icon: "✉" },
  { id: "inbox", label: "收件箱", icon: "⌂" },
  { id: "snoozed", label: "延迟通知", icon: "◴" },
  { id: "drafts", label: "草稿", icon: "▤" },
  { id: "scheduled", label: "定时延迟通知", icon: "✈" },
  { id: "sent", label: "已发送", icon: "✈" },
  { id: "starred", label: "星标邮件", icon: "☆" },
  { id: "archive", label: "归档", icon: "▱" },
  { id: "spam", label: "垃圾邮件", icon: "♨" },
];

export function formatRailBadgeCount(count: number | null): string | null {
  if (count === null || count <= 0) {
    return null;
  }
  return count > 99 ? "99+" : String(count);
}
