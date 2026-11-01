import { connect as smtpConnect } from "./smtp-transport-fixture";
import { connect as imapConnect } from "./normal-imap-transport-fixture";
export function connect(address: { hostname: string }, options: unknown) {
  return address.hostname.startsWith("smtp.") ? smtpConnect(address, options) : imapConnect(address, options);
}
