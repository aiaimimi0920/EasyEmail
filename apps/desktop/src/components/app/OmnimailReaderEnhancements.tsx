import { useEffect, useMemo, useState } from "react";
import {
  evaluateMailPhishingSecurity,
  inspectExternalLinkSafety,
} from "../../../../../service/base/src/domain/mail-phishing-evaluator";
import {
  buildSandboxedReaderDocument,
  restoreSafeRemoteImagesInHtml,
  sanitizeSafeMailHtml,
} from "../../../../../service/base/src/domain/mail-safe-html-engine";
import {
  createTextNodeTranslationController,
  extractTranslatableTextSegments,
  groupSegmentsIntoBatches,
  lookupTranslatedSegment,
  type MailTranslationDisplayMode,
  type MinimalDomElement,
} from "../../../../../service/base/src/domain/mail-dom-translation";
import { evaluateMailPrivacyGuard } from "../../../../../service/base/src/domain/mail-ai-privacy-guard";
import { omnimailWorkbenchClient } from "../../app/appRuntime";

function transformDesktopSafeHtmlWithTranslation(
  htmlFragment: string,
  segmentsMap: Readonly<Record<string, string | undefined>> | null,
  targetLang: string,
  mode: MailTranslationDisplayMode,
): string {
  if (!htmlFragment || !segmentsMap || mode === "original" || typeof DOMParser === "undefined") {
    return htmlFragment;
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="ee-dt-tx">${htmlFragment}</div>`, "text/html");
  const root = doc.getElementById("ee-dt-tx");
  if (!root) return htmlFragment;
  const apply = createTextNodeTranslationController(root as unknown as MinimalDomElement);
  apply({ mode, targetLang, segments: segmentsMap });
  return root.innerHTML;
}

function collectMailExternalLinks(bodyText: string, bodyHtml: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const cleaned = raw.replace(/[.,;:!?)]+$/, "").trim();
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(cleaned);
  };
  for (const m of bodyHtml.matchAll(/\bhref\s*=\s*["'](https?:\/\/[^"'\s<>]+)["']/gi)) {
    if (m[1]) push(m[1]);
    if (out.length >= 15) return out;
  }
  for (const m of bodyText.matchAll(/https?:\/\/[^\s<>"')]+/gi)) {
    if (m[0]) push(m[0]);
    if (out.length >= 15) return out;
  }
  return out;
}

export function OmnimailReaderEnhancements({
  subject,
  fromAddress,
  bodyText,
  bodyHtml,
  openUrl,
  onPopulateReplyDraft,
}: {
  subject: string;
  fromAddress: string;
  bodyText: string;
  bodyHtml: string;
  openUrl: (url: string) => void;
  onPopulateReplyDraft?: (to: string, subject: string, bodyText: string) => void;
}) {
  const [paperMode, setPaperMode] = useState(false);
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);
  const [showEnhancedFrame, setShowEnhancedFrame] = useState(false);
  const [txMode, setTxMode] = useState<MailTranslationDisplayMode>("original");
  const [targetLang, setTargetLang] = useState("zh-CN");
  const [txMap, setTxMap] = useState<Record<string, string> | null>(null);
  const [aiConsent, setAiConsent] = useState(false);
  const [aiSummary, setAiSummary] = useState<{
    summaryTitle?: string;
    summary?: string;
    deadlines?: Array<{ label: string; timeText: string; urgent: boolean }>;
  } | null>(null);
  const [aiDraft, setAiDraft] = useState<string>("");
  const [icsInput, setIcsInput] = useState("");
  const [icsCard, setIcsCard] = useState<{
    title: string;
    location: string;
    meetingUrl?: string;
    startAtMs: number;
    endAtMs: number;
    selfStatus: string;
    conflictTitle?: string;
  } | null>(null);
  const [statusMsg, setStatusMsg] = useState("");
  const [pending, setPending] = useState(false);
  const [trustedDomains, setTrustedDomains] = useState<string[]>([]);
  const [pendingLinkHref, setPendingLinkHref] = useState<string | null>(null);

  useEffect(() => {
    setTxMode("original");
    setTxMap(null);
    setAiSummary(null);
    setAiDraft("");
    setStatusMsg("");
    setAiConsent(false);
    setAllowRemoteImages(false);
    setPendingLinkHref(null);
  }, [subject, fromAddress, bodyText, bodyHtml]);

  const security = useMemo(
    () =>
      evaluateMailPhishingSecurity({
        senderHeader: fromAddress,
        htmlBody: bodyHtml,
      }),
    [fromAddress, bodyHtml],
  );

  const safeHtmlInfo = useMemo(() => {
    if (!bodyHtml) return null;
    const base = sanitizeSafeMailHtml(bodyHtml, { allowRemoteImages: false });
    const rawFragment = allowRemoteImages ? restoreSafeRemoteImagesInHtml(base.html) : base.html;
    const html = transformDesktopSafeHtmlWithTranslation(rawFragment, txMap, targetLang, txMode);
    const srcDoc = buildSandboxedReaderDocument({
      html,
      css: base.css,
      schemeMode: paperMode ? "paper-light" : "adaptive-dark",
      allowRemoteImages,
    });
    return { ...base, srcDoc };
  }, [bodyHtml, paperMode, allowRemoteImages, txMap, targetLang, txMode]);

  const externalLinks = useMemo(() => collectMailExternalLinks(bodyText, bodyHtml), [bodyText, bodyHtml]);
  const pendingLinkCheck = pendingLinkHref ? inspectExternalLinkSafety(pendingLinkHref, trustedDomains) : null;

  const localGuard = useMemo(
    () =>
      evaluateMailPrivacyGuard(
        {
          enabled: true,
          includeSubject: true,
          requireExplicitConsent: false,
          provider: "openai",
          endpointUrl: "https://api.openai.com/v1",
        },
        {
          subject,
          textBody: bodyText,
          htmlBody: bodyHtml,
          phishingLevel: security.level,
          consentConfirmed: true,
        },
        true,
      ),
    [subject, bodyText, bodyHtml, security.level],
  );

  async function triggerTranslate(nextMode: MailTranslationDisplayMode) {
    if (nextMode === "original") {
      setTxMode("original");
      return;
    }
    if (txMap) {
      setTxMode(nextMode);
      return;
    }
    setPending(true);
    setStatusMsg("");
    try {
      const segs = extractTranslatableTextSegments({ textBody: bodyText, htmlBody: bodyHtml });
      if (segs.length === 0) {
        setStatusMsg("无可翻译的可见文本段落");
        return;
      }
      const map: Record<string, string> = {};
      for (const batch of groupSegmentsIntoBatches(segs)) {
        const res = await omnimailWorkbenchClient.translateSegments({
          segments: batch,
          targetLang,
          securityLevel: security.level,
        });
        batch.forEach((src, idx) => {
          const val = res.translations[idx]?.trim();
          if (val) map[src] = val;
        });
      }
      setTxMap(map);
      setTxMode(nextMode);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : "翻译请求失败");
    } finally {
      setPending(false);
    }
  }

  async function runAiAction(task: "summary" | "draft") {
    setPending(true);
    setStatusMsg("");
    try {
      const res = await omnimailWorkbenchClient.analyzeMail({
        task,
        subject,
        text: bodyText,
        html: bodyHtml,
        securityLevel: security.level,
        consentConfirmed: aiConsent,
      });
      if (task === "summary") setAiSummary(res.result);
      else setAiDraft(res.result.draftReply ?? "");
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : "AI 请求失败");
    } finally {
      setPending(false);
    }
  }

  const translatedPreview = useMemo(() => {
    if (txMode === "original" || !txMap) return "";
    const segs = extractTranslatableTextSegments({ textBody: bodyText, htmlBody: bodyHtml });
    return segs
      .map((line) => {
        const hit = lookupTranslatedSegment(line, txMap);
        if (!hit) return line;
        return txMode === "bilingual" ? `${line}\n  ↳ ${hit}` : hit;
      })
      .join("\n\n");
  }, [txMode, txMap, bodyText, bodyHtml]);

  const inlineIcsCandidate = bodyText.includes("BEGIN:VCALENDAR") ? bodyText : icsInput;

  return (
    <section className="nt-action-board" aria-label="安全阅读、保真翻译与智能辅助">
      {security.level !== "safe" && (
        <div className="nt-result" role="alert">
          <strong>{security.title}</strong>
          <span>{security.reasons.join("；")}</span>
        </div>
      )}

      <div className="nt-row-actions">
        {safeHtmlInfo && (
          <>
            <button
              type="button"
              className="nt-mini-btn"
              onClick={() => setShowEnhancedFrame((v) => !v)}
            >
              {showEnhancedFrame ? "收起安全隔离画布" : "开启自适应深浅安全画布"}
            </button>
            {showEnhancedFrame && (
              <>
                <button
                  type="button"
                  className="nt-mini-btn"
                  onClick={() => setPaperMode((v) => !v)}
                >
                  {paperMode ? "切换自适应深色 (#161B22)" : "切换柔和纸面 (#F5F2EB)"}
                </button>
                {safeHtmlInfo.hasRemoteImages && (
                  <button
                    type="button"
                    className="nt-mini-btn"
                    onClick={() => setAllowRemoteImages((v) => !v)}
                  >
                    {allowRemoteImages
                      ? "重新屏蔽远程图片"
                      : `放行远程图片 (${safeHtmlInfo.remoteImageCount})`}
                  </button>
                )}
              </>
            )}
          </>
        )}

        <select
          value={targetLang}
          onChange={(e) => {
            setTargetLang(e.currentTarget.value);
            setTxMap(null);
            setTxMode("original");
          }}
        >
          <option value="zh-CN">译为简体中文</option>
          <option value="en">译为 English</option>
          <option value="ja">译为日本語</option>
        </select>
        <button type="button" className="nt-mini-btn" disabled={pending} onClick={() => void triggerTranslate("original")}>
          原文
        </button>
        <button type="button" className="nt-mini-btn" disabled={pending} onClick={() => void triggerTranslate("translated")}>
          译文
        </button>
        <button type="button" className="nt-mini-btn" disabled={pending} onClick={() => void triggerTranslate("bilingual")}>
          双语对照
        </button>
      </div>

      {showEnhancedFrame && safeHtmlInfo && (
        <iframe
          title="隔离增强邮件画布"
          sandbox=""
          referrerPolicy="no-referrer"
          style={{ width: "100%", minHeight: "280px", border: "1px solid rgba(148,163,184,0.22)", borderRadius: "8px" }}
          srcDoc={safeHtmlInfo.srcDoc}
        />
      )}

      {translatedPreview && (
        <pre className="nt-result" style={{ whiteSpace: "pre-wrap" }}>
          {translatedPreview}
        </pre>
      )}

      <div className="nt-divider" />
      {!localGuard.allowed ? (
        <small>{localGuard.reason}</small>
      ) : (
        <div className="nt-row-actions">
          <label className="nt-check">
            <input
              type="checkbox"
              checked={aiConsent}
              onChange={(e) => setAiConsent(e.currentTarget.checked)}
            />
            同意脱敏外发（约 {localGuard.preview.charCount} 字，不含附件／邮件头）
          </label>
          <button
            type="button"
            className="nt-mini-btn"
            disabled={pending || !aiConsent}
            onClick={() => void runAiAction("summary")}
          >
            AI 摘要与待办
          </button>
          <button
            type="button"
            className="nt-mini-btn"
            disabled={pending || !aiConsent}
            onClick={() => void runAiAction("draft")}
          >
            AI 起草回复（不自动发送）
          </button>
        </div>
      )}

      {aiSummary && (
        <div className="nt-result">
          <strong>{aiSummary.summaryTitle}</strong>
          <span>{aiSummary.summary}</span>
        </div>
      )}
      {aiDraft && (
        <pre className="nt-result" style={{ whiteSpace: "pre-wrap" }}>
          {aiDraft}
        </pre>
      )}

      {inlineIcsCandidate ? (
        <div className="nt-row-actions">
          <button
            type="button"
            className="nt-mini-btn"
            disabled={pending}
            onClick={async () => {
              try {
                const res = await omnimailWorkbenchClient.parseCalendarIcs(inlineIcsCandidate);
                setIcsCard({
                  ...res.invite,
                  conflictTitle: res.conflict.hasConflict ? res.conflict.conflictingTitle : undefined,
                });
              } catch (err) {
                setStatusMsg(err instanceof Error ? err.message : "解析 .ics 失败");
              }
            }}
          >
            解析日程邀请 (.ics) 与冲突检查
          </button>
        </div>
      ) : (
        <details>
          <summary>手动粘贴 .ics 日历邀请检查冲突</summary>
          <textarea
            value={icsInput}
            placeholder="BEGIN:VCALENDAR..."
            onChange={(e) => setIcsInput(e.currentTarget.value)}
          />
        </details>
      )}

      {icsCard && (
        <div className="nt-result">
          <strong>{icsCard.title}</strong>
          <span>
            {new Date(icsCard.startAtMs).toLocaleString()} - {new Date(icsCard.endAtMs).toLocaleString()} · {icsCard.location}
          </span>
          {icsCard.conflictTitle && <span>⚠️ 时间冲突：与「{icsCard.conflictTitle}」重叠</span>}
          <div className="nt-row-actions">
            {icsCard.meetingUrl && (
              <button type="button" className="nt-mini-btn nt-mini-btn--signal" onClick={() => openUrl(icsCard.meetingUrl!)}>
                加入视频会议
              </button>
            )}
            {(["accepted", "tentative", "declined"] as const).map((dec) => (
              <button
                key={dec}
                type="button"
                className="nt-mini-btn"
                onClick={async () => {
                  const res = await omnimailWorkbenchClient.recordCalendarRsvp(inlineIcsCandidate, "me@local.nmail", dec);
                  setIcsCard({ ...icsCard, selfStatus: res.savedStatus });
                  setAiDraft(res.replyDraft.bodyText);
                  if (onPopulateReplyDraft && res.organizerEmail) {
                    onPopulateReplyDraft(res.organizerEmail, res.replyDraft.subject, res.replyDraft.bodyText);
                  }
                }}
              >
                {dec === "accepted" ? "接受" : dec === "tentative" ? "暂定" : "谢绝"}
              </button>
            ))}
          </div>
        </div>
      )}

      {externalLinks.length > 0 && (
        <details>
          <summary>外部链接域名安全核验 ({externalLinks.length})</summary>
          {pendingLinkCheck?.safeHref && (
            <div className="nt-result" role="alert">
              <strong>
                目标域名：{pendingLinkCheck.hostname}
                {pendingLinkCheck.isPunycode ? "（⚠️ 疑似 Punycode 同形异义仿冒域名！）" : ""}
              </strong>
              <div className="nt-row-actions">
                <button
                  type="button"
                  className="nt-mini-btn nt-mini-btn--signal"
                  onClick={() => {
                    openUrl(pendingLinkCheck.safeHref!);
                    setPendingLinkHref(null);
                  }}
                >
                  确认打开 {pendingLinkCheck.hostname}
                </button>
                {!pendingLinkCheck.isPunycode && pendingLinkCheck.registrableDomain && (
                  <button
                    type="button"
                    className="nt-mini-btn"
                    onClick={() =>
                      setTrustedDomains((prev) =>
                        prev.includes(pendingLinkCheck.registrableDomain)
                          ? prev
                          : [...prev, pendingLinkCheck.registrableDomain],
                      )
                    }
                  >
                    信任 {pendingLinkCheck.registrableDomain}
                  </button>
                )}
                <button type="button" className="nt-mini-btn" onClick={() => setPendingLinkHref(null)}>
                  取消
                </button>
              </div>
            </div>
          )}
          <div className="nt-row-actions">
            {externalLinks.map((href) => {
              const check = inspectExternalLinkSafety(href, trustedDomains);
              if (!check.safeHref) return null;
              return (
                <button
                  key={href}
                  type="button"
                  className="nt-mini-btn"
                  onClick={() =>
                    check.requiresConfirmation ? setPendingLinkHref(check.safeHref) : openUrl(check.safeHref!)
                  }
                >
                  {check.requiresConfirmation ? `核验 ${check.hostname}` : `打开 ${check.hostname}`}
                </button>
              );
            })}
          </div>
        </details>
      )}

      {statusMsg && <small>{statusMsg}</small>}
    </section>
  );
}
