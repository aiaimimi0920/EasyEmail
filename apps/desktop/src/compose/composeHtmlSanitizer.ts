import createDOMPurify, { type Config, type WindowLike } from "dompurify";
import { COMPOSE_IMAGE_MAX_BYTES } from "./composeImage.ts";

const COMPOSE_ALLOWED_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "div",
  "em",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "u",
  "ul",
];

const COMPOSE_ALLOWED_ATTRIBUTES = [
  "alt",
  "color",
  "dir",
  "face",
  "href",
  "rel",
  "size",
  "src",
  "style",
  "target",
  "title",
];

const COMPOSE_ALLOWED_STYLE_PROPERTIES = new Set([
  "background-color",
  "color",
  "font-family",
  "font-size",
  "list-style-position",
  "text-align",
]);

const COMPOSE_IMAGE_DATA_URL = /^data:image\/(?:gif|jpeg|png|webp);base64,[a-z\d+/=\s]+$/i;
const SAFE_FONT_FACE = /^[^;{}<>\\\r\n]{1,120}$/;
const SAFE_FONT_SIZE = /^[1-7]$/;
const SAFE_STYLE_VALUE = /^[^{}<>\\\r\n]*$/;

const COMPOSE_SANITIZE_CONFIG: Config & { RETURN_DOM_FRAGMENT: true } = {
  ALLOWED_TAGS: COMPOSE_ALLOWED_TAGS,
  ALLOWED_ATTR: COMPOSE_ALLOWED_ATTRIBUTES,
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  RETURN_DOM_FRAGMENT: true,
};

export type ComposeHtmlSanitizer = (html: string) => string;

function composeImageDataUrlBytes(value: string): number {
  const payload = value.slice(value.indexOf(",") + 1).replace(/\s/g, "");
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function safeComposeHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]|%(?:0a|0d)/i.test(trimmed)) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function sanitizeStyleAttribute(document: Document, element: Element) {
  const rawStyle = element.getAttribute("style");
  if (!rawStyle) {
    return;
  }

  const parsedStyle = document.createElement("span").style;
  parsedStyle.cssText = rawStyle;
  const safeDeclarations: string[] = [];
  for (const property of COMPOSE_ALLOWED_STYLE_PROPERTIES) {
    const value = parsedStyle.getPropertyValue(property).trim();
    if (
      value &&
      SAFE_STYLE_VALUE.test(value) &&
      !/(?:expression|url|var)\s*\(/i.test(value)
    ) {
      safeDeclarations.push(`${property}: ${value}`);
    }
  }

  if (safeDeclarations.length > 0) {
    element.setAttribute("style", `${safeDeclarations.join("; ")};`);
  } else {
    element.removeAttribute("style");
  }
}

function hardenComposeElement(document: Document, element: Element) {
  sanitizeStyleAttribute(document, element);

  const direction = element.getAttribute("dir");
  if (direction && !["auto", "ltr", "rtl"].includes(direction.toLowerCase())) {
    element.removeAttribute("dir");
  }

  if (element.tagName.toLowerCase() === "font") {
    const face = element.getAttribute("face");
    if (face && !SAFE_FONT_FACE.test(face)) {
      element.removeAttribute("face");
    }
    const size = element.getAttribute("size");
    if (size && !SAFE_FONT_SIZE.test(size)) {
      element.removeAttribute("size");
    }
    const color = element.getAttribute("color");
    if (color) {
      const colorProbe = document.createElement("span").style;
      colorProbe.color = color;
      if (!colorProbe.color || /(?:expression|url|var)\s*\(/i.test(color)) {
        element.removeAttribute("color");
      }
    }
  } else {
    element.removeAttribute("face");
    element.removeAttribute("size");
    element.removeAttribute("color");
  }

  if (element.tagName.toLowerCase() === "a") {
    const href = element.getAttribute("href");
    const safeHref = href ? safeComposeHref(href) : null;
    if (safeHref) {
      element.setAttribute("href", safeHref);
      if (element.getAttribute("target") === "_blank") {
        element.setAttribute("rel", "noopener noreferrer");
      } else {
        element.removeAttribute("target");
        element.removeAttribute("rel");
      }
    } else {
      element.removeAttribute("href");
      element.removeAttribute("target");
      element.removeAttribute("rel");
    }
  } else {
    element.removeAttribute("href");
    element.removeAttribute("target");
    element.removeAttribute("rel");
  }

  if (element.tagName.toLowerCase() === "img") {
    const source = element.getAttribute("src")?.trim() ?? "";
    if (
      !COMPOSE_IMAGE_DATA_URL.test(source) ||
      composeImageDataUrlBytes(source) > COMPOSE_IMAGE_MAX_BYTES
    ) {
      element.replaceWith(document.createTextNode(element.getAttribute("alt") ?? ""));
    }
  } else {
    element.removeAttribute("src");
    element.removeAttribute("alt");
  }
}

export function createComposeHtmlSanitizer(windowLike: WindowLike): ComposeHtmlSanitizer {
  const document = windowLike.document;
  if (!document) {
    throw new Error("Compose HTML sanitization requires a DOM document.");
  }
  const purifier = createDOMPurify(windowLike);

  return (html: string) => {
    const sanitized = purifier.sanitize(html, COMPOSE_SANITIZE_CONFIG);
    sanitized.querySelectorAll("*").forEach((element) =>
      hardenComposeElement(document, element),
    );
    const container = document.createElement("div");
    container.append(sanitized.cloneNode(true));
    return container.innerHTML;
  };
}

let browserSanitizer: ComposeHtmlSanitizer | null = null;

export function sanitizeComposeHtml(html: string): string {
  if (!browserSanitizer) {
    browserSanitizer = createComposeHtmlSanitizer(window);
  }
  return browserSanitizer(html);
}
