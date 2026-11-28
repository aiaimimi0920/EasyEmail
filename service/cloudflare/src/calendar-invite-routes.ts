import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import {
  buildIcsMethodReply,
  detectCalendarEventConflict,
  parseIcsMeetingInvite,
  type CalendarRsvpStatus,
  type ExistingCalendarSlot,
} from "../../base/src/domain/mail-ics-calendar";

interface CalendarEventRow {
  uid: string;
  source_ref: string;
  title: string;
  organizer_email: string;
  start_at_ms: number;
  end_at_ms: number;
  rsvp_status: CalendarRsvpStatus;
  updated_at: number;
}

async function loadExistingSlots(env: Env, userId: string): Promise<ExistingCalendarSlot[]> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM calendar_events WHERE user_id = ? ORDER BY start_at_ms ASC LIMIT 300",
    )
      .bind(userId)
      .all<CalendarEventRow>();
    return results.map((r) => ({
      uid: r.uid,
      title: r.title,
      startAtMs: r.start_at_ms,
      endAtMs: r.end_at_ms,
      status: r.rsvp_status,
    }));
  } catch {
    return [];
  }
}

export const isCalendarPath = (path: string) =>
  path === "/api/v1/calendar/parse" ||
  path === "/api/v1/calendar/rsvp" ||
  path === "/api/v1/calendar/events";

export async function calendarInviteRoute(request: Request, env: Env, identity: Identity): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === "/api/v1/calendar/events" && request.method === "GET") {
    requireScope(identity, "calendar:read");
    const slots = await loadExistingSlots(env, identity.userId);
    return json({ items: slots });
  }

  if (path === "/api/v1/calendar/parse" && request.method === "POST") {
    requireWriteScope(request, env, identity, "calendar:read");
    const body = await readJson(request);
    const rawIcs = String(body.ics ?? "");
    const selfEmail = typeof body.selfEmail === "string" ? body.selfEmail : "";
    const extraText = typeof body.extraText === "string" ? body.extraText : "";
    const invite = parseIcsMeetingInvite(rawIcs, selfEmail, extraText);
    if (!invite) throw new HttpError(400, "invalid_ics_payload");
    const existing = await loadExistingSlots(env, identity.userId);
    const savedSelf = existing.find((s) => s.uid === invite.uid)?.status;
    const conflict = detectCalendarEventConflict(invite, existing);
    return json({
      invite: savedSelf ? { ...invite, selfStatus: savedSelf } : invite,
      conflict,
    });
  }

  if (path === "/api/v1/calendar/rsvp" && request.method === "POST") {
    requireWriteScope(request, env, identity, "calendar:write");
    const body = await readJson(request);
    const rawIcs = String(body.ics ?? "");
    const responderEmail = String(body.responderEmail ?? "").trim();
    const decision = body.decision;
    if (
      !responderEmail ||
      (decision !== "accepted" && decision !== "tentative" && decision !== "declined")
    ) {
      throw new HttpError(400, "invalid_ics_payload");
    }
    const invite = parseIcsMeetingInvite(rawIcs, responderEmail);
    if (!invite) throw new HttpError(400, "invalid_ics_payload");
    await env.DB.prepare(
      `INSERT INTO calendar_events (user_id, uid, source_ref, title, organizer_email, start_at_ms, end_at_ms, rsvp_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, uid) DO UPDATE SET
         title = excluded.title,
         organizer_email = excluded.organizer_email,
         start_at_ms = excluded.start_at_ms,
         end_at_ms = excluded.end_at_ms,
         rsvp_status = excluded.rsvp_status,
         updated_at = excluded.updated_at`,
    )
      .bind(
        identity.userId,
        invite.uid,
        typeof body.sourceRef === "string" ? body.sourceRef.slice(0, 120) : "",
        invite.title,
        invite.organizerEmail,
        invite.startAtMs,
        invite.endAtMs,
        decision,
        unixNow(),
      )
      .run();
    const reply = buildIcsMethodReply({
      invite,
      responderEmail,
      decision,
    });
    return json({
      savedStatus: decision,
      organizerEmail: invite.organizerEmail,
      replyDraft: reply,
    });
  }

  throw new HttpError(405, "method_not_allowed");
}
