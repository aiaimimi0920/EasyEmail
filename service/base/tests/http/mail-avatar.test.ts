import https from "node:https";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { loadEasyEmailServiceRuntimeConfigFromEnvironment } from "../../src/runtime/config.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";
import { NodeSafeAvatarHttpFetcher } from "../../src/service/avatar-network.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(currentDir, "../../../../apps/desktop/scripts/fixtures");

interface CertModule {
  generateEphemeralLoopbackTlsCertificate(): { certPem: string; keyPem: string };
}

const TINY_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=",
  "base64",
);
const CLEAN_SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#06b6d4"/></svg>',
  "utf8",
);

describe("M7C HTTP Avatar settings, SSRF-hardened TLS fetch, redirects, negative cache, and contact overrides", () => {
  it("enforces HTTPS/DNS/IP/redirect/MIME/size/timeout guards, caches positive & negative results, and manages contact overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-http-avatar-"));
    const apiKey = "m7c-avatar-test-api-key-0123456789abcdef";

    const { generateEphemeralLoopbackTlsCertificate } = (await import(
      pathToFileURL(resolve(fixturesDir, "ephemeral-loopback-tls-cert.mjs")).href
    )) as CertModule;
    const { certPem, keyPem } = generateEphemeralLoopbackTlsCertificate();

    const serverHits: string[] = [];
    const tlsAvatarServer = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
      const host = (req.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
      const reqUrl = req.url ?? "/";
      serverHits.push(`${host}${reqUrl}`);

      if (host === "cloudflare-dns.com" && reqUrl.startsWith("/dns-query")) {
        const parsed = new URL(reqUrl, "https://cloudflare-dns.com");
        const name = parsed.searchParams.get("name") ?? "";
        if (name === "default._bimi.bimi-ok.example") {
          res.writeHead(200, { "content-type": "application/dns-json" });
          res.end(
            JSON.stringify({
              Answer: [{ data: '"v=BIMI1; l=https://cdn.bimi-ok.example/logo.svg;"' }],
            }),
          );
          return;
        }
        if (name === "bimi-ok.example") {
          res.writeHead(200, { "content-type": "application/dns-json" });
          res.end(JSON.stringify({ Answer: [{ data: '"v=spf1 -all"' }] }));
          return;
        }
        res.writeHead(200, { "content-type": "application/dns-json" });
        res.end(JSON.stringify({ Answer: [] }));
        return;
      }

      if (host === "cdn.bimi-ok.example" && reqUrl === "/logo.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml" });
        res.end(CLEAN_SVG_BYTES);
        return;
      }

      if (host === "favicon-ok.example" && reqUrl === "/favicon.ico") {
        res.writeHead(302, { location: "https://cdn.favicon-ok.example/icon.png" });
        res.end();
        return;
      }
      if (host === "cdn.favicon-ok.example" && reqUrl === "/icon.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(TINY_PNG_BYTES);
        return;
      }

      if (host === "http-redirect.example" && reqUrl === "/favicon.ico") {
        res.writeHead(302, { location: "http://cdn.favicon-ok.example/icon.png" });
        res.end();
        return;
      }

      if (host === "loop-redirect.example") {
        const step = Number.parseInt(reqUrl.replace(/\D+/gu, "") || "0", 10);
        res.writeHead(302, { location: `https://loop-redirect.example/hop-${step + 1}.png` });
        res.end();
        return;
      }

      if (host === "oversized.example") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.alloc(300 * 1024, 0x41));
        return;
      }

      if (host === "html-mime.example") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html>not an image</html>");
        return;
      }

      if (host === "slow-timeout.example") {
        setTimeout(() => {
          if (!res.destroyed) {
            res.writeHead(200, { "content-type": "image/png" });
            res.end(TINY_PNG_BYTES);
          }
        }, 600);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });

    const tlsPort = await new Promise<number>((resolvePort, rejectPort) => {
      tlsAvatarServer.once("error", rejectPort);
      tlsAvatarServer.listen(0, "127.0.0.1", () => {
        const addr = tlsAvatarServer.address();
        resolvePort(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    const configPath = join(root, "config.yaml");
    const stateFile = join(root, "state.json").replaceAll("\\", "/");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        "  port: 0",
        `  apiKey: "${apiKey}"`,
        "maintenance:",
        "  enabled: false",
        "persistence:",
        "  enabled: true",
        "  driver: file",
        `  filePath: "${stateFile}"`,
        "",
      ].join("\n"),
      "utf8",
    );

    const baseConfig = await loadEasyEmailServiceRuntimeConfigFromEnvironment({
      EASY_EMAIL_CONFIG_PATH: configPath,
      EASY_EMAIL_STATE_DIR: root,
    });

    const fetcher = new NodeSafeAvatarHttpFetcher({
      timeoutMs: 250,
      dnsTimeoutMs: 250,
      tlsCa: certPem,
      checkServerIdentity: () => undefined,
      async dnsLookup(hostname) {
        if (hostname === "ssrf-loopback.example") {
          return [{ address: "127.0.0.1", family: 4 }];
        }
        if (hostname === "dns-rebind.example") {
          return [
            { address: "93.184.216.34", family: 4 },
            { address: "10.0.0.8", family: 4 },
          ];
        }
        return [{ address: "93.184.216.34", family: 4 }];
      },
      connectOverride() {
        return { connectHost: "127.0.0.1", connectPort: tlsPort, connectFamily: 4 };
      },
    });

    const runtime = await startEasyEmailServiceRuntime({
      sendQueueWorkerEnabled: false,
      config: baseConfig,
      avatarRemoteFetcher: fetcher,
    });

    const headers = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };

    try {
      // 1. Auth guard
      const unauth = await fetch(`${runtime.server.baseUrl}/mail/avatars/settings`);
      expect(unauth.status).toBe(401);

      // 2. Settings read & remoteEnabled=false builtin fallback (zero network hits)
      const initialSettings = (await (
        await fetch(`${runtime.server.baseUrl}/mail/avatars/settings`, { headers })
      ).json()) as { settings: Record<string, boolean> };
      expect(initialSettings.settings).toEqual({
        remoteEnabled: true,
        bimiEnabled: true,
        faviconEnabled: true,
        authEnabled: true,
      });

      await fetch(`${runtime.server.baseUrl}/mail/avatars/settings`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ remoteEnabled: false }),
      });

      const localOnlyRes = await fetch(`${runtime.server.baseUrl}/mail/avatars/resolve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ senders: ["GitHub <noreply@github.com>"] }),
      });
      expect(localOnlyRes.status).toBe(200);
      const localOnlyBody = (await localOnlyRes.json()) as {
        avatars: Array<{ sourceKind: string; builtinKind: string | null; imageDataUrl: string | null }>;
      };
      expect(localOnlyBody.avatars[0]).toMatchObject({
        sourceKind: "builtin",
        builtinKind: "github",
        imageDataUrl: null,
      });
      expect(serverHits).toHaveLength(0);

      // Re-enable remote fetching (with authEnabled=false first to isolate avatar network hits)
      await fetch(`${runtime.server.baseUrl}/mail/avatars/settings`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          remoteEnabled: true,
          bimiEnabled: false,
          faviconEnabled: true,
          authEnabled: false,
        }),
      });

      // 3. Contact avatar override (both Contact ID + missing 404 + unsafe SVG rejection)
      const contactCreateRes = await fetch(`${runtime.server.baseUrl}/mail/contacts`, {
        method: "POST",
        headers,
        body: JSON.stringify({ displayName: "Ada", emailAddress: "ada@favicon-ok.example" }),
      });
      const { contact } = (await contactCreateRes.json()) as { contact: { id: string } };

      const missingContactAvatar = await fetch(
        `${runtime.server.baseUrl}/mail/avatars/contacts/ct_v1_missing`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            imageDataUrl: `data:image/png;base64,${TINY_PNG_BYTES.toString("base64")}`,
          }),
        },
      );
      expect(missingContactAvatar.status).toBe(404);

      const unsafeSvgPut = await fetch(
        `${runtime.server.baseUrl}/mail/avatars/contacts/${encodeURIComponent(contact.id)}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            imageDataUrl: `data:image/svg+xml;base64,${Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64")}`,
          }),
        },
      );
      expect(unsafeSvgPut.status).toBe(400);

      const setContactRes = await fetch(
        `${runtime.server.baseUrl}/mail/avatars/contacts/${encodeURIComponent(contact.id)}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            imageDataUrl: `data:image/png;base64,${TINY_PNG_BYTES.toString("base64")}`,
          }),
        },
      );
      expect(setContactRes.status).toBe(200);
      const setContactBody = (await setContactRes.json()) as { avatar: { sourceKind: string } };
      expect(setContactBody.avatar.sourceKind).toBe("contact");

      // Contact override wins without touching remote network
      const contactResolved = (await (
        await fetch(`${runtime.server.baseUrl}/mail/avatars/resolve`, {
          method: "POST",
          headers,
          body: JSON.stringify({ senders: ["Ada <ada@favicon-ok.example>"] }),
        })
      ).json()) as { avatars: Array<{ sourceKind: string }> };
      expect(contactResolved.avatars[0]?.sourceKind).toBe("contact");
      expect(serverHits).toHaveLength(0);

      const clearContactRes = await fetch(
        `${runtime.server.baseUrl}/mail/avatars/contacts/${encodeURIComponent("ada@favicon-ok.example")}`,
        { method: "DELETE", headers },
      );
      expect(clearContactRes.status).toBe(200);
      expect(await clearContactRes.json()).toMatchObject({ result: { cleared: true } });

      // 4. SSRF, DNS rebinding, unsafe HTTP redirect, redirect loop, MIME, size, and timeout -> negative cache
      const unsafeSenders = [
        "root@localhost",
        "bot@ssrf-loopback.example",
        "bot@dns-rebind.example",
        "bot@http-redirect.example",
        "bot@loop-redirect.example",
        "bot@oversized.example",
        "bot@html-mime.example",
        "bot@slow-timeout.example",
      ];
      const unsafeRes = await fetch(`${runtime.server.baseUrl}/mail/avatars/resolve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ senders: unsafeSenders }),
      });
      expect(unsafeRes.status).toBe(200);
      const unsafeBody = (await unsafeRes.json()) as {
        avatars: Array<{ sender: string; sourceKind: string; imageDataUrl: string | null }>;
      };
      expect(unsafeBody.avatars).toHaveLength(unsafeSenders.length);
      for (const item of unsafeBody.avatars) {
        expect(item.sourceKind).toBe("failed");
        expect(item.imageDataUrl).toBeNull();
      }
      // Loopback/DNS-rebind targets NEVER reached the TLS socket!
      expect(serverHits.some((h) => h.startsWith("ssrf-loopback.example"))).toBe(false);
      expect(serverHits.some((h) => h.startsWith("dns-rebind.example"))).toBe(false);

      const hitsBeforeNegativeCacheReplay = serverHits.length;
      const replayUnsafeRes = await fetch(`${runtime.server.baseUrl}/mail/avatars/resolve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ senders: unsafeSenders }),
      });
      expect(replayUnsafeRes.status).toBe(200);
      expect(serverHits.length).toBe(hitsBeforeNegativeCacheReplay);

      // 5. Valid HTTPS favicon (with safe HTTPS redirect) + BIMI SVG fetch & positive cache
      await fetch(`${runtime.server.baseUrl}/mail/avatars/settings`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ bimiEnabled: true, faviconEnabled: true, authEnabled: true }),
      });

      const validRes = await fetch(`${runtime.server.baseUrl}/mail/avatars/resolve`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          senders: ["News <news@favicon-ok.example>", "Security <sec@bimi-ok.example>"],
        }),
      });
      expect(validRes.status).toBe(200);
      const validBody = (await validRes.json()) as {
        avatars: Array<{
          domain: string;
          sourceKind: string;
          imageDataUrl: string | null;
          auth: { spf: { status: string }; bimi: { status: string } };
        }>;
      };
      const fav = validBody.avatars.find((a) => a.domain === "favicon-ok.example")!;
      expect(fav.sourceKind).toBe("favicon");
      expect(fav.imageDataUrl?.startsWith("data:image/png;base64,")).toBe(true);

      const bimi = validBody.avatars.find((a) => a.domain === "bimi-ok.example")!;
      expect(bimi.sourceKind).toBe("bimi");
      expect(bimi.imageDataUrl?.startsWith("data:image/svg+xml;base64,")).toBe(true);
      expect(bimi.auth.spf.status).toBe("published");
      expect(bimi.auth.bimi.status).toBe("pass");

      const hitsBeforePositiveCacheReplay = serverHits.length;
      await fetch(`${runtime.server.baseUrl}/mail/avatars/resolve`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          senders: ["News <news@favicon-ok.example>", "Security <sec@bimi-ok.example>"],
        }),
      });
      expect(serverHits.length).toBe(hitsBeforePositiveCacheReplay);

      // 6. Clear cache endpoint
      const clearCacheRes = await fetch(
        `${runtime.server.baseUrl}/mail/avatars/cache?includeContacts=false`,
        { method: "DELETE", headers },
      );
      expect(clearCacheRes.status).toBe(200);
      const clearCacheBody = (await clearCacheRes.json()) as { result: { deletedCount: number } };
      expect(clearCacheBody.result.deletedCount).toBeGreaterThanOrEqual(10);
    } finally {
      await runtime.close();
      await new Promise<void>((res) => tlsAvatarServer.close(() => res()));
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
