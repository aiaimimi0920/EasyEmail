import { useEffect, useState } from "react";
import { errorMessage } from "./api";
import type { NormalMail } from "./normal-inbox";
import type { ServerFolder } from "./normal-server-folders";
import { mutationDestinationEpoch, mutationDestinationFolders } from "./normal-remote-mutations";

export function useNormalMutationDestination(message: NormalMail) {
  const [opened, setOpened] = useState(false), [refresh, setRefresh] = useState(0), [folders, setFolders] = useState<ServerFolder[]>([]);
  const [id, setId] = useState(""), [epochId, setEpochId] = useState(""), [reading, setReading] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController(); setReading(true); setError(""); setFolders([]); setId(""); setEpochId("");
    mutationDestinationFolders(message, controller.signal).then(rows => { if (!controller.signal.aborted) setFolders(rows); })
      .catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [opened, refresh, message.accountId, message.accountRevision, message.epochId, message.serverFolderId, message.id]);
  const folder = folders.find(row => row.id === id);
  useEffect(() => {
    setEpochId(""); if (!folder) return;
    const controller = new AbortController(); setReading(true); setError("");
    mutationDestinationEpoch(message, folder, controller.signal).then(value => { if (!controller.signal.aborted) setEpochId(value); })
      .catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [folder, message.accountId, message.accountRevision, message.epochId, message.id]);
  return { opened, folders, folder, id, epochId, reading, error, select: setId,
    open: () => { setOpened(true); setRefresh(value => value + 1); } };
}
