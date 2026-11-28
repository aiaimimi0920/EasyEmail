import { Button, Notice } from '@neuro/ui';
import { useEffect, useRef, useState } from "react";
import { attachmentFilename, MAX_ATTACHMENT_BYTES } from "../src/attachment-policy";
import { ApiError, errorMessage, type Attachment } from "./api";
import { MailImageLightbox } from "./MailImageLightbox";
import { MeetingInviteReaderCard } from "./MeetingInviteReaderCard";

function inferRasterMimeFromFilename(filename: string): string | undefined {
  const low = filename.trim().toLowerCase();
  if (low.endsWith(".png")) return "image/png";
  if (low.endsWith(".jpg") || low.endsWith(".jpeg")) return "image/jpeg";
  if (low.endsWith(".webp")) return "image/webp";
  if (low.endsWith(".gif")) return "image/gif";
  return undefined;
}

export function AttachmentList({ path, items, truncated }: { path: string; items: Attachment[]; truncated: boolean }) {
  const request = useRef<AbortController | null>(null);
  const [pendingAction, setPendingAction] = useState<{ index: number; kind: "preview" | "ics" | "download" } | null>(null);
  const [error, setError] = useState("");
  const [statusNotice, setStatusNotice] = useState("");
  const [preview, setPreview] = useState<{ url: string; filename: string; mimeType?: string } | null>(null);
  const [icsContent, setIcsContent] = useState<{ index: number; text: string } | null>(null);
  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, [path]);
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview.url);
  }, [preview]);

  async function fetchVerifiedBlob(index: number, item: Attachment, controller: AbortController): Promise<Blob | null> {
    const response = await fetch(`/api/v1${path}/attachments/${index}`, { credentials: "same-origin",
      redirect: "error", cache: "no-store", signal: controller.signal });
    if (!response.ok) {
      let code = "request_failed";
      try {
        const value = await response.json();
        if (typeof value?.error?.code === "string" && value.error.code) code = value.error.code;
      } catch {
        // Non-JSON error response keeps fallback code instead of reporting a connection error.
      }
      throw new ApiError(response.status, code);
    }
    if (response.headers.get("content-type") !== "application/octet-stream"
      || Number(response.headers.get("content-length")) > MAX_ATTACHMENT_BYTES) throw new ApiError(response.status, "attachment_response_invalid");
    const blob = await response.blob();
    if (controller.signal.aborted || request.current !== controller) return null;
    if (blob.size !== item.size || blob.size > MAX_ATTACHMENT_BYTES) throw new ApiError(response.status, "attachment_size_mismatch");
    return blob;
  }

  async function runAttachmentAction(
    index: number,
    kind: "preview" | "ics" | "download",
    item: Attachment,
    onBlob: (blob: Blob, name: string) => Promise<void> | void,
  ) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPendingAction({ index, kind });
    setError("");
    setStatusNotice("");
    try {
      const blob = await fetchVerifiedBlob(index, item, controller);
      if (!blob) return;
      const name = attachmentFilename(item.filename);
      await onBlob(blob, name);
      if (!controller.signal.aborted && request.current === controller) {
        setStatusNotice(`已核验附件完整性和大小：${name}（${item.size} B）`);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPendingAction(null);
      }
    }
  }

  function openPreview(index: number, item: Attachment) {
    return runAttachmentAction(index, "preview", item, (blob, name) => {
      const mimeType = inferRasterMimeFromFilename(item.filename);
      const typed = mimeType ? new Blob([blob], { type: mimeType }) : blob;
      const url = URL.createObjectURL(typed);
      setPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url, filename: name, mimeType };
      });
    });
  }

  function openIcs(index: number, item: Attachment) {
    return runAttachmentAction(index, "ics", item, async (blob) => {
      setIcsContent({ index, text: await blob.text() });
    });
  }

  function download(index: number, item: Attachment) {
    return runAttachmentAction(index, "download", item, (blob, name) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      try {
        link.href = url; link.download = name; link.hidden = true;
        document.body.append(link); link.click();
      } finally {
        link.remove();
        // Allow the browser to take ownership of the download before releasing the Blob URL.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    });
  }

  if (!items.length && !truncated) return null;
  return <section aria-label="邮件附件">
    <h4>附件</h4>
    {error && <Notice role="alert" tone="danger">{error}</Notice>}
    {statusNotice && !error && <Notice role="status" tone="info">{statusNotice}</Notice>}
    <ul>{items.map((item, index) => {
      const name = attachmentFilename(item.filename);
      const busyHere = pendingAction?.index === index;
      return <li key={index}>
        <div><span>{name}</span><small>{item.size} B</small></div>
        {item.downloadAvailable ? <div className="row">
          {inferRasterMimeFromFilename(item.filename) && <Button type="button" aria-label={`预览 ${name}`} disabled={pendingAction !== null} onClick={() => void openPreview(index, item)} variant="quiet" wrap>{busyHere && pendingAction?.kind === "preview" ? "加载预览…" : "预览图片"}</Button>}
          {item.filename.trim().toLowerCase().endsWith(".ics") && <Button type="button" disabled={pendingAction !== null} onClick={() => void openIcs(index, item)} variant="quiet" wrap>{busyHere && pendingAction?.kind === "ics" ? "解析中…" : "查看会议邀请"}</Button>}
          <Button aria-label={`下载 ${name}`} disabled={pendingAction !== null} onClick={() => void download(index, item)} variant="quiet" wrap>{busyHere && pendingAction?.kind === "download" ? "下载中…" : "下载"}</Button>
        </div> : <small>{item.size > MAX_ATTACHMENT_BYTES ? "超过 5 MB 核验上限，仅元数据，无法核验下载" : "仅元数据，无法核验下载"}</small>}
      </li>;
    })}</ul>
    {icsContent && <MeetingInviteReaderCard key={`${path}:${icsContent.index}`} icsText={icsContent.text} sourceRef={path} />}
    {preview && <MailImageLightbox src={preview.url} filename={preview.filename} mimeType={preview.mimeType} onClose={() => setPreview(null)} />}
    {truncated && <Notice role="status" tone="info">仅显示前 100 个附件。</Notice>}
  </section>;
}
