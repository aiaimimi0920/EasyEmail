import { Notice } from '@neuro/ui';
import { useMemo } from "react";
import { evaluateMailPhishingSecurity } from "../../base/src/domain/mail-phishing-evaluator";

export function MailSecurityBanner({ sender, replyAddress, authenticationResults, html, attachmentFilenames }: {
  sender?: string;
  replyAddress?: string | null;
  authenticationResults?: string;
  html?: string;
  attachmentFilenames?: readonly string[];
}) {
  const verdict = useMemo(() => {
    if (!sender && !html && (!attachmentFilenames || attachmentFilenames.length === 0)) return null;
    return evaluateMailPhishingSecurity({
      senderHeader: sender,
      replyToAddresses: replyAddress ? [replyAddress] : [],
      authenticationResultsHeader: authenticationResults,
      htmlBody: html,
      attachmentFilenames,
    });
  }, [sender, replyAddress, authenticationResults, html, attachmentFilenames]);

  if (!verdict || verdict.level === "safe") return null;

  const authBadges = [
    verdict.spf !== "none" ? `SPF=${verdict.spf}` : "",
    verdict.dkim !== "none" ? `DKIM=${verdict.dkim}` : "",
    verdict.dmarc !== "none" ? `DMARC=${verdict.dmarc}` : "",
  ].filter(Boolean).join(" · ");

  return <Notice role={verdict.level === "danger" ? "alert" : "status"} tone={verdict.level === "danger" ? "danger" : "info"}>
    <strong>{verdict.title}</strong>
    {authBadges ? ` (${authBadges})` : ""}：{verdict.reasons.join("；")}
  </Notice>;
}
