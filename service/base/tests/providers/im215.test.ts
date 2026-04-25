import { describe, expect, it } from "vitest";
import {
  decodeIm215MailboxRef,
  encodeIm215MailboxRef,
} from "../../src/providers/im215/client.js";

describe("im215 mailboxRef", () => {
  it("round-trips encoded mailbox credentials", () => {
    const encoded = encodeIm215MailboxRef("inst-1", {
      address: "demo@215.im",
      mailboxId: "mailbox-123",
      domain: "215.im",
      tempToken: "tmp_abc",
    });

    expect(decodeIm215MailboxRef(encoded, "inst-1")).toEqual({
      address: "demo@215.im",
      mailboxId: "mailbox-123",
      domain: "215.im",
      tempToken: "tmp_abc",
      createdAt: undefined,
    });
  });

  it("returns undefined for mismatched instance id", () => {
    const encoded = encodeIm215MailboxRef("inst-1", {
      address: "demo@215.im",
    });

    expect(decodeIm215MailboxRef(encoded, "inst-2")).toBeUndefined();
  });
});
