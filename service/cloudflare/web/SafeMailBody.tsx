import { useMemo, useState } from "react";
import DOMPurify from "dompurify";

function inertDocument(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "div", "span", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i",
      "u", "s", "del", "blockquote", "pre", "code", "ul", "ol", "li", "hr", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "a"],
    ALLOWED_ATTR: [], ALLOW_ARIA_ATTR: false, ALLOW_DATA_ATTR: false,
    FORBID_CONTENTS: ["script", "style", "iframe", "object", "embed", "svg", "math", "form", "template"],
  });
  // No mail-provided URL, attribute, CSS or active content crosses this separate sandbox boundary.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"></head><body>${clean}</body></html>`;
}

function HtmlBody({ html }: { html: string }) {
  const document = useMemo(() => inertDocument(html), [html]);
  return <iframe title="安全邮件正文" className="mail-html" sandbox="" referrerPolicy="no-referrer" srcDoc={document} />;
}

export function SafeMailBody({ text, html }: { text: string; html: string }) {
  const [showHtml, setShowHtml] = useState(false);
  return <section aria-label="邮件正文">
    {html && <div className="row">
      <button className="secondary" aria-pressed={!showHtml} onClick={() => setShowHtml(false)}>纯文本</button>
      <button className="secondary" aria-pressed={showHtml} onClick={() => setShowHtml(true)}>安全 HTML</button>
    </div>}
    {showHtml && html ? <HtmlBody html={html} /> : <pre data-testid="mail-body">{text || html || "（无正文）"}</pre>}
  </section>;
}
