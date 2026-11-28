import { Button, ButtonLink, Notice } from '@neuro/ui';
import { useState } from "react";
import type {
  CalendarConflictCheck,
  CalendarRsvpStatus,
  ParsedCalendarInvite,
} from "../../base/src/domain/mail-ics-calendar";
import { api, errorMessage } from "./api";

export function MeetingInviteReaderCard({
  icsText,
  sourceRef,
  responderEmail,
}: {
  icsText: string;
  sourceRef: string;
  responderEmail?: string;
}) {
  const [parsed, setParsed] = useState<{
    invite: ParsedCalendarInvite;
    conflict: CalendarConflictCheck;
  } | null>(null);
  const [replyPreview, setReplyPreview] = useState<{ subject: string; bodyText: string; organizerEmail: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadInvite() {
    setPending(true);
    setError("");
    try {
      const res = await api<{ invite: ParsedCalendarInvite; conflict: CalendarConflictCheck }>(
        "/calendar/parse",
        "POST",
        { ics: icsText, selfEmail: responderEmail ?? "" },
      );
      setParsed(res);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function submitRsvp(decision: "accepted" | "tentative" | "declined") {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const res = await api<{
        savedStatus: CalendarRsvpStatus;
        organizerEmail: string;
        replyDraft: { subject: string; bodyText: string; icsContent: string };
      }>("/calendar/rsvp", "POST", {
        ics: icsText,
        sourceRef,
        responderEmail: responderEmail || "me@local.easyemail",
        decision,
      });
      if (parsed) {
        setParsed({ ...parsed, invite: { ...parsed.invite, selfStatus: res.savedStatus } });
      }
      setReplyPreview({
        subject: res.replyDraft.subject,
        bodyText: res.replyDraft.bodyText,
        organizerEmail: res.organizerEmail,
      });
      setNotice("已记录本地日程状态并生成标准 METHOD:REPLY 回复草稿（未静默外发，可复制回复）");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  if (!parsed) {
    return (
      <div className="row" role="region" aria-label="日历邀请解析">
        <Button type="button" variant="quiet" disabled={pending} onClick={() => void loadInvite()} wrap>
          {pending ? "解析日程中…" : "解析 .ics 会议邀请与冲突检测"}
        </Button>
        {error && <Notice role="alert" tone="danger">{error}</Notice>}
      </div>
    );
  }

  const { invite, conflict } = parsed;
  return (
    <section role="region" aria-label="会议邀请卡片">
      <h4>{invite.title}</h4>
      <p>
        时间：{new Date(invite.startAtMs).toLocaleString()} — {new Date(invite.endAtMs).toLocaleString()}
      </p>
      <p>
        地点：{invite.location}
        {invite.organizerEmail ? ` · 组织者：${invite.organizerEmail}` : ""}
      </p>
      {conflict.hasConflict && (
        <Notice role="alert" tone="warning">
          日程时间冲突：与已接受／暂定的「{conflict.conflictingTitle}」时段重叠！
        </Notice>
      )}
      {invite.meetingUrl && (
        <div className="row">
          <ButtonLink href={invite.meetingUrl} target="_blank" rel="noopener noreferrer" variant="primary">
            一键加入线上视频会议
          </ButtonLink>
        </div>
      )}
      <div className="row">
        <Button
          type="button"
          variant="quiet"
          disabled={pending}
          aria-pressed={invite.selfStatus === "accepted"}
          onClick={() => void submitRsvp("accepted")}
          wrap
        >
          接受邀请
        </Button>
        <Button
          type="button"
          variant="quiet"
          disabled={pending}
          aria-pressed={invite.selfStatus === "tentative"}
          onClick={() => void submitRsvp("tentative")}
          wrap
        >
          暂定
        </Button>
        <Button
          type="button"
          variant="quiet"
          disabled={pending}
          aria-pressed={invite.selfStatus === "declined"}
          onClick={() => void submitRsvp("declined")}
          wrap
        >
          谢绝
        </Button>
      </div>
      {error && <Notice role="alert" tone="danger">{error}</Notice>}
      {notice && <Notice role="status" tone="info">{notice}</Notice>}
      {replyPreview && (
        <div>
          <small>收件人：{replyPreview.organizerEmail || "（组织者）"} · 主题：{replyPreview.subject}</small>
          <pre>{replyPreview.bodyText}</pre>
        </div>
      )}
    </section>
  );
}
