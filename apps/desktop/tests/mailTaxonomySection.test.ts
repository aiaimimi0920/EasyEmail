import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { act, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createServer, type ViteDevServer } from "vite";

type SectionProps = {
  kind: "folder" | "label";
  expanded: boolean;
  railExpandedReady: boolean;
  drawerOpen: boolean;
  itemCount: number;
  icon: ReactNode;
  renderItems: () => ReactNode;
  onOpenFromIcon: () => void;
  onCreate: () => void;
  onToggle: () => void;
  onSelect: () => void;
};

type DomHarness = {
  dom: JSDOM;
  root: Root;
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
};

let vite: ViteDevServer;
let MailTaxonomySection: ComponentType<SectionProps>;

test.before(async () => {
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  const module = await vite.ssrLoadModule("/src/components/app/MailTaxonomySection.tsx");
  MailTaxonomySection = module.MailTaxonomySection as ComponentType<SectionProps>;
});

test.after(async () => {
  await vite.close();
});

async function createDomHarness(): Promise<DomHarness> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://easyemailam.test/",
  });
  const domWindow = dom.window;
  const globals = {
    window: domWindow,
    document: domWindow.document,
    Node: domWindow.Node,
    Element: domWindow.Element,
    HTMLElement: domWindow.HTMLElement,
  };
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const previousActEnvironment = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
  const container = domWindow.document.createElement("div");
  domWindow.document.body.append(container);
  const root = createRoot(container);

  return {
    dom,
    root,
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      for (const [name, descriptor] of previousGlobals) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete (globalThis as Record<string, unknown>)[name];
        }
      }
      if (previousActEnvironment) {
        Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
      } else {
        delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
      }
      domWindow.close();
    },
  };
}

function baseProps(overrides: Partial<SectionProps> = {}): SectionProps {
  return {
    kind: "folder",
    expanded: false,
    railExpandedReady: false,
    drawerOpen: false,
    itemCount: 0,
    icon: createElement("span", { "data-taxonomy-icon": true }),
    renderItems: () => createElement("span", { "data-taxonomy-item": true }, "item"),
    onOpenFromIcon: () => undefined,
    onCreate: () => undefined,
    onToggle: () => undefined,
    onSelect: () => undefined,
    ...overrides,
  };
}

async function click(harness: DomHarness, element: Element) {
  await act(async () => {
    element.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
  });
}

test("collapsed taxonomy keeps content lazy and exposes the icon action", async () => {
  const harness = await createDomHarness();
  let renderCount = 0;
  let openCount = 0;
  try {
    await act(async () =>
      harness.root.render(
        createElement(
          MailTaxonomySection,
          baseProps({
            itemCount: 1,
            renderItems: () => {
              renderCount += 1;
              return createElement("span", null, "folder item");
            },
            onOpenFromIcon: () => openCount++,
          }),
        ),
      ),
    );

    const toggle = harness.container.querySelector<HTMLButtonElement>(
      ".nt-mail-taxonomy__icon-toggle",
    )!;
    const content = harness.container.querySelector<HTMLDivElement>("#mail-taxonomy-folders")!;
    assert.equal(toggle.getAttribute("aria-label"), "展开文件夹");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(content.hidden, true);
    assert.equal(renderCount, 0);
    assert.equal(harness.container.querySelector(".nt-mail-taxonomy__row"), null);

    await click(harness, toggle);
    assert.equal(openCount, 1);
  } finally {
    await harness.cleanup();
  }
});

test("expanded drawer preserves label actions and empty-state semantics", async () => {
  const harness = await createDomHarness();
  let createCount = 0;
  let toggleCount = 0;
  let selectCount = 0;
  try {
    await act(async () =>
      harness.root.render(
        createElement(
          MailTaxonomySection,
          baseProps({
            kind: "label",
            expanded: true,
            railExpandedReady: true,
            drawerOpen: true,
            onCreate: () => createCount++,
            onToggle: () => toggleCount++,
            onSelect: () => selectCount++,
          }),
        ),
      ),
    );

    const content = harness.container.querySelector<HTMLDivElement>("#mail-taxonomy-labels")!;
    const drawer = content.querySelector('[role="group"][aria-label="标签"]')!;
    assert.equal(content.hidden, false);
    assert.equal(drawer.querySelector('[role="status"]')?.textContent?.trim(), "无标签");

    const addButtons = harness.container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="新建标签"]',
    );
    await click(harness, addButtons[0]);
    await click(harness, addButtons[1]);
    await click(harness, drawer.querySelector(".nt-mail-taxonomy__chevron")!);
    await click(harness, drawer.querySelector(".nt-mail-taxonomy__drawer-title")!);
    assert.equal(createCount, 2);
    assert.equal(toggleCount, 1);
    assert.equal(selectCount, 1);
  } finally {
    await harness.cleanup();
  }
});

test("expanded inline taxonomy renders non-empty items exactly once", async () => {
  const harness = await createDomHarness();
  let renderCount = 0;
  try {
    await act(async () =>
      harness.root.render(
        createElement(
          MailTaxonomySection,
          baseProps({
            expanded: true,
            itemCount: 1,
            renderItems: () => {
              renderCount += 1;
              return createElement("span", { "data-taxonomy-item": true }, "folder item");
            },
          }),
        ),
      ),
    );

    assert.equal(renderCount, 1);
    assert.equal(harness.container.querySelector("[data-taxonomy-item]")?.textContent, "folder item");
    assert.equal(harness.container.querySelector(".nt-mail-taxonomy__drawer"), null);
  } finally {
    await harness.cleanup();
  }
});
