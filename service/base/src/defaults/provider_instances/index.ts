import duckmailDefault from "./duckmail-default.json" with { type: "json" };
import etempmailDefault from "./etempmail-default.json" with { type: "json" };
import gptmailDefault from "./gptmail-default.json" with { type: "json" };
import guerrillamailDefault from "./guerrillamail-default.json" with { type: "json" };
import im215Default from "./im215-default.json" with { type: "json" };
import mail2925Default from "./mail2925-default.json" with { type: "json" };
import mailtmDefault from "./mailtm-default.json" with { type: "json" };
import m2uDefault from "./m2u-default.json" with { type: "json" };
import moemailDefault from "./moemail-default.json" with { type: "json" };
import tempmailLolDefault from "./tempmail-lol-default.json" with { type: "json" };
import type { ProviderInstance } from "../../domain/models.js";
import { toProviderInstance } from "../validation.js";

function hydrateInstance(seed: ProviderInstance, now: Date): ProviderInstance {
  const timestamp = now.toISOString();

  return {
    ...seed,
    hostBindings: [...seed.hostBindings],
    groupKeys: [...seed.groupKeys],
    metadata: { ...seed.metadata },
    createdAt: seed.createdAt || timestamp,
    updatedAt: seed.updatedAt || timestamp,
  };
}

export function createDefaultProviderInstances(now: Date): ProviderInstance[] {
  return [
    hydrateInstance(toProviderInstance(duckmailDefault, "provider_instances.duckmail-default"), now),
    hydrateInstance(toProviderInstance(etempmailDefault, "provider_instances.etempmail-default"), now),
    hydrateInstance(toProviderInstance(gptmailDefault, "provider_instances.gptmail-default"), now),
    hydrateInstance(toProviderInstance(guerrillamailDefault, "provider_instances.guerrillamail-default"), now),
    hydrateInstance(toProviderInstance(im215Default, "provider_instances.im215-default"), now),
    hydrateInstance(toProviderInstance(mail2925Default, "provider_instances.mail2925-default"), now),
    hydrateInstance(toProviderInstance(mailtmDefault, "provider_instances.mailtm-default"), now),
    hydrateInstance(toProviderInstance(m2uDefault, "provider_instances.m2u-default"), now),
    hydrateInstance(toProviderInstance(moemailDefault, "provider_instances.moemail-default"), now),
    hydrateInstance(toProviderInstance(tempmailLolDefault, "provider_instances.tempmail-lol-default"), now),
  ];
}
