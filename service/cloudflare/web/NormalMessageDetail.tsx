import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { normalMessagePath, type NormalMail, type NormalMailSummary } from "./normal-inbox";
import { NormalMessageContent } from "./NormalMessageContent";
import { useNormalOrganization } from "./NormalOrganization";
import { useNormalRemoteFlags } from "./NormalRemoteFlags";

export function NormalMessageDetail({ accountId, id, serverFolderId, serverFolderName }: Pick<NormalMailSummary, "accountId" | "id" | "serverFolderId" | "serverFolderName">) {
  const [message, setMessage] = useState<NormalMail | null>(null), [error, setError] = useState("");
  const action = useNormalOrganization(), remoteFlags = useNormalRemoteFlags();
  const path = normalMessagePath({ accountId, id, serverFolderId });
  useEffect(() => {
    setMessage(null); setError("");
    const controller = new AbortController();
    api<{ message: NormalMail }>(path, "GET", undefined, undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setMessage({ ...value.message, serverFolderId, serverFolderName }); })
      .catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [path, serverFolderId, serverFolderName, action.revision, remoteFlags.revision]);
  return <article>{error && <p role="alert">{error}</p>}{!message && !error && <p role="status">读取邮件…</p>}
    {message && <NormalMessageContent message={message} />}</article>;
}
