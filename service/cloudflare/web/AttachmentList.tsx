import { useEffect, useRef, useState } from "react";
import { attachmentFilename, MAX_ATTACHMENT_BYTES } from "../src/attachment-policy";
import { ApiError, errorMessage, type Attachment } from "./api";

export function AttachmentList({ path, items, truncated }: { path: string; items: Attachment[]; truncated: boolean }) {
  const request = useRef<AbortController | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => () => { request.current?.abort(); request.current = null; }, [path]);

  async function download(index: number, item: Attachment) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller; setPending(index); setError("");
    try {
      const response = await fetch(`/api/v1${path}/attachments/${index}`, { credentials: "same-origin",
        redirect: "error", cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        const value = await response.json();
        throw new ApiError(response.status, value.error?.code ?? "request_failed");
      }
      if (response.headers.get("content-type") !== "application/octet-stream"
        || Number(response.headers.get("content-length")) > MAX_ATTACHMENT_BYTES) throw new Error("invalid attachment response");
      const blob = await response.blob();
      if (controller.signal.aborted || request.current !== controller) return;
      if (blob.size !== item.size || blob.size > MAX_ATTACHMENT_BYTES) throw new Error("invalid attachment size");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      try {
        link.href = url; link.download = attachmentFilename(item.filename); link.hidden = true;
        document.body.append(link); link.click();
      } finally {
        link.remove();
        // Allow the browser to take ownership of the download before releasing the Blob URL.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (request.current === controller) { request.current = null; setPending(null); } }
  }

  if (!items.length && !truncated) return null;
  return <section aria-label="邮件附件">
    <h4>附件</h4>
    {error && <p role="alert">{error}</p>}
    <ul>{items.map((item, index) => <li key={index}>
      <div><span>{attachmentFilename(item.filename)}</span><small>{item.size} B</small></div>
      {item.downloadAvailable ? <button className="secondary" aria-label={`下载 ${attachmentFilename(item.filename)}`}
        disabled={pending !== null} onClick={() => download(index, item)}>{pending === index ? "下载中…" : "下载"}</button>
        : <small>仅元数据，无法核验下载</small>}
    </li>)}</ul>
    {truncated && <p role="status">仅显示前 100 个附件。</p>}
  </section>;
}
