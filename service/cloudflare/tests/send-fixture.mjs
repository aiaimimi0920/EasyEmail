import { providerFixture } from "./provider-fixture.mjs";

export async function sendFixture(transport = "binding", recipients = ["*"]) {
  const fixture = await providerFixture();
  const config = JSON.parse(fixture.bindings.PROVIDER_CONFIG);
  Object.assign(config[0], { sendTransport: transport, sendRecipients: recipients });
  fixture.bindings.PROVIDER_CONFIG = JSON.stringify(config);
  return fixture;
}

export const sendBody = { to: "recipient@example.test", subject: "发送验收", text: "合成邮件，不是真实投递。" };
export const outgoingPath = (box) => `/api/v1/mailboxes/${box.id}/outgoing`;
export const sendCalls = (f) => f.calls.filter((call) => call.path.endsWith("/send_mail_by_binding") || call.path.endsWith("/send_mail"));
export const sendRequest = (h, cookie, box, key, body = sendBody, extra = {}) => h.request(outgoingPath(box), {
  method: "POST", cookie, body, headers: { "idempotency-key": key }, ...extra,
});
