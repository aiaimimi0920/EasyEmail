import { describe, expect, it } from "vitest";
import {
  decodeGuerrillaMailMailboxRef,
  encodeGuerrillaMailMailboxRef,
} from "../../src/providers/guerrillamail/client.js";

describe("guerrillamail mailboxRef", () => {
  it("round-trips encoded mailbox credentials", () => {
    const encoded = encodeGuerrillaMailMailboxRef("inst-1", {
      emailAddress: "demo@example.com",
      emailUser: "demo",
      sidToken: "token-123",
    });

    expect(decodeGuerrillaMailMailboxRef(encoded, "inst-1")).toEqual({
      emailAddress: "demo@example.com",
      emailUser: "demo",
      sidToken: "token-123",
    });
  });

  it("returns undefined for mismatched instance id", () => {
    const encoded = encodeGuerrillaMailMailboxRef("inst-1", {
      emailAddress: "demo@example.com",
      emailUser: "demo",
      sidToken: "token-123",
    });

    expect(decodeGuerrillaMailMailboxRef(encoded, "inst-2")).toBeUndefined();
  });
});
