import assert from "node:assert/strict";
import test from "node:test";

import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderLinkedMessageText } from "../src/mail/messageLinkRenderer.ts";

type LinkProps = {
  className: string;
  href: string;
  children: string;
  onClick: (event: { preventDefault: () => void }) => void;
};

function links(nodes: ReturnType<typeof renderLinkedMessageText>): ReactElement<LinkProps>[] {
  return nodes.filter((node): node is ReactElement<LinkProps> => isValidElement<LinkProps>(node));
}

test("renders markdown and plain message links without duplicating URLs", () => {
  const nodes = renderLinkedMessageText(
    "Read [the docs](https://example.com/docs). Email mailto:help@example.com, thanks.",
    () => undefined,
  );
  const renderedLinks = links(nodes);

  assert.deepEqual(
    renderedLinks.map((link) => [link.props.children, link.props.href]),
    [
      ["the docs", "https://example.com/docs"],
      ["mailto:help@example.com", "mailto:help@example.com"],
    ],
  );
  assert.equal(renderedLinks.every((link) => link.props.className === "nt-message-link"), true);
  assert.match(renderToStaticMarkup(nodes), /the docs<\/a>\. Email/);
  assert.match(renderToStaticMarkup(nodes), /help@example\.com<\/a>, thanks/);
});

test("strips trailing Chinese and ASCII punctuation from link targets", () => {
  const nodes = renderLinkedMessageText("https://example.com/path） mailto:a@example.com]", () => undefined);
  const renderedLinks = links(nodes);

  assert.deepEqual(
    renderedLinks.map((link) => link.props.href),
    ["https://example.com/path", "mailto:a@example.com"],
  );
  assert.match(renderToStaticMarkup(nodes), /path<\/a>）/);
  assert.match(renderToStaticMarkup(nodes), /example\.com<\/a>\]/);
});

test("prevents browser navigation and delegates clicks to the supplied opener", () => {
  const opened: string[] = [];
  let prevented = false;
  const link = links(renderLinkedMessageText("https://example.com", (url) => opened.push(url)))[0];

  link.props.onClick({ preventDefault: () => (prevented = true) });

  assert.equal(prevented, true);
  assert.deepEqual(opened, ["https://example.com"]);
});

test("returns unchanged text when there are no supported links", () => {
  assert.deepEqual(renderLinkedMessageText("没有链接", () => undefined), ["没有链接"]);
});
