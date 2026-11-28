export interface ContactDuplicateInput {
  id: string;
  displayName: string;
  emailAddress: string;
  aliases?: readonly string[];
  notes?: string;
  revision?: number;
}

export interface ContactDuplicateGroup {
  groupKey: string;
  reason: "canonical_plus_alias" | "same_display_name";
  canonicalKey: string;
  memberIds: string[];
  members: ContactDuplicateInput[];
}

export interface ContactMergePlan {
  primaryContactId: string;
  secondaryContactIds: string[];
  mergedDisplayName: string;
  primaryEmailAddress: string;
  mergedAliases: string[];
  mergedNotes: string;
}

export interface VCardContactEntry {
  displayName: string;
  emailAddress: string;
  aliases: string[];
  organization?: string;
  title?: string;
  phone?: string;
  notes?: string;
}

export function canonicalizePlusAliasEmail(rawEmail: string): string {
  const cleaned = rawEmail.trim().toLowerCase();
  const atIndex = cleaned.lastIndexOf("@");
  if (atIndex <= 0) return cleaned;
  const local = cleaned.slice(0, atIndex);
  const domain = cleaned.slice(atIndex + 1);
  const plusIndex = local.indexOf("+");
  const baseLocal = plusIndex > 0 ? local.slice(0, plusIndex) : local;
  const normalizedLocal = domain === "gmail.com" || domain === "googlemail.com"
    ? baseLocal.replace(/\./g, "")
    : baseLocal;
  return `${normalizedLocal}@${domain === "googlemail.com" ? "gmail.com" : domain}`;
}

function normalizeDisplayNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function detectContactDuplicateGroups(contacts: readonly ContactDuplicateInput[]): ContactDuplicateGroup[] {
  const byAlias = new Map<string, ContactDuplicateInput[]>();
  for (const contact of contacts) {
    const allEmails = [contact.emailAddress, ...(contact.aliases ?? [])].filter(Boolean);
    for (const email of allEmails) {
      const key = canonicalizePlusAliasEmail(email);
      if (!key) continue;
      const bucket = byAlias.get(key) ?? [];
      if (!bucket.some((item) => item.id === contact.id)) bucket.push(contact);
      byAlias.set(key, bucket);
    }
  }

  const groups: ContactDuplicateGroup[] = [];
  const groupedPairIds = new Set<string>();

  for (const [canonicalKey, members] of byAlias.entries()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => a.id.localeCompare(b.id));
    const memberIds = sorted.map((m) => m.id);
    const sig = memberIds.join(",");
    groupedPairIds.add(sig);
    groups.push({
      groupKey: `alias:${canonicalKey}:${sig}`,
      reason: "canonical_plus_alias",
      canonicalKey,
      memberIds,
      members: sorted,
    });
  }

  const byName = new Map<string, ContactDuplicateInput[]>();
  for (const contact of contacts) {
    const nameKey = normalizeDisplayNameKey(contact.displayName);
    if (!nameKey || nameKey.includes("@") || nameKey.length < 2) continue;
    const bucket = byName.get(nameKey) ?? [];
    bucket.push(contact);
    byName.set(nameKey, bucket);
  }

  for (const [nameKey, members] of byName.entries()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => a.id.localeCompare(b.id));
    const memberIds = sorted.map((m) => m.id);
    const sig = memberIds.join(",");
    if (groupedPairIds.has(sig)) continue;
    groups.push({
      groupKey: `name:${nameKey}:${sig}`,
      reason: "same_display_name",
      canonicalKey: nameKey,
      memberIds,
      members: sorted,
    });
  }

  return groups;
}

export function planLosslessContactMerge(
  primary: ContactDuplicateInput,
  secondaries: readonly ContactDuplicateInput[],
): ContactMergePlan {
  const primaryEmail = primary.emailAddress.trim().toLowerCase();
  const aliasSet = new Set<string>();
  for (const alias of primary.aliases ?? []) {
    const low = alias.trim().toLowerCase();
    if (low && low !== primaryEmail) aliasSet.add(low);
  }
  const noteParts: string[] = primary.notes?.trim() ? [primary.notes.trim()] : [];
  let displayName = primary.displayName.trim();

  for (const sec of secondaries) {
    if (sec.id === primary.id) continue;
    if (!displayName && sec.displayName.trim()) displayName = sec.displayName.trim();
    const secEmail = sec.emailAddress.trim().toLowerCase();
    if (secEmail && secEmail !== primaryEmail) aliasSet.add(secEmail);
    for (const alias of sec.aliases ?? []) {
      const low = alias.trim().toLowerCase();
      if (low && low !== primaryEmail) aliasSet.add(low);
    }
    const secNote = sec.notes?.trim();
    if (secNote && !noteParts.includes(secNote)) noteParts.push(secNote);
  }

  return {
    primaryContactId: primary.id,
    secondaryContactIds: secondaries.filter((s) => s.id !== primary.id).map((s) => s.id),
    mergedDisplayName: displayName || primaryEmail,
    primaryEmailAddress: primaryEmail,
    mergedAliases: [...aliasSet].slice(0, 20),
    mergedNotes: noteParts.join("\n").slice(0, 1000),
  };
}

