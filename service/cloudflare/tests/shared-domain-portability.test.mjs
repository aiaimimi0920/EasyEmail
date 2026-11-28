import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as nodeModule from "node:module";
import { test } from "node:test";
import { createContext, SourceTextModule } from "node:vm";
import ts from "typescript";

function transpileEsmTypeScript(rawTs) {
  if (typeof nodeModule.stripTypeScriptTypes === "function") {
    return nodeModule.stripTypeScriptTypes(rawTs);
  }
  return ts.transpileModule(rawTs, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}

const MODULE_FILES = [
  "otp.ts",
  "mail-provider-presets.ts",
  "mail-charset-fallback.ts",
  "mail-safe-css-engine.ts",
  "mail-safe-html-engine.ts",
  "mail-phishing-evaluator.ts",
  "mail-image-surface.ts",
  "mail-dom-translation.ts",
  "mail-ai-privacy-guard.ts",
  "mail-inbox-rules.ts",
  "mail-contact-tools.ts",
  "mail-ics-calendar.ts",
];

test("all shared domain engines evaluate in a pure Web VM without Buffer, process, or Node built-ins", async () => {
  const context = createContext({ TextDecoder, TextEncoder, URL, atob, btoa });
  const moduleCache = new Map();

  async function loadIsolated(fileName) {
    if (moduleCache.has(fileName)) return moduleCache.get(fileName);
    const url = new URL(`../../base/src/domain/${fileName}`, import.meta.url);
    const rawTs = await readFile(url, "utf8");
    const mod = new SourceTextModule(transpileEsmTypeScript(rawTs), {
      context,
      identifier: url.href,
    });
    moduleCache.set(fileName, mod);
    await mod.link(async (specifier) => {
      const normalized = specifier.replace(/^\.\//, "").replace(/\.js$/, ".ts");
      if (!MODULE_FILES.includes(normalized)) {
        throw new Error(`Disallowed runtime dependency in shared portable domain: ${specifier}`);
      }
      return loadIsolated(normalized);
    });
    return mod;
  }

  for (const fileName of MODULE_FILES) {
    const mod = await loadIsolated(fileName);
    if (mod.status === "linked") {
      await mod.evaluate({ timeout: 2000 });
    }
  }

  const presetsMod = moduleCache.get("mail-provider-presets.ts");
  assert.equal(presetsMod.namespace.detectMailProviderPreset("user@linux.do")?.id, "linuxdo");

  const guardMod = moduleCache.get("mail-ai-privacy-guard.ts");
  const blocked = guardMod.namespace.evaluateMailPrivacyGuard(
    { enabled: true, provider: "openai", endpointUrl: "https://api.openai.com/v1" },
    { subject: "OTP", textBody: "您的验证码：638291", consentConfirmed: true },
  );
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, "SENSITIVE_MAIL_BLOCKED");
});
