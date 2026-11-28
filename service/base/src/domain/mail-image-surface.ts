export type LightboxMatChoice = "light" | "dark" | "checker";
export type RecommendedLightboxMat = LightboxMatChoice | "none";

export interface ImageSurfaceAnalysis {
  hasTransparency: boolean;
  transparentRatio: number;
  averageLuminance: number | null;
  isCompactLogo: boolean;
  recommendedMat: RecommendedLightboxMat;
  usedMetadataFallback: boolean;
}

export interface LightboxBackdropPresentation {
  activeMat: LightboxMatChoice | "none";
  matBackgroundCss: string;
  stageBackgroundCss: string;
  autoReason: string | null;
}

const ALPHA_TRANSPARENT_CUTOFF = 245;
const TRANSPARENT_RATIO_THRESHOLD = 0.05;
const DARK_INK_LUMINANCE_CUTOFF = 135;
const LIGHT_INK_LUMINANCE_CUTOFF = 185;

// Natural studio palettes (never pure #000000 black).
const WARM_PAPER_MAT = "#F5F2EB";
const DAYLIGHT_STAGE = "#EBF1F8";
const SLATE_DARK_MAT = "#1E2430";
const SLATE_STAGE = "#161B22";
const CHECKER_CSS = "repeating-conic-gradient(#DFE6EE 0% 25%, #F5F2EB 0% 50%) 50% / 16px 16px";

export function isCompactLogoDimension(width: number, height: number): boolean {
  return width > 0 && height > 0 && width < 420 && height < 220;
}

export function analyzeRgbaSurfacePixels(
  rgbaBytes: ArrayLike<number>,
  naturalWidth: number,
  naturalHeight: number,
): ImageSurfaceAnalysis {
  const isCompactLogo = isCompactLogoDimension(naturalWidth, naturalHeight);
  const pixelCount = Math.floor(rgbaBytes.length / 4);
  if (pixelCount <= 0) {
    return {
      hasTransparency: false,
      transparentRatio: 0,
      averageLuminance: null,
      isCompactLogo,
      recommendedMat: "none",
      usedMetadataFallback: false,
    };
  }

  let transparentPixels = 0;
  let weightedLuminanceSum = 0;
  let alphaWeightSum = 0;

  for (let offset = 0; offset < pixelCount * 4; offset += 4) {
    const r = rgbaBytes[offset] ?? 0;
    const g = rgbaBytes[offset + 1] ?? 0;
    const b = rgbaBytes[offset + 2] ?? 0;
    const a = rgbaBytes[offset + 3] ?? 255;
    if (a < ALPHA_TRANSPARENT_CUTOFF) transparentPixels += 1;
    if (a > 12) {
      const weight = a / 255;
      weightedLuminanceSum += (0.299 * r + 0.587 * g + 0.114 * b) * weight;
      alphaWeightSum += weight;
    }
  }

  const transparentRatio = transparentPixels / pixelCount;
  const hasTransparency = transparentRatio > TRANSPARENT_RATIO_THRESHOLD;
  const averageLuminance = alphaWeightSum > 0 ? weightedLuminanceSum / alphaWeightSum : null;

  let recommendedMat: RecommendedLightboxMat = "none";
  if (hasTransparency) {
    if (averageLuminance !== null && averageLuminance < DARK_INK_LUMINANCE_CUTOFF) {
      recommendedMat = "light";
    } else if (averageLuminance !== null && averageLuminance >= LIGHT_INK_LUMINANCE_CUTOFF) {
      recommendedMat = "dark";
    } else {
      recommendedMat = "checker";
    }
  }

  return {
    hasTransparency,
    transparentRatio,
    averageLuminance,
    isCompactLogo,
    recommendedMat,
    usedMetadataFallback: false,
  };
}

export function inferImageSurfaceFallback(
  srcOrFilename: string,
  mimeType: string | undefined,
  naturalWidth: number,
  naturalHeight: number,
): ImageSurfaceAnalysis {
  const isCompactLogo = isCompactLogoDimension(naturalWidth, naturalHeight);
  const cleanName = (srcOrFilename.split(/[?#]/)[0] ?? "").toLowerCase();
  const lowMime = (mimeType ?? "").toLowerCase();
  const mayHaveAlpha = /\.(?:png|webp|gif|ico|svg)$/.test(cleanName)
    || lowMime === "image/png"
    || lowMime === "image/webp"
    || lowMime === "image/gif";
  const looksLikeLogo = /(?:logo|icon|badge|brand|mark|avatar|signature|sig)/.test(cleanName);
  let recommendedMat: RecommendedLightboxMat = "none";
  if (mayHaveAlpha && (isCompactLogo || looksLikeLogo)) recommendedMat = "light";
  else if (mayHaveAlpha) recommendedMat = "checker";

  return {
    hasTransparency: mayHaveAlpha,
    transparentRatio: 0,
    averageLuminance: null,
    isCompactLogo,
    recommendedMat,
    usedMetadataFallback: true,
  };
}

export function resolveLightboxSurfaceBackdrop(params: {
  manualChoice: LightboxMatChoice | null;
  analysis?: ImageSurfaceAnalysis;
  preferLightStage?: boolean;
}): LightboxBackdropPresentation {
  const stageBackgroundCss = params.preferLightStage ? DAYLIGHT_STAGE : SLATE_STAGE;
  const active: LightboxMatChoice | "none" = params.manualChoice
    ?? (params.analysis?.recommendedMat && params.analysis.recommendedMat !== "none"
      ? params.analysis.recommendedMat
      : params.analysis?.isCompactLogo
        ? "light"
        : "none");

  const matBackgroundCss = active === "light"
    ? WARM_PAPER_MAT
    : active === "dark"
      ? SLATE_DARK_MAT
      : active === "checker"
        ? CHECKER_CSS
        : "transparent";

  const autoReason = params.manualChoice === null && params.analysis?.hasTransparency
    ? active === "light"
      ? "检测到深色透明图像，已自动衬入柔和暖纸浅底"
      : active === "dark"
        ? "检测到浅色透明图像，已自动衬入柔和深色石板底"
        : active === "checker"
          ? "检测到透明通道，已自动启用棋盘格衬底"
          : null
    : null;

  return { activeMat: active, matBackgroundCss, stageBackgroundCss, autoReason };
}
