import { Button, Notice } from '@neuro/ui';
import { useMemo, useState } from "react";
import DOMPurify from "dompurify";
import {
  buildSandboxedReaderDocument,
  sanitizeSafeMailHtml,
} from "../../base/src/domain/mail-safe-html-engine";
import { evaluateMailPhishingSecurity } from "../../base/src/domain/mail-phishing-evaluator";
import type { MailReaderThemeMode } from "../../base/src/domain/mail-safe-css-engine";
import { MailSecurityBanner } from "./MailSecurityBanner";
import { ExternalLinkGuard } from "./ExternalLinkGuard";
import { MailTranslationBar, type TranslationRenderOutput } from "./MailTranslationBar";
import { MailAiAssistantPanel } from "./MailAiAssistantPanel";

function buildInertBody(rawHtml: string, needText: boolean) {
  const body = DOMPurify.sanitize(rawHtml, {
    RETURN_DOM: true,
    ALLOWED_TAGS: [
      "p", "br", "div", "span", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i",
      "u", "s", "del", "blockquote", "pre", "code", "ul", "ol", "li", "hr",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td", "a",
    ],
    ALLOWED_ATTR: [],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    FORBID_CONTENTS: ["script", "style", "iframe", "object", "embed", "svg", "math", "form", "template"],
  });
  if (!(body instanceof Element)) throw new Error("Expected a sanitized mail body element");
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"></head><body>${body.innerHTML}</body></html>`;
  if (!needText) return { srcDoc, text: "" };
  // Project the same inert tree to text without attaching mail content to the page.
  for (const br of body.querySelectorAll("br,hr")) br.replaceWith("\n");
  for (const block of body.querySelectorAll("p,div,h1,h2,h3,h4,h5,h6,blockquote,pre,li,tr")) {
    block.before("\n"); block.after("\n");
  }
  for (const cell of body.querySelectorAll("td,th")) if (cell.nextElementSibling) cell.after("\t");
  return { srcDoc, text: body.textContent.replace(/\n[ \t]*\n+/g, "\n").trim() };
}

function purifyMailHtml(rawHtml: string, allowRemoteImages: boolean) {
  const safeEngine = sanitizeSafeMailHtml(rawHtml, { allowRemoteImages });
  const domPurifyConfig = {
    ALLOWED_TAGS: [
      "p", "br", "div", "span", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i",
      "u", "s", "del", "blockquote", "pre", "code", "ul", "ol", "li", "hr",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col", "a", "img",
    ],
    ALLOWED_ATTR: [
      "class", "id", "style", "align", "valign", "width", "height", "bgcolor", "dir", "lang", "title",
      "border", "cellpadding", "cellspacing", "colspan", "rowspan", "scope", "headers",
      "href", "target", "rel", "alt",
      "data-ee-remote-src", "data-ee-remote-bg", "data-ee-tracking-blocked", "data-ee-cid", "data-ee-cid-missing",
      ...(allowRemoteImages ? ["src", "background"] : ["src"]),
    ],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    FORBID_CONTENTS: ["script", "style", "iframe", "object", "embed", "svg", "math", "form", "template"],
  };
  let purified: string;
  if (!allowRemoteImages) {
    DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
      if ((data.attrName === "src" || data.attrName === "background") && /^(?:https?:)?\/\//i.test(data.attrValue.trim())) {
        data.keepAttr = false;
      }
    });
    try {
      purified = DOMPurify.sanitize(safeEngine.html, domPurifyConfig);
    } finally {
      DOMPurify.removeHook("uponSanitizeAttribute");
    }
  } else {
    purified = DOMPurify.sanitize(safeEngine.html, domPurifyConfig);
  }
  return {
    purified,
    css: safeEngine.css,
    hasRemoteImages: safeEngine.hasRemoteImages,
    remoteImageCount: safeEngine.remoteImageCount,
    trackingPixelCount: safeEngine.trackingPixelCount,
  };
}

