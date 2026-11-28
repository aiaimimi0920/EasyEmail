export type CalendarRsvpStatus = "needs-action" | "accepted" | "tentative" | "declined";

export interface CalendarInviteAttendee {
  name: string;
  email: string;
  role: string;
  status: CalendarRsvpStatus;
}

export interface ParsedCalendarInvite {
  uid: string;
  method: string;
  sequence: string;
  organizerEmail: string;
  organizerName?: string;
  title: string;
  location: string;
  meetingUrl?: string;
  description?: string;
  startAtMs: number;
  endAtMs: number;
  attendees: CalendarInviteAttendee[];
  selfStatus: CalendarRsvpStatus;
}

export interface ExistingCalendarSlot {
  uid: string;
  title: string;
  startAtMs: number;
  endAtMs: number;
  status: CalendarRsvpStatus;
}

export interface CalendarConflictCheck {
  hasConflict: boolean;
  conflictingTitle?: string;
  conflictingStartAtMs?: number;
  conflictingEndAtMs?: number;
}

const MEETING_LINK_RE = /https?:\/\/(?:[\w-]+\.)?(?:zoom\.us|teams\.microsoft\.com|meet\.google\.com|feishu\.cn\/vc|larksuite\.com\/vc|meeting\.tencent\.com|wemeet\.qq\.com)\/[^\s<>"')]+/i;

function unescapeIcsText(raw: string): string {
  return raw
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function escapeIcsText(raw: string): string {
  return raw
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

export function parseIcsTimestampMs(rawValue: string): number | null {
  const cleaned = rawValue.trim();
  const dateTimeMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i.exec(cleaned);
  if (dateTimeMatch) {
    const [, y, m, d, hh, mm, ss, utcFlag] = dateTimeMatch;
    const ms = utcFlag
      ? Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))
      : new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const dateOnlyMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(cleaned);
  if (dateOnlyMatch) {
    const [, y, m, d] = dateOnlyMatch;
    const ms = Date.UTC(Number(y), Number(m) - 1, Number(d), 0, 0, 0);
    return Number.isNaN(ms) ? null : ms;
  }
  const iso = Date.parse(cleaned);
  return Number.isNaN(iso) ? null : iso;
}

function formatIcsUtcTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function normalizePartStat(raw: string | undefined): CalendarRsvpStatus {
  const up = (raw ?? "").trim().toUpperCase();
  if (up === "ACCEPTED") return "accepted";
  if (up === "TENTATIVE") return "tentative";
  if (up === "DECLINED") return "declined";
  return "needs-action";
}

function parseParamMap(rawParamSegment: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of rawParamSegment.split(";").slice(1)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const k = token.slice(0, eq).trim().toUpperCase();
    const v = token.slice(eq + 1).trim().replace(/^"+|"+$/g, "");
    if (k) out[k] = v;
  }
  return out;
}

export function parseIcsMeetingInvite(rawIcs: string, selfEmail = "", extraBodyText = ""): ParsedCalendarInvite | null {
  if (!rawIcs.trim() || !/BEGIN:VCALENDAR/i.test(rawIcs)) return null;
  const unfolded = rawIcs.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  let method = "REQUEST";
  let inEvent = false;
  let uid = "";
  let sequence = "0";
  let summary = "";
  let location = "";
  let description = "";
  let organizerEmail = "";
  let organizerName = "";
  let startAtMs: number | null = null;
  let endAtMs: number | null = null;
  let selfStatus: CalendarRsvpStatus = "needs-action";
  const attendees: CalendarInviteAttendee[] = [];
  const lowSelf = selfEmail.trim().toLowerCase();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^BEGIN:VEVENT$/i.test(trimmed)) {
      inEvent = true;
      continue;
    }
    if (/^END:VEVENT$/i.test(trimmed)) {
      break;
    }
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const head = trimmed.slice(0, colon);
    const prop = (head.split(";")[0] ?? "").trim().toUpperCase();
    const value = trimmed.slice(colon + 1);

    if (!inEvent) {
      if (prop === "METHOD") method = value.trim().toUpperCase();
      continue;
    }

    const params = parseParamMap(head);
    if (prop === "UID") uid = unescapeIcsText(value);
    else if (prop === "SEQUENCE") sequence = value.trim() || "0";
    else if (prop === "SUMMARY") summary = unescapeIcsText(value);
    else if (prop === "LOCATION") location = unescapeIcsText(value);
    else if (prop === "DESCRIPTION") description = unescapeIcsText(value);
    else if (prop === "DTSTART") startAtMs = parseIcsTimestampMs(value);
    else if (prop === "DTEND") endAtMs = parseIcsTimestampMs(value);
    else if (prop === "ORGANIZER") {
      organizerEmail = value.replace(/^mailto:/i, "").trim().toLowerCase();
      organizerName = params["CN"] ?? "";
    } else if (prop === "ATTENDEE") {
      const email = value.replace(/^mailto:/i, "").trim().toLowerCase();
      const status = normalizePartStat(params["PARTSTAT"]);
      const name = params["CN"] || email;
      const role = params["ROLE"] || "REQ-PARTICIPANT";
      if (email) {
        attendees.push({ name, email, role, status });
        if (lowSelf && email === lowSelf) selfStatus = status;
      }
    }
  }

  if (!uid || startAtMs === null) return null;
  const resolvedEnd = endAtMs !== null && endAtMs > startAtMs ? endAtMs : startAtMs + 60 * 60 * 1000;
  const meetingUrl = MEETING_LINK_RE.exec(`${location}\n${description}\n${extraBodyText}`)?.[0];
  const displayTitle = method === "CANCEL"
    ? `[已取消] ${summary || "日程会议邀请"}`
    : (summary || "日程会议邀请");

  return {
    uid,
    method,
    sequence,
    organizerEmail,
    ...(organizerName ? { organizerName } : {}),
    title: displayTitle,
    location: location || (meetingUrl ? "线上视频会议" : "待定地点"),
    ...(meetingUrl ? { meetingUrl } : {}),
    ...(description ? { description: description.slice(0, 2000) } : {}),
    startAtMs,
    endAtMs: resolvedEnd,
    attendees: attendees.slice(0, 50),
    selfStatus: method === "CANCEL" ? "declined" : selfStatus,
  };
}

