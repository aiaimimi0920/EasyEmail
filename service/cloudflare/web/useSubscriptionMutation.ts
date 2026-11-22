import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import { subscriptionPath, type Subscription, type SubscriptionAttempt } from "./subscriptions-api";

export function useSubscriptionMutation(onChanged: () => void) {
  const [attempt, setAttempt] = useState<SubscriptionAttempt | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const held = useRef<SubscriptionAttempt | null>(null), busy = useRef(false), active = useRef(false), changed = useRef(onChanged), uncertain = useRef(false);
  changed.current = onChanged;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function submit(item?: Subscription, readOnly = false) {
    if (busy.current) return;
    const key = crypto.randomUUID();
    const current = held.current ?? (item ? { key, path: subscriptionPath(item),
      receiptPath: `/${item.sourceKind === "normal" ? "normal-subscription-operations" : "subscription-operations"}/${key}`,
      body: { expectedVersion: item.version, hidden: !item.hidden, ...(item.sourceKind === "normal" ? { expectedEpochId: item.epochId } : {}) } } : null);
    if (!current) return;
    held.current = current; busy.current = true; setAttempt(current); setPending(true); setError("");
    try {
      if (readOnly) await api(current.receiptPath);
      else await api(current.path, "PATCH", current.body, { "idempotency-key": current.key });
      if (active.current) { held.current = null; uncertain.current = false; setAttempt(null); changed.current(); }
    } catch (failure) {
      if (active.current) {
        setError(errorMessage(failure));
        if (!readOnly && !uncertain.current && failure instanceof ApiError && failure.status < 500 && failure.status !== 429) {
          held.current = null; setAttempt(null);
          if (failure.status === 409 || failure.status === 404) changed.current();
        } else uncertain.current = true;
      }
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  return { submit, attempt, pending, locked: attempt !== null, error };
}
