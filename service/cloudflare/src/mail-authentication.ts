import { HttpError } from "./http";

// A string is the legacy password contract. OAuth tokens require an explicit method;
// this internal type is not a public token-import or OAuth authorization API.
export type MailAuthentication = string | { method: "xoauth2"; accessToken: string };
export interface SaslAuthentication { mechanism: "PLAIN" | "XOAUTH2"; response: string }
const utf8 = new TextEncoder();
function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
    && new TextDecoder().decode(utf8.encode(value)) === value;
}
export function assertMailAuthentication(username: string, authentication: MailAuthentication): void {
  let valid = validText(username, 255);
  if (typeof authentication === "string") valid = valid && validText(authentication, 1024);
  else valid = valid && !!authentication && typeof authentication === "object" && !Array.isArray(authentication)
    && Object.keys(authentication).length === 2 && Object.hasOwn(authentication, "method") && Object.hasOwn(authentication, "accessToken")
    && authentication.method === "xoauth2" && typeof authentication.accessToken === "string"
    && authentication.accessToken.length <= 4096 && /^[A-Za-z0-9._~+/-]+=*$/.test(authentication.accessToken);
  if (!valid) throw new HttpError(400, "invalid_mail_authentication");
}
export function mailSasl(username: string, authentication: MailAuthentication): SaslAuthentication {
  assertMailAuthentication(username, authentication);
  const mechanism = typeof authentication === "string" ? "PLAIN" : "XOAUTH2";
  const value = typeof authentication === "string" ? `\0${username}\0${authentication}`
    : `user=${username}\x01auth=Bearer ${authentication.accessToken}\x01\x01`;
  return { mechanism, response: btoa(Array.from(utf8.encode(value), byte => String.fromCharCode(byte)).join("")) };
}