export function extractSenderContactCandidates(
  senders: readonly string[],
  existingEmails: ReadonlySet<string>,
): Array<{ displayName: string; emailAddress: string }> {
  const seen = new Set<string>();
  for (const existing of existingEmails) seen.add(existing.trim().toLowerCase());
  const candidates: Array<{ displayName: string; emailAddress: string }> = [];

  for (const raw of senders) {
    const trimmed = raw.trim();
    const angle = /^(.*?)<\s*([^<>@\s]+@[^<>@\s]+)\s*>$/.exec(trimmed);
    const email = (angle?.[2] ?? trimmed).trim().toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) continue;
    if (/^(?:no-?reply|donotreply|mailer-daemon|postmaster|bounce)@/i.test(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    const name = (angle?.[1] ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
    candidates.push({ displayName: name || email.split("@")[0] || email, emailAddress: email });
  }
  return candidates;
}

function unescapeVCardValue(raw: string): string {
  return raw
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function escapeVCardValue(raw: string): string {
  return raw
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

export function parseVCardContacts(rawVcf: string, maxEntries = 500): VCardContactEntry[] {
  const unfolded = rawVcf.replace(/\r?\n[ \t]/g, "");
  const cards = unfolded.split(/BEGIN:VCARD/i).slice(1);
  const parsed: VCardContactEntry[] = [];

  for (const rawCard of cards) {
    if (parsed.length >= maxEntries) break;
    const endIdx = rawCard.search(/END:VCARD/i);
    const block = endIdx >= 0 ? rawCard.slice(0, endIdx) : rawCard;
    let fn = "";
    let org = "";
    let title = "";
    let phone = "";
    let notes = "";
    const emails: string[] = [];

    for (const rawLine of block.split(/\r?\n/)) {
      const colonIdx = rawLine.indexOf(":");
      if (colonIdx <= 0) continue;
      const propKey = (rawLine.slice(0, colonIdx).split(";")[0] ?? "").trim().toUpperCase();
      const value = unescapeVCardValue(rawLine.slice(colonIdx + 1));
      if (!value) continue;

      if (propKey === "FN") fn = value.slice(0, 120);
      else if (propKey === "EMAIL") {
        const cleanEmail = value.toLowerCase();
        if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(cleanEmail) && !emails.includes(cleanEmail)) {
          emails.push(cleanEmail);
        }
      } else if (propKey === "ORG") org = (value.split(";")[0] ?? "").trim().slice(0, 120);
      else if (propKey === "TITLE") title = value.slice(0, 120);
      else if (propKey === "TEL" && !phone) phone = value.slice(0, 64);
      else if (propKey === "NOTE") notes = value.slice(0, 500);
    }

    if (emails.length === 0) continue;
    const primaryEmail = emails[0]!;
    parsed.push({
      displayName: fn || primaryEmail,
      emailAddress: primaryEmail,
      aliases: emails.slice(1, 21),
      ...(org ? { organization: org } : {}),
      ...(title ? { title } : {}),
      ...(phone ? { phone } : {}),
      ...(notes ? { notes } : {}),
    });
  }
  return parsed;
}

export function serializeContactsToVCard(entries: readonly VCardContactEntry[]): string {
  const blocks: string[] = [];
  for (const entry of entries) {
    const lines = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `FN:${escapeVCardValue(entry.displayName || entry.emailAddress)}`,
      `EMAIL;TYPE=INTERNET,PREF:${escapeVCardValue(entry.emailAddress)}`,
    ];
    for (const alias of entry.aliases ?? []) {
      if (alias && alias !== entry.emailAddress) {
        lines.push(`EMAIL;TYPE=INTERNET:${escapeVCardValue(alias)}`);
      }
    }
    if (entry.organization) lines.push(`ORG:${escapeVCardValue(entry.organization)}`);
    if (entry.title) lines.push(`TITLE:${escapeVCardValue(entry.title)}`);
    if (entry.phone) lines.push(`TEL;TYPE=CELL:${escapeVCardValue(entry.phone)}`);
    if (entry.notes) lines.push(`NOTE:${escapeVCardValue(entry.notes)}`);
    lines.push("END:VCARD");
    blocks.push(lines.join("\r\n"));
  }
  return blocks.join("\r\n");
}
