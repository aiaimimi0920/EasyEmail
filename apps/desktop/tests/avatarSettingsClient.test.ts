import assert from "node:assert/strict";
import test from "node:test";

import {
  createAvatarSettingsClient,
  type AvatarHttpTransport,
} from "../src/api/avatarSettingsClient.ts";

const DEFAULT_AUTH = {
  spf: { status: "unknown" as const, detail: "SPF not checked" },
  dkim: { status: "unknown" as const, detail: "DKIM not checked" },
  dmarc: { status: "unknown" as const, detail: "DMARC not checked" },
  bimi: { status: "unknown" as const, detail: "BIMI not checked" },
  certificate: { status: "unknown" as const, detail: "Certificate not checked" },
};

test("reads, updates, resolves, overrides, and clears sender avatars over canonical HTTP", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const transport: AvatarHttpTransport = {
    async getMailAvatarSettings() {
      calls.push({ method: "getMailAvatarSettings", args: [] });
      return {
        settings: {
          remoteEnabled: true,
          bimiEnabled: false,
          faviconEnabled: true,
          authEnabled: false,
        },
      };
    },
    async updateMailAvatarSettings(request) {
      calls.push({ method: "updateMailAvatarSettings", args: [request] });
      return {
        settings: {
          remoteEnabled: Boolean(request.remoteEnabled),
          bimiEnabled: Boolean(request.bimiEnabled),
          faviconEnabled: Boolean(request.faviconEnabled),
          authEnabled: Boolean(request.authEnabled),
        },
      };
    },
    async resolveMailSenderAvatars(request) {
      calls.push({ method: "resolveMailSenderAvatars", args: [request] });
      return {
        avatars: [
          {
            sender: "GitHub <noreply@github.com>",
            cacheKey: "sender:noreply@github.com",
            domain: "github.com",
            displayName: "GitHub",
            sourceKind: "official-icon",
            imageDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
            builtinKind: "github",
            fallbackText: "GITH",
            remoteUrl: "https://github.githubassets.com/favicons/favicon.svg",
            auth: DEFAULT_AUTH,
            fetchedAt: "2026-09-25T00:00:00.000Z",
            expiresAt: "2026-10-09T00:00:00.000Z",
          },
        ],
      };
    },
    async setMailContactAvatar(contactId, request) {
      calls.push({ method: "setMailContactAvatar", args: [contactId, request] });
      return {
        avatar: {
          sender: request.sender ?? contactId,
          cacheKey: "sender:ada@example.com",
          domain: "example.com",
          displayName: "Ada",
          sourceKind: "contact",
          imageDataUrl: request.imageDataUrl,
          builtinKind: null,
          fallbackText: "ADA",
          remoteUrl: null,
          auth: DEFAULT_AUTH,
          fetchedAt: "2026-09-25T00:00:00.000Z",
          expiresAt: null,
        },
      };
    },
    async clearMailContactAvatar(contactId) {
      calls.push({ method: "clearMailContactAvatar", args: [contactId] });
      return {
        result: {
          contactId,
          cacheKey: "sender:ada@example.com",
          cleared: true,
        },
      };
    },
    async clearMailAvatarCache(query) {
      calls.push({ method: "clearMailAvatarCache", args: [query] });
      return { result: { deletedCount: 7 } };
    },
  };

  const client = createAvatarSettingsClient(transport);

  const settings = await client.getAvatarSettings();
  assert.deepEqual(settings, {
    remote_enabled: true,
    bimi_enabled: false,
    favicon_enabled: true,
    auth_enabled: false,
  });

  const updated = await client.updateAvatarSettings({
    remote_enabled: false,
    bimi_enabled: true,
    favicon_enabled: false,
    auth_enabled: true,
  });
  assert.deepEqual(updated, {
    remote_enabled: false,
    bimi_enabled: true,
    favicon_enabled: false,
    auth_enabled: true,
  });

  const resolved = await client.resolveSenderAvatars({
    senders: ["GitHub <noreply@github.com>"],
  });
  assert.equal(resolved[0]?.builtin_kind, "github");
  assert.equal(resolved[0]?.source_kind, "official-icon");

  const customAvatar = await client.setContactAvatar({
    sender: "Ada <ada@example.com>",
    image_data_url: "data:image/png;base64,AA==",
  });
  assert.equal(customAvatar.source_kind, "contact");

  const clearedContact = await client.clearContactAvatar({
    sender: "Ada <ada@example.com>",
  });
  assert.equal(clearedContact.cleared, true);

  const clearedCache = await client.clearAvatarCache({ include_contacts: false });
  assert.deepEqual(clearedCache, { deleted_count: 7 });
  assert.equal(calls.length, 6);
});

test("propagates HTTP transport rejection unchanged", async () => {
  const rejection = { code: "INVALID_AVATAR_DATA_URL", message: "Invalid avatar data URL" };
  const transport: AvatarHttpTransport = {
    async getMailAvatarSettings() {
      throw rejection;
    },
    async updateMailAvatarSettings() {
      throw rejection;
    },
    async resolveMailSenderAvatars() {
      throw rejection;
    },
    async setMailContactAvatar() {
      throw rejection;
    },
    async clearMailContactAvatar() {
      throw rejection;
    },
    async clearMailAvatarCache() {
      throw rejection;
    },
  };

  await assert.rejects(
    createAvatarSettingsClient(transport).clearAvatarCache({ include_contacts: true }),
    (caught: unknown) => caught === rejection,
  );
});
