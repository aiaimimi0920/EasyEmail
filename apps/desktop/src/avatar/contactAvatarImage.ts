export const CUSTOM_AVATAR_MAX_BYTES = 512 * 1024;
export const CUSTOM_AVATAR_MAX_EDGE = 256;

const RESIZABLE_AVATAR_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

export function dataUrlPayloadBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return dataUrl.length;
  }
  const payload = dataUrl.slice(commaIndex + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export function isResizableAvatarMime(mime: string): boolean {
  return RESIZABLE_AVATAR_MIME_TYPES.has(mime.toLowerCase());
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("File reader did not return a data URL."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("File could not be read."));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Selected image could not be decoded."));
    image.src = dataUrl;
  });
}

export async function preprocessContactAvatarFile(file: File): Promise<string> {
  const originalDataUrl = await readFileAsDataUrl(file);
  if (!isResizableAvatarMime(file.type)) {
    return originalDataUrl;
  }

  const image = await loadImageElement(originalDataUrl);
  const originalBytes = dataUrlPayloadBytes(originalDataUrl);
  const needsResize =
    originalBytes > CUSTOM_AVATAR_MAX_BYTES ||
    image.naturalWidth > CUSTOM_AVATAR_MAX_EDGE ||
    image.naturalHeight > CUSTOM_AVATAR_MAX_EDGE;
  if (!needsResize) {
    return originalDataUrl;
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return originalDataUrl;
  }

  let lastDataUrl = originalDataUrl;
  for (const edge of [CUSTOM_AVATAR_MAX_EDGE, 192, 128, 96]) {
    const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const resizedDataUrl = canvas.toDataURL("image/png");
    lastDataUrl = resizedDataUrl;
    if (dataUrlPayloadBytes(resizedDataUrl) <= CUSTOM_AVATAR_MAX_BYTES) {
      return resizedDataUrl;
    }
  }

  return lastDataUrl;
}
