import assert from "node:assert/strict";
import test from "node:test";

import { EasyEmailClient } from "../dist/index.js";

test("M7C Avatar SDK methods call canonical /mail/avatars/* HTTP routes", async () => {
  const calls = [];
  const defaultAuth = {
    spf: { status: "unknown", detail: "SPF not checked" },
    dkim: { status: "unknown", detail: "DKIM not checked" },
    dmarc: { status: "unknown", detail: "DMARC not checked" },
    bimi: { status: "unknown", detail: "BIMI not checked" },
    certificate: { status: "unknown", detail: "Cert not checked" },
  };
  const client = new EasyEmailClient({
    baseUrl: "http://127.0.0.1:18086",
    apiKey: "sdk-m7c-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body });
      const parsed = new URL(url);
      if (parsed.pathname === "/mail/avatars/settings" && init.method === "GET") {
        return new Response(
          JSON.stringify({
            settings: {
              remoteEnabled: true,
              bimiEnabled: true,
              faviconEnabled: true,
              authEnabled: true,
            },
          }),
          { status: 200 },
        );
      }
      if (parsed.pathname === "/mail/avatars/settings" && init.method === "PATCH") {
        return new Response(
          JSON.stringify({
            settings: {
              remoteEnabled: false,
              bimiEnabled: true,
              faviconEnabled: true,
              authEnabled: false,
            },
          }),
          { status: 200 },
        );
      }
      if (parsed.pathname === "/mail/avatars/resolve" && init.method === "POST") {
        return new Response(
          JSON.stringify({
            avatars: [
              {
                sender: "GitHub <noreply@github.com>",
                cacheKey: "sender:noreply@github.com",
                domain: "github.com",
                displayName: "GitHub",
                sourceKind: "builtin",
                imageDataUrl: null,
                builtinKind: "github",
                fallbackText: "GITH",
                remoteUrl: null,
                auth: defaultAuth,
                fetchedAt: null,
                expiresAt: null,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (parsed.pathname.startsWith("/mail/avatars/contacts/") && init.method === "PUT") {
        return new Response(
          JSON.stringify({
            avatar: {
              sender: "Ada <ada@example.com>",
              cacheKey: "sender:ada@example.com",
              domain: "example.com",
              displayName: "Ada",
              sourceKind: "contact",
              imageDataUrl: "data:image/png;base64,AA==",
              builtinKind: null,
              fallbackText: "ADA",
              remoteUrl: null,
              auth: defaultAuth,
              fetchedAt: "2026-09-25T00:00:00.000Z",
              expiresAt: null,
            },
          }),
          { status: 200 },
        );
      }
      if (parsed.pathname.startsWith("/mail/avatars/contacts/") && init.method === "DELETE") {
        return new Response(
          JSON.stringify({
            result: { contactId: "ada@example.com", cacheKey: "sender:ada@example.com", cleared: true },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ result: { deletedCount: 5 } }), { status: 200 });
    },
  });

  const settings = await client.getMailAvatarSettings();
  assert.equal(settings.remoteEnabled, true);

  const updated = await client.updateMailAvatarSettings({ remoteEnabled: false, authEnabled: false });
  assert.equal(updated.remoteEnabled, false);

  const resolved = await client.resolveMailSenderAvatars({ senders: ["GitHub <noreply@github.com>"] });
  assert.equal(resolved[0]?.builtinKind, "github");

  const contactAvatar = await client.setMailContactAvatar("Ada <ada@example.com>", {
    imageDataUrl: "data:image/png;base64,AA==",
  });
  assert.equal(contactAvatar.sourceKind, "contact");
  assert.match(calls[3].url, /\/mail\/avatars\/contacts\/Ada%20%3Cada%40example\.com%3E$/);

  const clearedContact = await client.clearMailContactAvatar("ada@example.com");
  assert.equal(clearedContact.cleared, true);

  const clearedCache = await client.clearMailAvatarCache({ includeContacts: true });
  assert.equal(clearedCache.deletedCount, 5);
  assert.match(calls[5].url, /\/mail\/avatars\/cache\?includeContacts=true$/);
});
