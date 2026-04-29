import { describe, expect, it } from "vitest";
import { normalizeMailProviderTypeKey } from "../../src/domain/models.js";
import { resolveMailStrategyMode } from "../../src/domain/strategy-mode.js";

describe("mail strategy mode", () => {
  it("recognizes guerrillamail as a canonical provider type", () => {
    expect(normalizeMailProviderTypeKey("guerrillamail")).toBe("guerrillamail");
  });

  it("recognizes mail2925, m2u, moemail, im215, tempmail-lol, gptmail and etempmail as canonical provider types", () => {
    expect(normalizeMailProviderTypeKey("mail2925")).toBe("mail2925");
    expect(normalizeMailProviderTypeKey("m2u")).toBe("m2u");
    expect(normalizeMailProviderTypeKey("moemail")).toBe("moemail");
    expect(normalizeMailProviderTypeKey("im215")).toBe("im215");
    expect(normalizeMailProviderTypeKey("tempmail-lol")).toBe("tempmail-lol");
    expect(normalizeMailProviderTypeKey("gptmail")).toBe("gptmail");
    expect(normalizeMailProviderTypeKey("etempmail")).toBe("etempmail");
  });

  it("includes m2u, 2925, tempmail-lol, gptmail, guerrillamail and etempmail in external-api selections", () => {
    const mode = resolveMailStrategyMode({
      providerSelections: ["mailtm", "m2u", "mail2925", "guerrillamail", "moemail", "im215", "duckmail", "tempmail-lol", "etempmail", "gptmail"],
    });

    expect(mode.eligibleProviderGroups).toContain("m2u");
    expect(mode.eligibleProviderGroups).toContain("mail2925");
    expect(mode.eligibleProviderGroups).toContain("tempmail-lol");
    expect(mode.eligibleProviderGroups).toContain("gptmail");
    expect(mode.eligibleProviderGroups).toContain("guerrillamail");
    expect(mode.eligibleProviderGroups).toContain("moemail");
    expect(mode.eligibleProviderGroups).toContain("im215");
    expect(mode.eligibleProviderGroups).toContain("etempmail");
  });
});
