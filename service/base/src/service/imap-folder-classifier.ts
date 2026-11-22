import type { MailImapFolderKind, MailImapRemoteFolder } from "../domain/mail-imap-sync.js";

function normalizeFolderToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/gu, "");
}

function matchesFolderAlias(token: string, aliases: readonly string[]): boolean {
  return aliases.some((alias) => {
    const normalized = normalizeFolderToken(alias);
    return token === normalized || token.endsWith(`/${normalized}`) || token.endsWith(`.${normalized}`) || token.endsWith(normalized);
  });
}

export function classifyImapFolderKind(
  path: string,
  specialUse?: string,
  flags?: Iterable<string>,
): MailImapFolderKind {
  const special = specialUse?.trim().toLowerCase() ?? "";
  const lowerFlags = flags ? new Set([...flags].map((flag) => flag.toLowerCase())) : undefined;

  if (special === "\\inbox" || lowerFlags?.has("\\inbox")) {
    return "inbox";
  }
  if (special === "\\archive" || special === "\\all" || lowerFlags?.has("\\archive")) {
    return "archive";
  }
  if (special === "\\junk" || special === "\\spam" || lowerFlags?.has("\\junk")) {
    return "spam";
  }
  if (special === "\\trash" || lowerFlags?.has("\\trash")) {
    return "trash";
  }
  if (special === "\\sent" || lowerFlags?.has("\\sent")) {
    return "sent";
  }
  if (special === "\\drafts" || lowerFlags?.has("\\drafts")) {
    return "drafts";
  }

  const token = normalizeFolderToken(path);
  if (token === "inbox" || token.endsWith("/inbox") || token.endsWith(".inbox") || token.endsWith("收件箱")) {
    return "inbox";
  }
  if (matchesFolderAlias(token, ["archive", "archives", "归档", "已归档"])) {
    return "archive";
  }
  if (matchesFolderAlias(token, ["spam", "junk", "junkemail", "垃圾邮件", "广告邮件"])) {
    return "spam";
  }
  if (
    matchesFolderAlias(token, [
      "trash",
      "deleted",
      "deletedmessages",
      "deleteditems",
      "bin",
      "已删除",
      "已删除邮件",
      "废件箱",
      "垃圾箱",
    ])
  ) {
    return "trash";
  }
  if (matchesFolderAlias(token, ["sent", "sentmessages", "sentitems", "已发送"])) {
    return "sent";
  }
  if (matchesFolderAlias(token, ["drafts", "draft", "草稿箱", "草稿"])) {
    return "drafts";
  }
  return "mail";
}

export function createDefaultInboxFolder(): MailImapRemoteFolder {
  return {
    providerFolderId: "INBOX",
    displayName: "INBOX",
    path: "INBOX",
    delimiter: "/",
    folderKind: "inbox",
    specialUse: "\\Inbox",
  };
}
