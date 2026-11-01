import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";

export interface TaxonomyChange { id: string; method: "PUT" | "DELETE"; body: Record<string, unknown> }

export function useTaxonomyMutation(path: string, onChanged: () => void) {
  const [pending, setPending] = useState(false), [unresolved, setUnresolved] = useState<TaxonomyChange | null>(null), [error, setError] = useState("");
  const busy = useRef(false), active = useRef(false), held = useRef<TaxonomyChange | null>(null), done = useRef(onChanged);
  done.current = onChanged;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function change(input: TaxonomyChange) {
    if (busy.current) return;
    const current = held.current ?? input;
    held.current = current; busy.current = true; setPending(true); setError(""); setUnresolved(current);
    try {
      await api(`${path}/${current.id}`, current.method, current.body);
      if (active.current) { held.current = null; setUnresolved(null); done.current(); }
    } catch (failure) {
      if (active.current) {
        setError(errorMessage(failure));
        if (failure instanceof ApiError && failure.status < 500 && failure.status !== 429) { held.current = null; setUnresolved(null); }
      }
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  return { pending, unresolved, error, change, clearError: () => setError("") };
}
