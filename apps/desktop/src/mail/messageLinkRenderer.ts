import { createElement, type MouseEvent, type ReactNode } from "react";

const MESSAGE_URL_PATTERN = /(?:https?:\/\/|mailto:)[^\s<>"'`]+/gi;
const MESSAGE_MARKDOWN_LINK_PATTERN = /\[([\s\S]*?)\]\(((?:https?:\/\/|mailto:)[^\s<>"'`]+)\)/gi;
const TRAILING_URL_PUNCTUATION = ".,!?;:，。！？；：)]}）】》";

export type MessageUrlOpener = (url: string) => void | Promise<unknown>;

function messageLink(
  key: string,
  url: string,
  label: string,
  openUrl: MessageUrlOpener,
): ReactNode {
  return createElement(
    "a",
    {
      key,
      className: "nt-message-link",
      href: url,
      onClick: (event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        void openUrl(url);
      },
    },
    label,
  );
}

function splitMessageUrl(rawUrl: string): { url: string; trailing: string } {
  let url = rawUrl;
  let trailing = "";

  while (url.length > 0 && TRAILING_URL_PUNCTUATION.includes(url[url.length - 1])) {
    trailing = `${url[url.length - 1]}${trailing}`;
    url = url.slice(0, -1);
  }

  return { url, trailing };
}

function renderPlainLinkedMessageText(
  text: string,
  keyPrefix: string,
  openUrl: MessageUrlOpener,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(MESSAGE_URL_PATTERN)) {
    const rawUrl = match[0];
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }

    const { url, trailing } = splitMessageUrl(rawUrl);
    nodes.push(messageLink(`${keyPrefix}-${start}-${url}`, url, url, openUrl));
    if (trailing.length > 0) {
      nodes.push(trailing);
    }
    lastIndex = start + rawUrl.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

export function renderLinkedMessageText(
  text: string,
  openUrl: MessageUrlOpener,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(MESSAGE_MARKDOWN_LINK_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(
        ...renderPlainLinkedMessageText(text.slice(lastIndex, start), `plain-${lastIndex}`, openUrl),
      );
    }

    const label = match[1];
    const rawUrl = match[2];
    const { url, trailing } = splitMessageUrl(rawUrl);
    nodes.push(messageLink(`markdown-${start}-${url}`, url, label, openUrl));
    if (trailing.length > 0) {
      nodes.push(trailing);
    }
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(
      ...renderPlainLinkedMessageText(text.slice(lastIndex), `plain-${lastIndex}`, openUrl),
    );
  }

  return nodes.length > 0 ? nodes : [text];
}
