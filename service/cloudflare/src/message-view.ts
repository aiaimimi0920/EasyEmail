export interface MessageStateRow { id: string; isRead: number; starred: number; archived: number }
export const MESSAGE_SUMMARY = `m.id, m.mailbox_id AS mailboxId, m.sender, m.recipient, m.subject,
  m.received_at AS receivedAt, m.observed_at AS observedAt,
  m.is_read AS isRead, m.starred, m.archived`;

export function messageView<T extends MessageStateRow>(row: T) {
  const { isRead, starred, archived, ...content } = row;
  return { ...content, isRead: isRead === 1, starred: starred === 1, archived: archived === 1 };
}
