import { describe, expect, it } from "vitest";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import { markProviderInstanceCooling } from "../../src/service/provider-operational-state.js";

const now = new Date("2026-10-25T12:00:00.000Z");
function cooling() {
  const instance = createBootstrappedEasyEmailService().getSnapshot().instances[0]!;
  return markProviderInstanceCooling({ ...instance, status: "active", metadata: {} }, {
    scope: "credentials", reason: "all_credentials_cooling", now,
  });
}

describe("credential cooldown synchronization", () => {
  it("does not dirty the registry for an unchanged active cooldown", () => {
    const instance = cooling();
    expect(markProviderInstanceCooling(instance, {
      scope: "credentials", reason: "all_credentials_cooling", now: new Date(now.getTime() + 60_000),
    })).toBe(instance);
  });

  it("still updates an expired cooldown or a changed reason", () => {
    const instance = cooling();
    const changed = markProviderInstanceCooling(instance, { scope: "credentials", reason: "different_reason", now });
    expect(changed).not.toBe(instance);
    expect(changed.metadata.operationalCooldownReason).toBe("different_reason");
    const renewed = markProviderInstanceCooling(instance, {
      scope: "credentials", reason: "all_credentials_cooling", now: new Date("2026-10-26T12:00:00.000Z"),
    });
    expect(renewed).not.toBe(instance);
    expect(renewed.metadata.operationalCooldownUntil).not.toBe(instance.metadata.operationalCooldownUntil);
  });
});
