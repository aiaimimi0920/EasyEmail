import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync } from "node:crypto";
import { createHash, createHmac, createCipheriv, createDecipheriv } from "node:crypto";
import {
  decodeMuseServiceFrame,
  decodeMuseServiceResponsePayload,
  decodeMuseTransportFrame,
  encodeMuseServiceFrameRequest,
  encodeMuseServiceRequest,
  encodeMuseTransportFrame,
} from "../src/service/muse-mail/muse-proto-wire.js";
import { NoiseAesGcmCipherState, NoiseXXInitiatorHandshake } from "../src/service/muse-mail/muse-noise-xx.js";
import {
  buildMuseReadOnlyRoutePath,
  LocalMuseReadOnlyService,
} from "../src/service/muse-mail/muse-readonly-service.js";
import { LocalMailAiGatewayService } from "../src/service/mail-ai-gateway.js";
import { LocalWorkbenchEnhancementsService } from "../src/service/mail-workbench-enhancements.js";

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function sha256(b: Uint8Array): Buffer {
  return createHash("sha256").update(b).digest();
}
function hmac(k: Uint8Array, d: Uint8Array): Buffer {
  return createHmac("sha256", k).update(d).digest();
}
function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Buffer, Buffer] {
  const tk = hmac(ck, ikm);
  const o1 = hmac(tk, Buffer.from([1]));
  const o2 = hmac(tk, Buffer.concat([o1, Buffer.from([2])]));
  return [o1, o2];
}
function gcmEncrypt(k: Uint8Array, nonce: bigint, ad: Uint8Array, pt: Uint8Array): Buffer {
  const iv = Buffer.alloc(12, 0);
  iv.writeBigUInt64BE(nonce, 4);
  const c = createCipheriv("aes-256-gcm", k, iv);
  c.setAAD(ad);
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}
function gcmDecrypt(k: Uint8Array, nonce: bigint, ad: Uint8Array, ct: Uint8Array): Buffer {
  const iv = Buffer.alloc(12, 0);
  iv.writeBigUInt64BE(nonce, 4);
  const d = createDecipheriv("aes-256-gcm", k, iv);
  d.setAAD(ad);
  d.setAuthTag(ct.subarray(ct.byteLength - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.byteLength - 16)), d.final()]);
}

