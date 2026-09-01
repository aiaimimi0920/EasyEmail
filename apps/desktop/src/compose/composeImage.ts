export const COMPOSE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const COMPOSE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type ComposeImageValidation =
  | { valid: true }
  | { valid: false; message: string };

export function validateComposeImageFile(
  file: Pick<File, "type" | "size">,
): ComposeImageValidation {
  if (!COMPOSE_IMAGE_MIME_TYPES.has(file.type.toLowerCase())) {
    return { valid: false, message: "请选择 PNG、JPEG、WebP 或 GIF 图片。" };
  }
  if (file.size <= 0) {
    return { valid: false, message: "图片文件为空。" };
  }
  if (file.size > COMPOSE_IMAGE_MAX_BYTES) {
    return { valid: false, message: "图片不能超过 2 MB。" };
  }
  return { valid: true };
}

export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildComposeImageHtml(dataUrl: string, fileName: string): string {
  return `<img src="${escapeHtmlAttribute(dataUrl)}" alt="${escapeHtmlAttribute(fileName)}" />`;
}
