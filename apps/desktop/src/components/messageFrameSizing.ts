import type { SyntheticEvent } from "react";

export function resizeMessageHtmlFrame(event: SyntheticEvent<HTMLIFrameElement>) {
  const frame = event.currentTarget;
  try {
    const documentElement = frame.contentDocument?.documentElement;
    const body = frame.contentDocument?.body;
    if (!documentElement || !body) {
      return;
    }

    const height = Math.max(
      documentElement.scrollHeight,
      body.scrollHeight,
      documentElement.offsetHeight,
      body.offsetHeight,
      480,
    );
    frame.style.height = `${height}px`;
  } catch {
    frame.style.height = "760px";
  }
}
