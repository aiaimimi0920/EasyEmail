import duckmail from "./duckmail.json" with { type: "json" };
import etempmail from "./etempmail.json" with { type: "json" };
import gptmail from "./gptmail.json" with { type: "json" };
import guerrillamail from "./guerrillamail.json" with { type: "json" };
import im215 from "./im215.json" with { type: "json" };
import mail2925 from "./mail2925.json" with { type: "json" };
import mailtm from "./mailtm.json" with { type: "json" };
import m2u from "./m2u.json" with { type: "json" };
import moemail from "./moemail.json" with { type: "json" };
import cloudflareTempEmail from "./cloudflare_temp_email.json" with { type: "json" };
import tempmailLol from "./tempmail-lol.json" with { type: "json" };
import tmailor from "./tmailor.json" with { type: "json" };
import type { ProviderTypeDefinition } from "../../domain/models.js";
import { toProviderTypeDefinition } from "../validation.js";

export const MAIL_PROVIDER_TYPES: ProviderTypeDefinition[] = [
  toProviderTypeDefinition(duckmail, "provider_types.duckmail"),
  toProviderTypeDefinition(etempmail, "provider_types.etempmail"),
  toProviderTypeDefinition(gptmail, "provider_types.gptmail"),
  toProviderTypeDefinition(guerrillamail, "provider_types.guerrillamail"),
  toProviderTypeDefinition(im215, "provider_types.im215"),
  toProviderTypeDefinition(mail2925, "provider_types.mail2925"),
  toProviderTypeDefinition(mailtm, "provider_types.mailtm"),
  toProviderTypeDefinition(m2u, "provider_types.m2u"),
  toProviderTypeDefinition(moemail, "provider_types.moemail"),
  toProviderTypeDefinition(tempmailLol, "provider_types.tempmail-lol"),
  toProviderTypeDefinition(tmailor, "provider_types.tmailor"),
  toProviderTypeDefinition(cloudflareTempEmail, "provider_types.cloudflare_temp_email"),
];
