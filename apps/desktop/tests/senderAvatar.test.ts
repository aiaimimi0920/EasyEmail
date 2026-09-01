import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveSenderAvatar,
  resolveSenderAvatarPresentation,
  senderAvatarMapKey,
  type SenderAvatarDto,
} from "../src/mail/senderAvatar.ts";

function remoteAvatar(overrides: Partial<SenderAvatarDto> = {}): SenderAvatarDto {
  return {
    sender: "Alice <alice@example.com>",
    cache_key: "alice@example.com",
    domain: "example.com",
    display_name: "Alice",
    source_kind: "remote",
    image_data_url: null,
    builtin_kind: null,
    fallback_text: "AL",
    remote_url: null,
    fetched_at: null,
    expires_at: null,
    ...overrides,
  };
}

test("resolves known sender providers and generic fallbacks", () => {
  assert.equal(resolveSenderAvatar("QQ邮箱 <10000@qq.com>").kind, "qq-mail");
  assert.equal(resolveSenderAvatar("ChatGPT <news@updates.openai.com>").kind, "openai");
  assert.equal(resolveSenderAvatar("12306 <12306@rails.com.cn>").kind, "railway-12306");
  assert.equal(resolveSenderAvatar("GitHub <noreply@github.com>").kind, "github");
  assert.equal(resolveSenderAvatar("Google <mail@gmail.com>").kind, "google");

  assert.deepEqual(resolveSenderAvatar("Alice <alice@example.com>"), {
    kind: "generic",
    label: "EXAMPLE mail",
    title: "alice@example.com",
    fallback: "EX",
  });
});

test("normalizes sender map keys independently of display names and case", () => {
  assert.equal(senderAvatarMapKey("Alice <ALICE@Example.COM>"), "alice@example.com");
});

test("uses supported backend avatar metadata and rejects unknown builtin kinds", () => {
  const supported = resolveSenderAvatarPresentation(
    "Alice <alice@example.com>",
    remoteAvatar({
      builtin_kind: "openai",
      fallback_text: "OA",
      remote_url: "https://example.com/icon.png",
    }),
  );
  assert.equal(supported.kind, "openai");
  assert.equal(supported.fallback, "OA");
  assert.equal(supported.title, "https://example.com/icon.png");

  const unknown = resolveSenderAvatarPresentation(
    "Alice <alice@example.com>",
    remoteAvatar({ builtin_kind: "unexpected-provider" }),
  );
  assert.equal(unknown.kind, "generic");
});
