import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import { fileMetadata, outboxPath, reserveUpload, uploadContent, type OutboxAsset, type UploadMetadata } from "./outbox-attachments";

interface Upload { file: File; key: string; metadata?: UploadMetadata; asset?: OutboxAsset }
export function useOutboxUpload(onUploaded: (asset: OutboxAsset) => void, onLock: (value: boolean) => void) {
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const job = useRef<Upload | null>(null), busy = useRef(false), active = useRef(false);
  const callbacks = useRef({ onUploaded, onLock }); callbacks.current = { onUploaded, onLock };
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function action(run: (upload: Upload) => Promise<void>) {
    if (busy.current || !job.current) return;
    busy.current = true; setPending(true); setError("");
    try { await run(job.current); }
    catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) { setPending(false); setRevision(old => old + 1); } }
  }
  async function reserve(upload: Upload) {
    upload.metadata ??= await fileMetadata(upload.file);
    upload.asset = (await reserveUpload(upload.metadata, upload.key)).attachment;
    return upload.asset;
  }
  async function finish(upload: Upload, asset: OutboxAsset) {
    if (asset.state !== "ready") throw new ApiError(409, "outbox_attachment_unavailable");
    if (active.current) { callbacks.current.onUploaded(asset); job.current = null; callbacks.current.onLock(false); }
  }
  async function send(upload: Upload) {
    const asset = await reserve(upload);
    if (asset.state === "ready") return finish(upload, asset);
    if (asset.state !== "reserved") throw new ApiError(409, "outbox_attachment_unavailable");
    await finish(upload, await uploadContent(asset.id, upload.file));
  }
  function start(file: File) {
    if (job.current || busy.current) return;
    job.current = { file, key: crypto.randomUUID() }; callbacks.current.onLock(true);
    void action(send);
  }
  return { pending, error, revision, hasJob: !!job.current, filename: job.current?.file.name, start,
    retry: () => action(send),
    check: () => action(async upload => {
      const asset = await reserve(upload);
      await finish(upload, asset.state === "ready" ? asset : (await api<{ attachment: OutboxAsset }>(`${outboxPath(asset.id)}/check`, "POST", {})).attachment);
    }),
    discard: () => action(async upload => {
      // Resolve the original key before deletion even when the metadata response was lost.
      if (upload.metadata) { const asset = await reserve(upload); await api(outboxPath(asset.id), "DELETE", {}); }
      if (active.current) { job.current = null; callbacks.current.onLock(false); }
    }),
  };
}
