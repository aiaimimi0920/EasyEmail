import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEasyEmailServiceRuntimeConfig } from "../../src/runtime/config.js";
import { configureCloudflareTempEmailProviderInstance } from "../../src/runtime/cloudflare-temp-email-config.js";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import { createCloudflareInstance } from "../providers/cloudflare-temp-email-test-support.js";
import { resolveCloudflareTempEmailConfig } from "../../src/providers/cloudflare_temp_email/connector/configuration.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => new Response(
    input.endsWith("/health_check") ? "ok" : '{"domains":["allowed.example.test"]}',
  )));
  return createBootstrappedEasyEmailService({ providerInstances: [createCloudflareInstance()] });
}

describe("Cloudflare send transport configuration", () => {
  it("propagates explicit runtime binding selection to just the configured instance", async () => {
    const service = setup();
    const config = parseEasyEmailServiceRuntimeConfig({ providers: { cloudflare_temp_email: {
      baseUrl: "https://temp.example.test", instanceId: createCloudflareInstance().id,
      adminAuth: "admin-secret", sendTransport: "binding",
    } } });
    await configureCloudflareTempEmailProviderInstance(service, config);
    const instance = service.findInstanceById(createCloudflareInstance().id)!;
    expect(config.cloudflareTempEmail.sendTransport).toBe("binding");
    expect(instance.metadata.sendTransport).toBe("binding");
    expect(resolveCloudflareTempEmailConfig(instance)?.sendTransport).toBe("binding");
  });

  it("preserves stored opt-in when registration omits it and supports explicit worker reset", async () => {
    const service = setup();
    const request = { instanceId: createCloudflareInstance().id, baseUrl: "https://temp.example.test" };
    await service.registerCloudflareTempEmailRuntime({ ...request, sendTransport: "binding" });
    expect((await service.registerCloudflareTempEmailRuntime(request)).instance.metadata.sendTransport).toBe("binding");
    expect((await service.registerCloudflareTempEmailRuntime({ ...request, sendTransport: "worker" }))
      .instance.metadata.sendTransport).toBe("worker");
  });

  it("does not enable native sending when no mode was configured", () => {
    expect(parseEasyEmailServiceRuntimeConfig({}).cloudflareTempEmail.sendTransport).toBeUndefined();
    expect(resolveCloudflareTempEmailConfig(createCloudflareInstance())?.sendTransport).toBeUndefined();
  });

  it("includes the optional mode in the public registration schema", () => {
    const api = JSON.parse(readFileSync(new URL("../../../../docs/easyemail-openapi.json", import.meta.url), "utf8"));
    const schema = api.components.schemas.RegisterCloudflareTempEmailRuntimeRequest;
    expect(schema.properties.sendTransport).toMatchObject({ type: "string", enum: ["worker", "binding"] });
    expect(schema.required).not.toContain("sendTransport");
  });

  it("does not change an unrelated instance when opting one instance in", async () => {
    const service = setup();
    const original = service.findInstanceById(createCloudflareInstance().id)!;
    const other = { ...original, id: "unrelated-instance", metadata: { ...original.metadata, sendTransport: "worker" } };
    service.saveProviderInstance(other);
    await service.registerCloudflareTempEmailRuntime({ instanceId: original.id, baseUrl: original.connectionRef, sendTransport: "binding" });
    expect(service.findInstanceById(other.id)).toEqual(other);
  });

  it.each(["auto", "native", "", true, 1, null])("rejects invalid runtime mode %s", (sendTransport) => {
    expect(() => parseEasyEmailServiceRuntimeConfig({ providers: { cloudflare_temp_email: { sendTransport } } }))
      .toThrow("sendTransport");
  });

  it("rejects invalid registration before changing the instance", async () => {
    const service = setup();
    const before = service.findInstanceById(createCloudflareInstance().id)!;
    await expect(service.registerCloudflareTempEmailRuntime({
      instanceId: before.id, baseUrl: "https://changed.example.test", sendTransport: "auto" as "binding",
    })).rejects.toThrow("sendTransport");
    expect(service.findInstanceById(before.id)).toEqual(before);
  });
});
