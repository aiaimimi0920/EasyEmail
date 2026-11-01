import { useEffect, useState } from "react";
import type { Mailbox } from "./api";

export function mailboxExpired(mailbox: Mailbox): boolean {
  return mailbox.expired || mailbox.expiredAt !== null || (mailbox.expiresAt !== null && mailbox.expiresAt * 1000 <= Date.now());
}

export function useMailboxExpiry(mailboxes: readonly Mailbox[]): void {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const next = Math.min(...mailboxes.filter((box) => box.expiresAt !== null && box.expiresAt * 1000 > Date.now()).map((box) => box.expiresAt! * 1000));
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setTick((value) => value + 1), Math.min(2147483647, Math.max(1, next - Date.now() + 10)));
    return () => window.clearTimeout(timer);
  }, [mailboxes, tick]);
}
