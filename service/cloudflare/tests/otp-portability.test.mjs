import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { before, test } from "node:test";
import { createContext, SourceTextModule } from "node:vm";
import { otpCases } from "./fixtures/otp-cases.mjs";

const sourceUrl = new URL("../../base/src/domain/otp.ts", import.meta.url);
let isolatedModule;

before(async () => {
  const source = await readFile(sourceUrl, "utf8");
  const context = createContext({ TextDecoder });
  isolatedModule = new SourceTextModule(stripTypeScriptTypes(source), {
    context,
    identifier: sourceUrl.href,
  });
  await isolatedModule.link((specifier) => {
    throw new Error(`OTP core must not require a runtime import: ${specifier}`);
  });
  await isolatedModule.evaluate({ timeout: 1000 });
});

function extract(input) {
  const result = isolatedModule.namespace.extractOtpFromContent(input);
  return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
}

function quotedPrintable(value) {
  return Array.from(new TextEncoder().encode(value), (byte) => `=${byte.toString(16).padStart(2, "0").toUpperCase()}`).join("");
}

test("shared core loads without Buffer, process, require or Node imports", () => {
  const globals = new SourceTextModule(
    "export default [typeof Buffer, typeof process, typeof require];",
    { context: isolatedModule.context },
  );
  return globals.link(() => assert.fail("unexpected import"))
    .then(() => globals.evaluate())
    .then(() => assert.deepEqual(Array.from(globals.namespace.default), ["undefined", "undefined", "undefined"]));
});

for (const fixture of otpCases) {
  test(fixture.name, () => assert.deepEqual(extract(fixture.input), fixture.expected));
}

for (const [name, message] of [
  ["ASCII", "Your verification code is 735296."],
  ["Chinese UTF-8", "您的验证码：735296，请勿泄露。"],
  ["UTF-8 BOM", "\uFEFFYour verification code is 735296."],
  ["emoji", "🔐 您的验证码：735296。"],
]) {
  test(`quoted-printable ${name} matches already-decoded content`, () => {
    const encoded = quotedPrintable(message);
    const expected = { code: "735296", source: "text" };
    assert.deepEqual(extract({ textBody: message }), expected);
    assert.deepEqual(extract({ textBody: encoded }), expected);
  });
}

test("quoted-printable HTML and soft line breaks work without Node globals", () => {
  const encoded = quotedPrintable("<p>您的验证码：</p><strong>735296</strong>");
  const wrapped = encoded.match(/.{1,60}/g).join("=\r\n");
  assert.deepEqual(extract({ htmlBody: wrapped }), { code: "735296", source: "html" });
});

test("invalid UTF-8 uses replacement decoding rather than abandoning the whole message", () => {
  const encoded = `=FF=FE${quotedPrintable(" Your verification code is 735296.")}`;
  assert.deepEqual(extract({ textBody: encoded }), { code: "735296", source: "text" });
});

test("the public message extraction facade uses the same portable implementation", () => {
  const result = isolatedModule.namespace.extractOtpCode({
    sender: "sender@example.test",
    textBody: quotedPrintable("Your verification code is 735296."),
  });
  assert.equal(result?.code, "735296");
  assert.equal(result?.source, "text");
});
