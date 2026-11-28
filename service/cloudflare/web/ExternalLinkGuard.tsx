import { Button, Disclosure, Notice } from '@neuro/ui';
import { useMemo, useState } from "react";
import { inspectExternalLinkSafety } from "../../base/src/domain/mail-phishing-evaluator";

const HREF_IN_HTML_RE = /\bhref\s*=\s*["'](https?:\/\/[^"'\s<>]+)["']/gi;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"')]+/gi;

function extractUniqueExternalLinks(text: string, html: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const collect = (raw: string) => {
    const cleaned = raw.replace(/[.,;:!?)]+$/, "").trim();
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    found.push(cleaned);
  };
  for (const m of html.matchAll(HREF_IN_HTML_RE)) {
    if (m[1]) collect(m[1]);
    if (found.length >= 25) break;
  }
  if (found.length < 25) {
    for (const m of text.matchAll(URL_IN_TEXT_RE)) {
      if (m[0]) collect(m[0]);
      if (found.length >= 25) break;
    }
  }
  return found;
}

export function ExternalLinkGuard({ text, html }: { text: string; html: string }) {
  const [trustedDomains, setTrustedDomains] = useState<string[]>([]);
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  const links = useMemo(() => extractUniqueExternalLinks(text, html), [text, html]);
  if (links.length === 0) return null;

  const pendingCheck = pendingHref ? inspectExternalLinkSafety(pendingHref, trustedDomains) : null;

  return <Disclosure title={`外部链接安全核验（共 ${links.length} 条外链，默认阻止误触跳转）`}>
    <div className="external-link-guard" aria-label="外部链接安全核验">
      {pendingCheck && pendingCheck.safeHref && (
        <div role="region" aria-label="确认打开外部链接">
          <Notice role={pendingCheck.isPunycode ? "alert" : "status"} tone={pendingCheck.isPunycode ? "danger" : "info"}>
            目标域名：<strong>{pendingCheck.hostname}</strong>
            {pendingCheck.isPunycode ? "（检测到 Punycode 同形异义域名，极可能为仿冒站点！）" : ""}
            <br />
            完整地址：<code>{pendingCheck.safeHref.slice(0, 180)}</code>
          </Notice>
          <div className="row">
            <Button type="button" variant="primary" onClick={() => {
              const verified = inspectExternalLinkSafety(pendingCheck.safeHref!, trustedDomains);
              if (verified.safeHref && (verified.scheme === "https" || verified.scheme === "http")) {
                window.open(verified.safeHref, "_blank", "noopener,noreferrer");
              }
              setPendingHref(null);
            }} wrap>{`确认打开 ${pendingCheck.hostname}`}</Button>
            {!pendingCheck.isPunycode && pendingCheck.scheme === "https" && pendingCheck.registrableDomain && (
              <Button type="button" variant="quiet" onClick={() => {
                setTrustedDomains((prev) => prev.includes(pendingCheck.registrableDomain) ? prev : [...prev, pendingCheck.registrableDomain]);
              }} wrap>{`本次会话信任 ${pendingCheck.registrableDomain}`}</Button>
            )}
            <Button type="button" variant="quiet" onClick={() => setPendingHref(null)} wrap>取消</Button>
          </div>
        </div>
      )}
      <ul>
        {links.map((rawUrl) => {
          const check = inspectExternalLinkSafety(rawUrl, trustedDomains);
          if (!check.safeHref) return null;
          return <li key={rawUrl} className="row">
            <code style={{ overflowWrap: "anywhere", wordBreak: "break-all" }}>{check.hostname}{check.safeHref.slice(check.safeHref.indexOf(check.hostname) + check.hostname.length, check.safeHref.indexOf(check.hostname) + check.hostname.length + 48)}</code>
            {check.requiresConfirmation ? (
              <Button type="button" variant="quiet" onClick={() => setPendingHref(check.safeHref)} wrap>{`核验并打开 ${check.hostname}`}</Button>
            ) : (
              <Button type="button" variant="quiet" onClick={() => {
                window.open(check.safeHref!, "_blank", "noopener,noreferrer");
              }} wrap>{`直接打开已信任域 ${check.hostname}`}</Button>
            )}
          </li>;
        })}
      </ul>
    </div>
  </Disclosure>;
}
