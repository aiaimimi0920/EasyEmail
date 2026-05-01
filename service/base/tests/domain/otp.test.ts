import { describe, expect, it } from "vitest";
import { extractOtpFromContent } from "../../src/domain/otp.js";

describe("extractOtpFromContent", () => {
  it("prefers contextual verification codes over unrelated numbers", () => {
    const extracted = extractOtpFromContent({
      subject: "Order #834211 has shipped",
      textBody: "Your verification code is 654321. Ignore tracking number 834211.",
    });

    expect(extracted).toMatchObject({
      code: "654321",
      source: "text",
    });
  });

  it("rejects suspicious standalone order-like numbers without verification context", () => {
    const extracted = extractOtpFromContent({
      textBody: "Order number 123456 has been processed successfully.",
    });

    expect(extracted).toBeUndefined();
  });

  it("still accepts a single subject-only six digit code when no better context exists", () => {
    const extracted = extractOtpFromContent({
      subject: "731942",
    });

    expect(extracted).toEqual({
      code: "731942",
      source: "subject",
    });
  });

  it("avoids ambiguous multiple standalone codes with no verification context", () => {
    const extracted = extractOtpFromContent({
      textBody: "Use room 112233 and invoice 445566 for support.",
    });

    expect(extracted).toBeUndefined();
  });

  it("accepts five-digit numeric codes when verification context is present", () => {
    const extracted = extractOtpFromContent({
      textBody: "Your login code is 48392 and expires in 10 minutes.",
    });

    expect(extracted).toEqual({
      code: "48392",
      source: "text",
    });
  });

  it("accepts alphanumeric verification tokens with strong context", () => {
    const extracted = extractOtpFromContent({
      textBody: "Verification code: A7X9Q2. Enter it to continue.",
    });

    expect(extracted).toEqual({
      code: "A7X9Q2",
      source: "text",
    });
  });

  it("accepts pure uppercase character verification codes with strong context", () => {
    const extracted = extractOtpFromContent({
      textBody: "Your verification code is QWERTY. Enter it to continue.",
    });

    expect(extracted).toEqual({
      code: "QWERTY",
      source: "text",
    });
  });

  it("accepts grouped longer tokens with strong context", () => {
    const extracted = extractOtpFromContent({
      textBody: "Use confirmation code ZX-41Q8-PLM7 to finish linking this device.",
    });

    expect(extracted).toEqual({
      code: "ZX-41Q8-PLM7",
      source: "text",
    });
  });

  it("does not truncate longer grouped tokens in contextual code phrases", () => {
    const extracted = extractOtpFromContent({
      textBody: "Account 220044 requires confirmation. Verification code: ZX-41Q8-PLM7. Ignore ticket 771199.",
    });

    expect(extracted).toEqual({
      code: "ZX-41Q8-PLM7",
      source: "text",
    });
  });

  it("keeps six digit numeric companions available when a longer token also appears", () => {
    const extracted = extractOtpFromContent({
      textBody: "Verification code: PByiiEBh0KJ2FbhUKD. Backup login code: 654321.",
    });

    expect(extracted).toBeDefined();
    expect(extracted).toMatchObject({
      code: "654321",
      source: "text",
    });
  });

  it("extracts numeric OTP cores when html strips whitespace between the code and nearby words", () => {
    const extracted = extractOtpFromContent({
      htmlBody: "<div>Your one-time verification code is <strong>445566Use</strong> this to continue.</div>",
      textBody: "Your one-time verification code is 445566Use this to continue.",
    });

    expect(extracted).toMatchObject({
      code: "445566",
      source: "text",
    });
  });

  it("prefers compact mixed verification codes over backup numeric ids", () => {
    const extracted = extractOtpFromContent({
      htmlBody: "<div>Primary code: <strong>A1B2C3</strong>. Ignore backup id 998877.</div>",
      textBody: "Primary code: A1B2C3. Ignore backup id 998877.",
    });

    expect(extracted).toMatchObject({
      code: "A1B2C3",
      source: "text",
    });
  });

  it("trims fused mixed verification codes when html stripping glues a trailing word", () => {
    const extracted = extractOtpFromContent({
      textBody: "Order #20260428Primary code: A1B2C3Ignore backup id 998877.",
    });

    expect(extracted).toMatchObject({
      code: "A1B2C3",
      source: "text",
    });
  });

  it("decodes quoted-printable html before extracting Chinese ChatGPT verification codes", () => {
    const extracted = extractOtpFromContent({
      htmlBody: `
        <html>
          <head>
            <style type=3D"text/css">
              @font-face {
                font-family: "S=C3=B6hne";
              }
            </style>
          </head>
          <body>
            <p>=E8=BE=93=E5=85=A5=E6=AD=A4=E4=B8=B4=E6=97=B6=E9=AA=8C=E8=AF=81=E7=A0=81=E4=BB=A5=E7=BB=A7=E7=BB=AD=EF=BC=9A</p>
            <p>735296</p>
          </body>
        </html>
      `,
    });

    expect(extracted).toEqual({
      code: "735296",
      source: "html",
    });
  });
});
