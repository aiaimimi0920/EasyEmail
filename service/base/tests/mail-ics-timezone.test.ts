import { describe, expect, it } from "vitest";
import { buildIcsMethodReply, detectCalendarEventConflict, parseIcsMeetingInvite } from "../src/domain/mail-ics-calendar.js";

const parse = (start: string, end: string) => parseIcsMeetingInvite(
  ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:synthetic", `DTSTART${start}`, `DTEND${end}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n"),
);

describe("ICS wall times and UTC instants", () => {
  it.each([
    [';TZID="Asia/Shanghai":20261129T090000', ";TZID=Asia/Shanghai:20261129T100000", "20261129T010000Z", "20261129T020000Z"],
    [":20261129T090000Z", ":20261129T100000Z", "20261129T090000Z", "20261129T100000Z"],
    [";TZID=America/New_York:20260308T013000", ";TZID=America/New_York:20260308T033000", "20260308T063000Z", "20260308T073000Z"],
  ])("resolves %s and its independent end", (start, end, utcStart, utcEnd) => {
    const invite = parse(start, end)!;
    const expected = parse(`:${utcStart}`, `:${utcEnd}`)!;
    expect([invite.startAtMs, invite.endAtMs]).toEqual([expected.startAtMs, expected.endAtMs]);
    const slot = { ...expected, uid: "other", title: "UTC slot", status: "accepted" as const };
    expect(detectCalendarEventConflict(invite, [slot]).hasConflict).toBe(true);
    expect(detectCalendarEventConflict(invite, [{ ...slot, startAtMs: expected.endAtMs, endAtMs: expected.endAtMs + 1 }]).hasConflict).toBe(false);
    const reply = buildIcsMethodReply({ invite, responderEmail: "fixture@example.test", decision: "accepted" }).icsContent;
    expect(reply.split("\r\n")).toEqual(expect.arrayContaining([`DTSTART:${utcStart}`, `DTEND:${utcEnd}`]));
  });

  it.each([
    ";TZID=America/New_York:20261101T013000", ";TZID=America/New_York:20260308T023000",
    ";TZID=Not/AZone:20261129T090000", ";TZID=CST:20261129T090000", ";TZID=:20261129T090000",
    ";TZID=Asia/Shanghai:20261129T090000Z", ";TZID=Asia/Shanghai:20260230T090000",
    ";TZID=Asia/Shanghai;TZID=Europe/Paris:20261129T090000", ";TZID=UTC:20261129",
  ])("does not guess an instant or default the end for %s", invalid => {
    expect(parse(invalid, ":20261231T120000Z")).toBeNull();
    expect(parse(":20260101T000000Z", invalid)).toBeNull();
  });

  it("keeps unqualified floating times host-local and date-only values at UTC midnight", () => {
    expect(parse(":20261129T090000", ":20261129T100000")?.startAtMs).toBe(new Date(2026, 10, 29, 9).getTime());
    expect(parse(";VALUE=DATE:20261129", ";VALUE=DATE:20261130")?.endAtMs).toBe(Date.UTC(2026, 10, 30));
  });
});
