import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import type { ContactAttempt, ContactOperation } from "./contacts-api";

export function useContactMutation(onChanged: () => void) {
  const [attempt, setAttempt] = useState<ContactAttempt | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const held = useRef<ContactAttempt | null>(null), busy = useRef(false), active = useRef(false), done = useRef(onChanged);
  done.current = onChanged;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function submit(input?: Omit<ContactAttempt, "key">) {
    if (busy.current) return;
    const current = held.current ?? (input ? { ...input, body: { ...input.body }, key: crypto.randomUUID() } : null);
    if (!current) return;
    held.current = current; busy.current = true; setAttempt(current); setPending(true); setError("");
    try {
      await api<{ operation: ContactOperation }>(current.path, current.method, current.body, { "idempotency-key": current.key });
      if (active.current) { held.current = null; setAttempt(null); done.current(); }
    } catch (failure) {
      if (active.current) {
        setError(errorMessage(failure));
        if (failure instanceof ApiError && failure.status < 500 && failure.status !== 429) { held.current = null; setAttempt(null); }
      }
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  return { submit, attempt, pending, locked: attempt !== null, error };
}