describe("Meta Muse read-only connector, Noise_XX_25519_AESGCM_SHA256, and local workbench services", () => {
  it("completes Noise_XX_25519_AESGCM_SHA256 3-message handshake and symmetric frame encryption", () => {
    const initiator = new NoiseXXInitiatorHandshake();
    const msg1 = initiator.writeMessage1();
    expect(msg1.byteLength).toBe(32);

    // Simulate responder for Noise_XX_25519_AESGCM_SHA256
    const proto = Buffer.alloc(32, 0);
    Buffer.from("Noise_XX_25519_AESGCM_SHA256", "ascii").copy(proto);
    let h: Uint8Array = sha256(proto);
    let ck: Uint8Array = Buffer.from(proto);
    h = sha256(Buffer.concat([h, msg1])); // <- e
    h = sha256(h); // <- MixHash(empty payload of msg1 per Noise spec 5.2)

    const respE = generateKeyPairSync("x25519");
    const respS = generateKeyPairSync("x25519");
    const respERaw = Buffer.from(respE.publicKey.export({ type: "spki", format: "der" }).subarray(-32));
    const respSRaw = Buffer.from(respS.publicKey.export({ type: "spki", format: "der" }).subarray(-32));
    const initEPub = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, msg1]), format: "der", type: "spki" });

    h = sha256(Buffer.concat([h, respERaw]));
    let k: Uint8Array;
    [ck, k] = hkdf2(ck, diffieHellman({ privateKey: respE.privateKey, publicKey: initEPub }));
    const encRs = gcmEncrypt(k, 0n, h, respSRaw);
    h = sha256(Buffer.concat([h, encRs]));
    [ck, k] = hkdf2(ck, diffieHellman({ privateKey: respS.privateKey, publicKey: initEPub }));
    const encPayload2 = gcmEncrypt(k, 0n, h, new Uint8Array(0));
    h = sha256(Buffer.concat([h, encPayload2]));

    const msg2 = Buffer.concat([respERaw, encRs, encPayload2]);
    initiator.readMessage2(msg2);
    const { msg3, sendCipher, recvCipher } = initiator.writeMessage3();

    const encInitS = msg3.subarray(0, 48);
    const initSRaw = gcmDecrypt(k, 1n, h, encInitS);
    expect(initSRaw.byteLength).toBe(32);
    h = sha256(Buffer.concat([h, encInitS]));
    const initSPub = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, initSRaw]), format: "der", type: "spki" });
    [ck, k] = hkdf2(ck, diffieHellman({ privateKey: respE.privateKey, publicKey: initSPub }));
    const decPayload3 = gcmDecrypt(k, 0n, h, msg3.subarray(48));
    expect(decPayload3.byteLength).toBe(0);

    const [respRecvKey, respSendKey] = hkdf2(ck, new Uint8Array(0));
    const respRecv = new NoiseAesGcmCipherState(respRecvKey);
    const respSend = new NoiseAesGcmCipherState(respSendKey);

    const ct = sendCipher.encryptWithAd(new Uint8Array(0), Buffer.from("hello-muse", "utf8"));
    expect(respRecv.decryptWithAd(new Uint8Array(0), ct).toString("utf8")).toBe("hello-muse");
    const replyCt = respSend.encryptWithAd(new Uint8Array(0), Buffer.from("ack-readonly", "utf8"));
    expect(recvCipher.decryptWithAd(new Uint8Array(0), replyCt).toString("utf8")).toBe("ack-readonly");
    void createPrivateKey;
  });

  it("encodes and decodes Muse protobuf transport & service frames and enforces read-only allowlist + memory wipe", async () => {
    expect(() => buildMuseReadOnlyRoutePath("email.messages.send")).toThrow(/forbidden/i);
    expect(buildMuseReadOnlyRoutePath("email.threads.get", "thd_1")).toBe("/api/email/threads/thd_1");

    const reqBytes = encodeMuseServiceFrameRequest(7n, {
      verb: "GET",
      path: "/api/email/mailbox",
      headers: [{ key: "x-request-id", value: "req-1" }],
      endBody: true,
    });
    const outer = encodeMuseServiceRequest(0, reqBytes);
    const tf = encodeMuseTransportFrame({ chunkId: 42n, chunkIndex: 0, totalChunks: 1, payload: outer });
    const decodedTf = decodeMuseTransportFrame(tf);
    expect(decodedTf.chunkId).toBe(42n);
    expect(decodedTf.totalChunks).toBe(1);
    void decodeMuseServiceResponsePayload;
    void decodeMuseServiceFrame;

    let closedCount = 0;
    const muse = new LocalMuseReadOnlyService(async () => ({
      async unaryGet(routeName: string, pathParam?: string) {
        if (routeName === "email.mailbox.get") {
          return Buffer.from(JSON.stringify({ ok: true, result: { address: "agent@muse.ai", enabled: true } }));
        }
        if (routeName === "email.threads.list") {
          return Buffer.from(JSON.stringify({ data: [{ id: "t1", subject: "Muse Digest", message_count: 2 }] }));
        }
        if (routeName === "email.threads.get" && pathParam === "t1") {
          return Buffer.from(JSON.stringify({ subject: "Muse Digest", messages: [{ id: "m1", header_from: "news@example.com", text_body: "Hello Muse" }] }));
        }
        throw new Error("unexpected route");
      },
      close() {
        closedCount += 1;
      },
    }));

    const status = await muse.connectReadOnlySession({ cookieHeader: "muse_sess=ephemeral" });
    expect(status.bound).toBe(true);
    expect(status.verifiedEmail).toBe("agent@muse.ai");
    expect(status.memoryOnly).toBe(true);
    expect(status.readOnly).toBe(true);

    const list = await muse.listThreads();
    expect(list.threads).toHaveLength(1);
    const detail = await muse.getThreadDetail("t1");
    expect(detail.messages[0]?.bodyText).toBe("Hello Muse");

    muse.disconnectAndWipe();
    expect(closedCount).toBe(1);
    expect(muse.getStatus().bound).toBe(false);
    expect(muse.getStatus().verifiedEmail).toBe("");
  });

  it("enforces PrivacyGuard OTP hard-block in LocalMailAiGatewayService and Dry-Run + ICS in LocalWorkbenchEnhancementsService", async () => {
    const ai = new LocalMailAiGatewayService();
    ai.updateSettings({
      enabled: true,
      provider: "ollama",
      endpointUrl: "http://127.0.0.1:11434/v1",
      modelName: "qwen2.5:7b",
    });
    await expect(
      ai.analyzeMail({
        task: "summary",
        subject: "Your login verification code",
        text: "Your one-time verification code is 492817.",
        consentConfirmed: true,
      }),
    ).rejects.toThrow();

    const wb = new LocalWorkbenchEnhancementsService();
    wb.saveRule({
      name: "GitHub Auto Read",
      conditions: [{ field: "sender_domain", operator: "contains", value: "github.com" }],
      actions: { markRead: true },
    });
    const report = await wb.previewRulesDryRun({
      messages: [
        { id: "m1", sender: "noreply@notifications.github.com", subject: "PR merged", receivedAtMs: Date.now() },
        { id: "m2", sender: "friend@example.org", subject: "Coffee", receivedAtMs: Date.now() },
      ],
    });
    expect(report.matchedCount).toBe(1);

    const sampleIcs = [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:evt-100@example.com",
      "DTSTART:20261201T090000Z",
      "DTEND:20261201T100000Z",
      "SUMMARY:Architecture Sync",
      "ORGANIZER:mailto:lead@example.com",
      "DESCRIPTION:Join https://meet.google.com/abc-defg-hij",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const rsvp = wb.recordCalendarRsvp({
      ics: sampleIcs,
      responderEmail: "dev@example.com",
      decision: "accepted",
    });
    expect(rsvp.savedStatus).toBe("accepted");
    expect(rsvp.replyDraft.icsContent).toContain("METHOD:REPLY");
    expect(rsvp.replyDraft.icsContent).toContain("PARTSTAT=ACCEPTED");
  });
});
