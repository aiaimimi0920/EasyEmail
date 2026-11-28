import { Button, Notice, Panel } from '@neuro/ui';
import { useEffect, useState } from "react";
import {
  analyzeRgbaSurfacePixels,
  inferImageSurfaceFallback,
  resolveLightboxSurfaceBackdrop,
  type ImageSurfaceAnalysis,
  type LightboxMatChoice,
} from "../../base/src/domain/mail-image-surface";

const SAMPLE_DIMENSION = 32;

export function MailImageLightbox({ src, filename, mimeType, onClose }: {
  src: string;
  filename: string;
  mimeType?: string;
  onClose(): void;
}) {
  const [analysis, setAnalysis] = useState<ImageSurfaceAnalysis | undefined>(undefined);
  const [manualMat, setManualMat] = useState<LightboxMatChoice | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [decodeError, setDecodeError] = useState(false);

  useEffect(() => {
    setDecodeError(false);
    setAnalysis(undefined);
  }, [src]);

  const backdrop = resolveLightboxSurfaceBackdrop({ manualChoice: manualMat, analysis });

  function handleImageLoaded(img: HTMLImageElement) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = SAMPLE_DIMENSION;
      canvas.height = SAMPLE_DIMENSION;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        setAnalysis(inferImageSurfaceFallback(filename, mimeType, w, h));
        return;
      }
      ctx.clearRect(0, 0, SAMPLE_DIMENSION, SAMPLE_DIMENSION);
      ctx.drawImage(img, 0, 0, SAMPLE_DIMENSION, SAMPLE_DIMENSION);
      const rgba = ctx.getImageData(0, 0, SAMPLE_DIMENSION, SAMPLE_DIMENSION).data;
      setAnalysis(analyzeRgbaSurfacePixels(rgba, w, h));
    } catch {
      setAnalysis(inferImageSurfaceFallback(filename, mimeType, w, h));
    }
  }

  return <Panel className="card" aria-label={`图片预览：${filename}`}>
    <div className="row">
      <strong>图片预览：{filename}</strong>
      <Button type="button" variant="quiet" aria-pressed={backdrop.activeMat === "light"} onClick={() => setManualMat("light")} wrap>暖纸浅底</Button>
      <Button type="button" variant="quiet" aria-pressed={backdrop.activeMat === "dark"} onClick={() => setManualMat("dark")} wrap>石板深底</Button>
      <Button type="button" variant="quiet" aria-pressed={backdrop.activeMat === "checker"} onClick={() => setManualMat("checker")} wrap>透明棋盘格</Button>
      <Button type="button" variant="quiet" disabled={zoomPercent <= 50} onClick={() => setZoomPercent((z) => Math.max(50, z - 25))} wrap>缩小</Button>
      <span>{zoomPercent}%</span>
      <Button type="button" variant="quiet" disabled={zoomPercent >= 200} onClick={() => setZoomPercent((z) => Math.min(200, z + 25))} wrap>放大</Button>
      <Button type="button" variant="quiet" onClick={onClose} wrap>关闭预览</Button>
    </div>
    {backdrop.autoReason && !decodeError && <Notice role="status" tone="info">{backdrop.autoReason}</Notice>}
    {decodeError ? (
      <Notice role="alert" tone="danger">图片内容无法解码，已停止渲染；请改用「下载」核验文件</Notice>
    ) : (
      <div style={{ background: backdrop.stageBackgroundCss, padding: "16px", borderRadius: "8px", overflow: "auto", textAlign: "center" }}>
        <div style={{ display: "inline-block", background: backdrop.matBackgroundCss, padding: backdrop.activeMat === "none" ? "0" : "14px", borderRadius: "6px" }}>
          <img
            src={src}
            alt={filename}
            onLoad={(event) => handleImageLoaded(event.currentTarget)}
            onError={() => setDecodeError(true)}
            style={{ maxWidth: "100%", transform: `scale(${zoomPercent / 100})`, transformOrigin: "center top", display: "block" }}
          />
        </div>
      </div>
    )}
  </Panel>;
}
