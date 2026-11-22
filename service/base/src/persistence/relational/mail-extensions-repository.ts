import type { DatabaseSync } from "node:sqlite";

import {
  computeNewsletterSubscriptionId,
  deriveNewsletterDisplayName,
  normalizeNewsletterListId,
  type MailExtensionsRepository,
  type MailNewsletterSubscription,
} from "../../domain/mail-extensions.js";
import { parseStringArrayJson } from "./mail-message-row-mapper.js";

interface RawNewsletterMessageRow {
  from_address: string;
  from_name: string | null;
  observed_at: string;
  classification: string;
  newsletter_list_id: string | null;
  newsletter_unsubscribe_json: string;
  is_read: number;
  local_folder: string;
  labels_json: string;
}

export class SqliteMailExtensionsRepository implements MailExtensionsRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public async listNewsletterSubscriptions(
    accountId: string,
  ): Promise<MailNewsletterSubscription[]> {
    const trimmedAccountId = accountId.trim();
    if (!trimmedAccountId) return [];

    const rows = this.database.prepare(`
      SELECT
        m.from_address AS from_address,
        m.from_name AS from_name,
        m.observed_at AS observed_at,
        m.classification AS classification,
        m.newsletter_list_id AS newsletter_list_id,
        m.newsletter_unsubscribe_json AS newsletter_unsubscribe_json,
        s.is_read AS is_read,
        s.local_folder AS local_folder,
        s.labels_json AS labels_json
      FROM mail_messages m
      INNER JOIN mail_message_sources s ON s.message_id = m.id
      WHERE s.account_id = ?
        AND m.deleted_at IS NULL
        AND (
          m.classification = 'newsletter'
          OR EXISTS (
            SELECT 1
            FROM json_each(s.labels_json) lbl
            WHERE lower(trim(CAST(lbl.value AS TEXT))) = 'newsletters'
          )
        )
      ORDER BY m.observed_at DESC, m.id DESC
    `).all(trimmedAccountId) as unknown as RawNewsletterMessageRow[];

    const grouped = new Map<string, MailNewsletterSubscription>();

    for (const row of rows) {
      const labels = parseStringArrayJson(row.labels_json);
      const isNewsletter =
        row.classification === "newsletter"
        || labels.some((label) => label.toLowerCase() === "newsletters");
      if (!isNewsletter) continue;

      const senderAddress = row.from_address.trim();
      const listId = normalizeNewsletterListId(row.newsletter_list_id);
      const subscriptionId = computeNewsletterSubscriptionId(listId, senderAddress);
      if (!subscriptionId) continue;

      const unsubscribeMethods = parseStringArrayJson(row.newsletter_unsubscribe_json);
      const isSpam = row.local_folder.trim().toLowerCase() === "spam";

      let entry = grouped.get(subscriptionId);
      if (!entry) {
        entry = {
          id: subscriptionId,
          listId,
          senderAddress,
          name: deriveNewsletterDisplayName(row.from_name, listId, senderAddress),
          receivedMessageCount: 0,
          unreadMessageCount: 0,
          lastReceivedAt: row.observed_at,
          unsubscribeMethods: [],
          spam: false,
          hidden: false,
        };
        grouped.set(subscriptionId, entry);
      }

      entry.receivedMessageCount += 1;
      if (row.is_read === 0) {
        entry.unreadMessageCount += 1;
      }
      if (row.observed_at > entry.lastReceivedAt) {
        entry.lastReceivedAt = row.observed_at;
      }
      if (isSpam) {
        entry.spam = true;
      }
      for (const method of unsubscribeMethods) {
        if (!entry.unsubscribeMethods.some((existing) => existing.toLowerCase() === method.toLowerCase())) {
          entry.unsubscribeMethods.push(method);
        }
      }
    }

    const hiddenRows = this.database.prepare(`
      SELECT subscription_key
      FROM mail_newsletter_subscription_overrides
      WHERE account_id = ? AND hidden != 0
    `).all(trimmedAccountId) as unknown as Array<{ subscription_key: string }>;
    const hiddenSet = new Set(hiddenRows.map((item) => item.subscription_key));

    const subscriptions = [...grouped.values()].map((item) => ({
      ...item,
      hidden: hiddenSet.has(item.id),
    }));

    subscriptions.sort((left, right) => {
      if (left.lastReceivedAt !== right.lastReceivedAt) {
        return right.lastReceivedAt.localeCompare(left.lastReceivedAt);
      }
      return left.id.localeCompare(right.id);
    });

    return subscriptions;
  }

  public async setNewsletterSubscriptionHidden(
    accountId: string,
    subscriptionId: string,
    hidden: boolean,
    now: string,
  ): Promise<boolean> {
    const trimmedAccountId = accountId.trim();
    const trimmedSubId = subscriptionId.trim();
    if (!trimmedAccountId || !trimmedSubId || trimmedSubId.length > 1024) {
      return false;
    }

    const current = await this.listNewsletterSubscriptions(trimmedAccountId);
    if (!current.some((item) => item.id === trimmedSubId)) {
      return false;
    }

    const result = this.database.prepare(`
      INSERT INTO mail_newsletter_subscription_overrides (
        account_id, subscription_key, hidden, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, subscription_key) DO UPDATE SET
        hidden = excluded.hidden,
        updated_at = excluded.updated_at
    `).run(trimmedAccountId, trimmedSubId, hidden ? 1 : 0, now);

    return Number(result.changes) > 0;
  }

  public async getClientSetting(settingKey: string): Promise<string | undefined> {
    const row = this.database.prepare(`
      SELECT setting_value FROM mail_client_settings WHERE setting_key = ? LIMIT 1
    `).get(settingKey.trim()) as { setting_value: string | null } | undefined;
    return row?.setting_value ?? undefined;
  }

  public async setClientSetting(
    settingKey: string,
    settingValue: string | null,
    now: string,
  ): Promise<void> {
    this.database.prepare(`
      INSERT INTO mail_client_settings (setting_key, setting_value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at = excluded.updated_at
    `).run(settingKey.trim(), settingValue, now);
  }
}
