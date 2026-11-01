export type CloudflareTempEmailSendTransport = "worker" | "binding";

export function parseCloudflareSendTransport(value: unknown): CloudflareTempEmailSendTransport | undefined {
  if (value === undefined) return undefined;
  if (value === "worker" || value === "binding") {
    return value;
  }
  throw new Error("Cloudflare Temp Email sendTransport must be worker or binding.");
}
