import { useEffect, useState } from "react";
import { errorMessage } from "./api";
import type { NormalMail } from "./normal-inbox";
import { latestRemoteMutation } from "./normal-remote-mutations";
import type { RemoteMutationOperation } from "./normal-remote-mutation-model";
import { useNormalRemoteMutations } from "./NormalRemoteMutations";

export function useNormalMutationRecord(message: NormalMail) {
  const action = useNormalRemoteMutations(), [operation, setOperation] = useState<RemoteMutationOperation | null>(null);
  const [reading, setReading] = useState(true), [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const identity = JSON.stringify([message.accountId, message.id, message.serverFolderId, message.epochId, message.accountRevision, message.uid, action.revision]);
  const [loaded, setLoaded] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setReading(true); setError(""); setOperation(null);
    latestRemoteMutation(message, controller.signal).then(row => { if (!controller.signal.aborted) setOperation(row); })
      .catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) { setLoaded(identity); setReading(false); } });
    return () => controller.abort();
  }, [identity, refresh]);
  const current = loaded === identity;
  return { operation: current ? operation : null, reading: reading || !current, error: current ? error : "", refresh: () => setRefresh(value => value + 1),
    locked: action.locked || !current || reading || !!error || (operation !== null && operation.state !== "failed") };
}
export type NormalMutationRecord = ReturnType<typeof useNormalMutationRecord>;
