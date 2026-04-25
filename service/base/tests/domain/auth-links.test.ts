import { describe, expect, it } from "vitest";
import {
  extractAuthenticationLinksFromContent,
  extractPrimaryAuthenticationLink,
} from "../../src/domain/auth-links.js";

describe("extractAuthenticationLinksFromContent", () => {
  it("prefers verification action links over footer and social links", () => {
    const links = extractAuthenticationLinksFromContent({
      htmlBody: `
        <html>
          <body>
            <a href="https://replit.com/">Replit</a>
            <a href="https://replit.com/action-code?mode=verifyEmail&token=abc">Verify Now</a>
            <a href="https://twitter.com/Replit">X</a>
          </body>
        </html>
      `,
    });

    expect(links[0]).toEqual({
      url: "https://replit.com/action-code?mode=verifyEmail&token=abc",
      label: "Verify Now",
      source: "html",
    });
    expect(links.some((item) => item.url.includes("twitter.com"))).toBe(false);
  });

  it("extracts text-only verification links when no html body exists", () => {
    const primary = extractPrimaryAuthenticationLink({
      textBody: "Open https://example.com/activate?token=xyz to complete your signup.",
    });

    expect(primary).toEqual({
      url: "https://example.com/activate?token=xyz",
      label: "example.com/activate",
      source: "text",
    });
  });

  it("filters unsubscribe-style links when no actionable auth link exists", () => {
    const links = extractAuthenticationLinksFromContent({
      htmlBody: `
        <a href="https://service.example.com/unsubscribe?id=1">Unsubscribe</a>
        <a href="https://instagram.com/example">Instagram</a>
      `,
    });

    expect(links).toEqual([]);
  });
});