export function detectCalendarEventConflict(
  invite: Pick<ParsedCalendarInvite, "uid" | "method" | "startAtMs" | "endAtMs">,
  existingSlots: readonly ExistingCalendarSlot[],
): CalendarConflictCheck {
  if (invite.method.toUpperCase() === "CANCEL") return { hasConflict: false };
  for (const slot of existingSlots) {
    if (slot.uid === invite.uid) continue;
    if (slot.status !== "accepted" && slot.status !== "tentative") continue;
    if (slot.startAtMs < invite.endAtMs && slot.endAtMs > invite.startAtMs) {
      return {
        hasConflict: true,
        conflictingTitle: slot.title,
        conflictingStartAtMs: slot.startAtMs,
        conflictingEndAtMs: slot.endAtMs,
      };
    }
  }
  return { hasConflict: false };
}

export function buildIcsMethodReply(params: {
  invite: ParsedCalendarInvite;
  responderEmail: string;
  responderName?: string;
  decision: "accepted" | "tentative" | "declined";
  nowMs?: number;
}): { icsContent: string; subject: string; bodyText: string } {
  const partStat = params.decision === "accepted"
    ? "ACCEPTED"
    : params.decision === "tentative"
      ? "TENTATIVE"
      : "DECLINED";
  const prefix = params.decision === "accepted"
    ? "已接受"
    : params.decision === "tentative"
      ? "暂定"
      : "已谢绝";
  const stamp = formatIcsUtcTimestamp(params.nowMs ?? Date.now());
  const cnParam = params.responderName?.trim() ? `;CN=${escapeIcsText(params.responderName.trim())}` : "";

  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//EasyEmail//Calendar RSVP 1.0//CN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(params.invite.uid)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${formatIcsUtcTimestamp(params.invite.startAtMs)}`,
    `DTEND:${formatIcsUtcTimestamp(params.invite.endAtMs)}`,
    `SEQUENCE:${params.invite.sequence || "0"}`,
    `SUMMARY:${escapeIcsText(params.invite.title)}`,
    ...(params.invite.organizerEmail ? [`ORGANIZER:mailto:${params.invite.organizerEmail}`] : []),
    `ATTENDEE${cnParam};PARTSTAT=${partStat}:mailto:${params.responderEmail.trim().toLowerCase()}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  const cleanTitle = params.invite.title.replace(/^\[已取消\]\s*/, "");
  return {
    icsContent: lines.join("\r\n"),
    subject: `${prefix}: ${cleanTitle}`,
    bodyText: `${params.responderEmail} 对日程「${cleanTitle}」回复了状态：${prefix} (${partStat})。`,
  };
}
