import {
  buildSandboxedReaderDocument,
  sanitizeSafeMailHtml,
} from "../../../../service/base/src/domain/mail-safe-html-engine";

export function buildDesktopMailFrameSrcDoc(rawHtml: string): string {
  const sanitized = sanitizeSafeMailHtml(rawHtml, { allowRemoteImages: false });
  return buildSandboxedReaderDocument({
    html: sanitized.html,
    css: sanitized.css,
    schemeMode: "paper-light",
    allowRemoteImages: false,
  });
}
