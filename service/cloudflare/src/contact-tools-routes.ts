import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { contactNameKey, defaultContactName } from "./contact-input";
import type { ContactRow } from "./contact-model";
import {
  detectContactDuplicateGroups,
  extractSenderContactCandidates,
  parseVCardContacts,
  planLosslessContactMerge,
  serializeContactsToVCard,
  type ContactDuplicateInput,
} from "../../base/src/domain/mail-contact-tools";

async function loadContactsWithAliases(env: Env, userId: string): Promise<ContactDuplicateInput[]> {
  const { results: rows } = await env.DB.prepare(
    "SELECT * FROM contacts WHERE user_id = ? AND deleted_at IS NULL ORDER BY name_key, email_address",
  )
    .bind(userId)
    .all<ContactRow>();
  let aliasRows: Array<{ alias_email: string; contact_id: string }> = [];
  try {
    const res = await env.DB.prepare("SELECT alias_email, contact_id FROM contact_aliases WHERE user_id = ?")
      .bind(userId)
      .all<{ alias_email: string; contact_id: string }>();
    aliasRows = res.results;
  } catch {
    aliasRows = [];
  }
  const byContact = new Map<string, string[]>();
  for (const a of aliasRows) {
    const arr = byContact.get(a.contact_id) ?? [];
    arr.push(a.alias_email);
    byContact.set(a.contact_id, arr);
  }
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    emailAddress: r.email_address,
    aliases: byContact.get(r.id) ?? [],
    notes: r.note ?? undefined,
    revision: r.version,
  }));
}

export const isContactToolsPath = (path: string) =>
  path === "/api/v1/contact-tools/duplicates" ||
  path === "/api/v1/contact-tools/merge" ||
  path === "/api/v1/contact-tools/vcard" ||
  path === "/api/v1/contact-tools/candidates";

export async function contactToolsRoute(request: Request, env: Env, identity: Identity): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === "/api/v1/contact-tools/duplicates" && request.method === "GET") {
    requireScope(identity, "contacts:read");
    const contacts = await loadContactsWithAliases(env, identity.userId);
    return json({ groups: detectContactDuplicateGroups(contacts) });
  }

  if (path === "/api/v1/contact-tools/merge" && request.method === "POST") {
    requireWriteScope(request, env, identity, "contacts:write");
    const body = await readJson(request);
    const primaryId = String(body.primaryContactId ?? "").trim();
    const secondaryIds = Array.isArray(body.secondaryContactIds)
      ? body.secondaryContactIds.map((v) => String(v).trim()).filter(Boolean)
      : [];
    if (!primaryId || secondaryIds.length === 0) throw new HttpError(400, "invalid_contact_request");
    const all = await loadContactsWithAliases(env, identity.userId);
    const primary = all.find((c) => c.id === primaryId);
    const secondaries = all.filter((c) => secondaryIds.includes(c.id));
    if (!primary || secondaries.length === 0) throw new HttpError(404, "not_found");

    const plan = planLosslessContactMerge(primary, secondaries);
    const now = unixNow();
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `UPDATE contacts SET display_name = ?, name_key = ?, note = ?, version = version + 1, updated_at = ?
         WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
      ).bind(
        plan.mergedDisplayName,
        contactNameKey(plan.mergedDisplayName),
        plan.mergedNotes || null,
        now,
        identity.userId,
        plan.primaryContactId,
      ),
    ];
    for (const secId of plan.secondaryContactIds) {
      statements.push(
        env.DB.prepare(
          `UPDATE contacts SET display_name = '', name_key = '', email_address = '', note = NULL,
           version = version + 1, updated_at = ?, deleted_at = ?
           WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
        ).bind(now, now, identity.userId, secId),
      );
      statements.push(
        env.DB.prepare("DELETE FROM contact_aliases WHERE user_id = ? AND contact_id = ?").bind(
          identity.userId,
          secId,
        ),
      );
    }
    for (const aliasEmail of plan.mergedAliases) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO contact_aliases (user_id, alias_email, contact_id, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, alias_email) DO UPDATE SET contact_id = excluded.contact_id`,
        ).bind(identity.userId, aliasEmail, plan.primaryContactId, now),
      );
    }
    await env.DB.batch(statements);
    return json({ merged: plan });
  }

  if (path === "/api/v1/contact-tools/vcard" && request.method === "GET") {
    requireScope(identity, "contacts:read");
    const contacts = await loadContactsWithAliases(env, identity.userId);
    const vcf = serializeContactsToVCard(
      contacts.map((c) => ({
        displayName: c.displayName,
        emailAddress: c.emailAddress,
        aliases: [...(c.aliases ?? [])],
        notes: c.notes,
      })),
    );
    return json({ vcf, count: contacts.length });
  }

  if (path === "/api/v1/contact-tools/vcard" && request.method === "POST") {
    requireWriteScope(request, env, identity, "contacts:write");
    const body = await readJson(request);
    const rawVcf = String(body.vcf ?? "");
    const entries = parseVCardContacts(rawVcf, 200);
    if (entries.length === 0) throw new HttpError(400, "invalid_vcard_payload");
    const now = unixNow();
    const statements: D1PreparedStatement[] = [];
    for (const entry of entries) {
      const id = crypto.randomUUID();
      const name = entry.displayName || defaultContactName(entry.emailAddress);
      const noteParts = [entry.organization, entry.title, entry.phone, entry.notes].filter(Boolean).join(" · ");
      statements.push(
        env.DB.prepare(
          `INSERT INTO contacts (user_id, id, display_name, name_key, email_address, note, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(user_id, email_address) WHERE deleted_at IS NULL DO UPDATE SET
             display_name = excluded.display_name,
             name_key = excluded.name_key,
             note = COALESCE(excluded.note, contacts.note),
             version = contacts.version + 1,
             updated_at = excluded.updated_at`,
        ).bind(identity.userId, id, name, contactNameKey(name), entry.emailAddress, noteParts || null, now, now),
      );
    }
    await env.DB.batch(statements);
    return json({ importedCount: entries.length }, 201);
  }

  if (path === "/api/v1/contact-tools/candidates" && request.method === "GET") {
    requireScope(identity, "contacts:read");
    const contacts = await loadContactsWithAliases(env, identity.userId);
    const existing = new Set<string>();
    for (const c of contacts) {
      existing.add(c.emailAddress.toLowerCase());
      for (const a of c.aliases ?? []) existing.add(a.toLowerCase());
    }
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT m.sender FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
       WHERE b.user_id = ? AND m.purged_at IS NULL ORDER BY m.observed_at DESC LIMIT 100`,
    )
      .bind(identity.userId)
      .all<{ sender: string }>();
    return json({ candidates: extractSenderContactCandidates(results.map((r) => r.sender), existing) });
  }

  throw new HttpError(405, "method_not_allowed");
}
