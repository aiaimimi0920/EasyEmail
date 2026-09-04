import { describe, expect, it } from "vitest";
import type { ProviderInstance } from "../../src/domain/models.js";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import {
  createCloudflareAdapter,
  createInstance,
  createMailTmAdapter,
  createProviderType,
  now,
} from "./mailbox-recoverability-fixtures.js";

describe("mailbox recoverability catalog", () => {
  it("exposes provider recoverability profiles through catalog and mailbox plan", () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("mailtm", "Mail.tm"),
        createProviderType("cloudflare_temp_email", "Cloudflare Temp Email"),
      ],
      providerInstances: [
        createInstance("mailtm"),
        createInstance("cloudflare_temp_email", {
          baseUrl: "https://temp.example.test",
          adminAuth: "server-admin-auth",
        }),
      ],
      adapters: [
        createMailTmAdapter(),
        createCloudflareAdapter(),
      ],
    }, now);

    const catalog = service.getCatalog();

    expect(catalog.providerRecoverabilityProfiles).toEqual([
      {
        providerTypeKey: "mailtm",
        providerInstanceId: "mailtm_shared_default",
        recoverabilityLevel: "key_recoverable",
        evidenceStatus: "verified",
        minimumHorizonDays: 90,
        reason: "mailtm_password_relogin_verified",
      },
      {
        providerTypeKey: "cloudflare_temp_email",
        providerInstanceId: "cloudflare_temp_email_shared_default",
        recoverabilityLevel: "recoverable",
        evidenceStatus: "verified",
        minimumHorizonDays: 90,
        reason: "operator_controlled_mailbox_store",
      },
    ]);

    const plan = service.planMailbox({
      hostId: "demo-host",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, now);

    expect(plan.recoverabilityProfile).toEqual({
      providerTypeKey: "mailtm",
      providerInstanceId: "mailtm_shared_default",
      recoverabilityLevel: "key_recoverable",
      evidenceStatus: "verified",
      minimumHorizonDays: 90,
      reason: "mailtm_password_relogin_verified",
    });
  });

  it("marks user-verified same-address providers as recoverable by default", () => {
    const providerKeys: ProviderInstance["providerTypeKey"][] = [
      "cloudflare_temp_email",
      "im215",
      "mail2925",
      "gptmail",
      "moemail",
      "m2u",
    ];
    const service = createBootstrappedEasyEmailService({
      providerTypes: providerKeys.map((key) => createProviderType(key, key)),
      providerInstances: providerKeys.map((key) => createInstance(key)),
      adapters: [],
    }, now);

    expect(service.getCatalog().providerRecoverabilityProfiles).toEqual(
      expect.arrayContaining(providerKeys.map((key) => ({
        providerTypeKey: key,
        providerInstanceId: `${key}_shared_default`,
        recoverabilityLevel: "recoverable",
        evidenceStatus: "verified",
        minimumHorizonDays: 90,
        reason: key === "cloudflare_temp_email"
          ? "operator_controlled_mailbox_store"
          : key === "m2u"
            ? "manual_same_address_recreation_verified"
            : "same_address_recreation_verified",
      }))),
    );
  });

  it("marks live-probed remaining providers with evidence-backed recoverability levels", () => {
    const expected: Array<{
      key: ProviderInstance["providerTypeKey"];
      level: "unrecoverable" | "key_recoverable" | "recoverable";
      evidenceStatus: "undetermined" | "verified";
      reason: string;
    }> = [
      {
        key: "mailtm",
        level: "key_recoverable",
        evidenceStatus: "verified",
        reason: "mailtm_password_relogin_verified",
      },
      {
        key: "temporam",
        level: "recoverable",
        evidenceStatus: "verified",
        reason: "temporam_same_address_stateless_inbox_verified",
      },
      {
        key: "guerrillamail",
        level: "recoverable",
        evidenceStatus: "verified",
        reason: "guerrillamail_same_user_recreation_verified",
      },
      {
        key: "duckmail",
        level: "key_recoverable",
        evidenceStatus: "verified",
        reason: "duckmail_password_relogin_verified",
      },
      {
        key: "tempmail-lol",
        level: "unrecoverable",
        evidenceStatus: "verified",
        reason: "tempmail_lol_historical_token_future_delivery_failed",
      },
      {
        key: "etempmail",
        level: "unrecoverable",
        evidenceStatus: "verified",
        reason: "etempmail_recover_key_invalid_in_live_probe",
      },
    ];

    const service = createBootstrappedEasyEmailService({
      providerTypes: expected.map((item) => createProviderType(item.key, item.key)),
      providerInstances: expected.map((item) => createInstance(item.key)),
      adapters: [],
    }, now);

    expect(service.getCatalog().providerRecoverabilityProfiles).toEqual(
      expect.arrayContaining(expected.map((item) => ({
        providerTypeKey: item.key,
        providerInstanceId: `${item.key}_shared_default`,
        recoverabilityLevel: item.level,
        evidenceStatus: item.evidenceStatus,
        minimumHorizonDays: 90,
        reason: item.reason,
      }))),
    );
  });
});
