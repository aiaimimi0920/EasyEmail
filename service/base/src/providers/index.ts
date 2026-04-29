import type { MailProviderTypeKey } from "../domain/models.js";
import { CloudflareTempEmailConnectorAdapter } from "./cloudflare_temp_email/connector/index.js";
import type { MailProviderAdapter } from "./contracts.js";
import { DuckMailProviderAdapter } from "./duckmail/index.js";
import { EtempmailProviderAdapter } from "./etempmail/index.js";
import { GptMailProviderAdapter } from "./gptmail/index.js";
import { GuerrillaMailProviderAdapter } from "./guerrillamail/index.js";
import { Im215ProviderAdapter } from "./im215/index.js";
import { Mail2925ProviderAdapter } from "./mail2925/index.js";
import { MailTmProviderAdapter } from "./mailtm/index.js";
import { M2uProviderAdapter } from "./m2u/index.js";
import { MoemailProviderAdapter } from "./moemail/index.js";
import { TempmailLolProviderAdapter } from "./tempmail_lol/index.js";

export function createDefaultMailProviderAdapters(): MailProviderAdapter[] {
  return [
    new DuckMailProviderAdapter(),
    new EtempmailProviderAdapter(),
    new GptMailProviderAdapter(),
    new Mail2925ProviderAdapter(),
    new MailTmProviderAdapter(),
    new M2uProviderAdapter(),
    new GuerrillaMailProviderAdapter(),
    new MoemailProviderAdapter(),
    new Im215ProviderAdapter(),
    new TempmailLolProviderAdapter(),
    new CloudflareTempEmailConnectorAdapter(),
  ];
}

export function createMailProviderAdapterMap(
  adapters: MailProviderAdapter[],
): Map<MailProviderTypeKey, MailProviderAdapter> {
  const adapterMap = new Map<MailProviderTypeKey, MailProviderAdapter>();
  for (const adapter of adapters) {
    adapterMap.set(adapter.typeKey, adapter);
  }
  return adapterMap;
}

export * from "./contracts.js";
export * from "./duckmail/index.js";
export * from "./etempmail/index.js";
export * from "./gptmail/index.js";
export * from "./guerrillamail/index.js";
export * from "./im215/index.js";
export * from "./mail2925/index.js";
export * from "./mailtm/index.js";
export * from "./m2u/index.js";
export * from "./moemail/index.js";
export * from "./cloudflare_temp_email/connector/index.js";
export * from "./cloudflare_temp_email/control/index.js";
export * from "./cloudflare_temp_email/provisioning/index.js";
export * from "./tempmail_lol/index.js";