export function SafeMailBody({
  subject,
  text,
  html,
  sender,
  replyAddress,
  authenticationResults,
  attachmentFilenames,
}: {
  subject?: string;
  text: string;
  html: string;
  sender?: string;
  replyAddress?: string | null;
  authenticationResults?: string;
  attachmentFilenames?: readonly string[];
}) {
  const [viewMode, setViewMode] = useState<"text" | "inert" | "fidelity">("text");
  const [schemeMode, setSchemeMode] = useState<MailReaderThemeMode>("adaptive-dark");
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);
  const [translated, setTranslated] = useState<TranslationRenderOutput | null>(null);

  const hasPlainText = !!text.trim();
  const inertBody = useMemo(
    () => (html ? buildInertBody(translated?.transformedHtml ?? html, !hasPlainText) : null),
    [html, translated, hasPlainText],
  );

  const sanitized = useMemo(
    () => (html ? purifyMailHtml(html, allowRemoteImages) : null),
    [html, allowRemoteImages],
  );

  const securityAssessment = useMemo(
    () =>
      evaluateMailPhishingSecurity({
        senderHeader: sender,
        replyToAddresses: replyAddress ? [replyAddress] : [],
        authenticationResultsHeader: authenticationResults,
        htmlBody: html,
        attachmentFilenames,
      }),
    [sender, replyAddress, authenticationResults, html, attachmentFilenames],
  );

  const fidelitySrcDoc = useMemo(() => {
    if (!sanitized) return "";
    return buildSandboxedReaderDocument({
      html: translated?.transformedHtml ?? sanitized.purified,
      css: sanitized.css,
      schemeMode,
      allowRemoteImages,
    });
  }, [sanitized, translated, schemeMode, allowRemoteImages]);

  const activePlainText = translated?.plainText ?? (hasPlainText ? text : inertBody?.text || "（无正文）");

  return <section aria-label="邮件正文">
    <MailSecurityBanner
      sender={sender}
      replyAddress={replyAddress}
      authenticationResults={authenticationResults}
      html={html}
      attachmentFilenames={attachmentFilenames}
    />
    <MailTranslationBar
      text={text}
      purifiedHtml={sanitized?.purified ?? ""}
      securityLevel={securityAssessment.level}
      onTranslatedChange={setTranslated}
    />
    {html && <div className="row">
      <Button type="button" aria-pressed={viewMode === "text"} onClick={() => setViewMode("text")} variant="quiet" wrap>纯文本</Button>
      <Button type="button" aria-pressed={viewMode === "inert"} onClick={() => setViewMode("inert")} variant="quiet" wrap>安全 HTML</Button>
      <Button type="button" aria-pressed={viewMode === "fidelity"} onClick={() => setViewMode("fidelity")} variant="quiet" wrap>保真排版</Button>
      {viewMode === "fidelity" && <>
        <Button type="button" aria-pressed={schemeMode === "adaptive-dark"} onClick={() => setSchemeMode("adaptive-dark")} variant="quiet" wrap>自适应深色</Button>
        <Button type="button" aria-pressed={schemeMode === "paper-light"} onClick={() => setSchemeMode("paper-light")} variant="quiet" wrap>柔和纸张浅底</Button>
      </>}
    </div>}
    {viewMode === "fidelity" && sanitized && (sanitized.hasRemoteImages || sanitized.trackingPixelCount > 0) && (
      <div className="row" role="region" aria-label="远程图片与追踪防护">
        <Notice role="status" tone="info">
          {allowRemoteImages
            ? `已单封放行 ${sanitized.remoteImageCount} 项远程图片资源（仍已自动剥离 ${sanitized.trackingPixelCount} 个追踪像素）`
            : `隐私保护：已默认拦截 ${sanitized.remoteImageCount} 项远程图片资源${sanitized.trackingPixelCount > 0 ? `及 ${sanitized.trackingPixelCount} 个疑似追踪像素` : ""}`}
        </Notice>
        {sanitized.hasRemoteImages && (
          <Button type="button" variant="quiet" onClick={() => setAllowRemoteImages((v) => !v)} wrap>
            {allowRemoteImages ? "重新屏蔽远程图片" : "加载此邮件远程图片"}
          </Button>
        )}
      </div>
    )}
    {viewMode === "inert" && html
      ? <iframe title="安全邮件正文" className="mail-html" sandbox="" referrerPolicy="no-referrer" srcDoc={inertBody?.srcDoc} />
      : viewMode === "fidelity" && sanitized
        ? <iframe title="安全邮件正文" className="mail-html" sandbox="" referrerPolicy="no-referrer" srcDoc={fidelitySrcDoc} />
        : <pre data-testid="mail-body">{activePlainText}</pre>}
    <ExternalLinkGuard text={text} html={html} />
    <MailAiAssistantPanel
      subject={subject}
      text={text}
      html={html}
      securityLevel={securityAssessment.level}
    />
  </section>;
}
