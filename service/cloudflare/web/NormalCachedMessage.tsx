import { useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";
import { downloadNormalRaw, type NormalMail } from "./normal-inbox";
import { SafeMailBody } from "./SafeMailBody";
import { AttachmentList } from "./AttachmentList";

function RawDownload({ path }: { path: string }) {
  const request = useRef<AbortController | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  useEffect(() => () => { request.current?.abort(); request.current = null; }, [path]);
  async function download() {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; setPending(true); setError("");
    try { await downloadNormalRaw(path, controller.signal); }
    catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (request.current === controller) { request.current = null; setPending(false); } }
  }
  return <div>{error && <p role="alert">{error}</p>}<button className="secondary" disabled={pending} onClick={() => void download()}>下载原始邮件</button></div>;
}
export function NormalCachedMessage({ path, message }: { path: string; message: NormalMail }) {
  return <>
    <SafeMailBody key={message.id} text={message.textBody} html={message.htmlBody} />
    <AttachmentList key={path} path={path} items={message.attachments} truncated={message.attachmentsTruncated} />
    <RawDownload key={`${path}:raw`} path={path} />
  </>;
}
