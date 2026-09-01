import assert from "node:assert/strict";
import test from "node:test";

import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useEventCallback } from "../src/hooks/useEventCallback.ts";
import {
  useModalAccessibility,
  useNonModalLayerAccessibility,
} from "../src/hooks/useLayerAccessibility.ts";

type RafCallback = (time: number) => void;

type DomHarness = {
  dom: JSDOM;
  root: Root;
  container: HTMLDivElement;
  flushAnimationFrames: () => Promise<void>;
  cleanup: () => Promise<void>;
};

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
    HTMLInputElement: domWindow.HTMLInputElement,
    HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
    HTMLSelectElement: domWindow.HTMLSelectElement,
    KeyboardEvent: domWindow.KeyboardEvent,
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

  const offsetParentDescriptor = Object.getOwnPropertyDescriptor(
    domWindow.HTMLElement.prototype,
    "offsetParent",
  );
  Object.defineProperty(domWindow.HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected && this.getAttribute("data-test-hidden") !== "true"
        ? domWindow.document.body
        : null;
    },
  });

  let nextAnimationFrameId = 1;
  const animationFrames = new Map<number, RafCallback>();
  domWindow.requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = nextAnimationFrameId++;
    animationFrames.set(id, callback);
    return id;
  };
  domWindow.cancelAnimationFrame = (id: number) => animationFrames.delete(id);

  const container = domWindow.document.createElement("div");
  domWindow.document.body.append(container);
  const root = createRoot(container);

  return {
    dom,
    root,
    container,
    flushAnimationFrames: async () => {
      await act(async () => {
        const pending = [...animationFrames.values()];
        animationFrames.clear();
        pending.forEach((callback) => callback(0));
      });
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      if (offsetParentDescriptor) {
        Object.defineProperty(
          domWindow.HTMLElement.prototype,
          "offsetParent",
          offsetParentDescriptor,
        );
      } else {
        delete (domWindow.HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
      }
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

test("useEventCallback keeps its identity while calling the latest handler", async () => {
  const harness = await createDomHarness();
  try {
    const callbacks: Array<(value: string) => string> = [];
    function CallbackHarness({ prefix }: { prefix: string }) {
      callbacks.push(useEventCallback((value: string) => `${prefix}:${value}`));
      return null;
    }

    await act(async () => harness.root.render(createElement(CallbackHarness, { prefix: "first" })));
    const firstCallback = callbacks.at(-1)!;
    assert.equal(firstCallback("value"), "first:value");

    await act(async () => harness.root.render(createElement(CallbackHarness, { prefix: "second" })));
    const secondCallback = callbacks.at(-1)!;
    assert.equal(secondCallback, firstCallback);
    assert.equal(firstCallback("value"), "second:value");
  } finally {
    await harness.cleanup();
  }
});

test("modal accessibility manages focus Tab Escape scroll lock and restoration", async () => {
  const harness = await createDomHarness();
  try {
    const returnButton = harness.dom.window.document.createElement("button");
    returnButton.textContent = "return";
    harness.dom.window.document.body.prepend(returnButton);
    returnButton.focus();
    let dismissCount = 0;

    function ModalHarness({ active }: { active: boolean }) {
      const returnFocusRef = useRef<HTMLElement | null>(null);
      useModalAccessibility(active ? "settings" : null, () => dismissCount++, returnFocusRef);
      return createElement(
        "div",
        { "data-modal-id": "settings", tabIndex: -1 },
        createElement("button", { "data-modal-initial-focus": true }, "first"),
        createElement("button", null, "last"),
      );
    }

    await act(async () => harness.root.render(createElement(ModalHarness, { active: true })));
    await harness.flushAnimationFrames();
    const buttons = harness.container.querySelectorAll("button");
    assert.equal(harness.dom.window.document.activeElement, buttons[0]);
    assert.equal(harness.dom.window.document.body.style.overflow, "hidden");

    buttons[1].focus();
    const tab = new harness.dom.window.KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    harness.dom.window.document.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true);
    assert.equal(harness.dom.window.document.activeElement, buttons[0]);

    buttons[0].focus();
    const shiftTab = new harness.dom.window.KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    harness.dom.window.document.dispatchEvent(shiftTab);
    assert.equal(harness.dom.window.document.activeElement, buttons[1]);

    const escape = new harness.dom.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    harness.dom.window.document.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(dismissCount, 1);

    await act(async () => harness.root.render(createElement(ModalHarness, { active: false })));
    assert.equal(harness.dom.window.document.body.style.overflow, "");
    assert.equal(harness.dom.window.document.activeElement, returnButton);
  } finally {
    await harness.cleanup();
  }
});

test("non-modal accessibility navigates menus dismisses outside and restores on Escape", async () => {
  const harness = await createDomHarness();
  try {
    let dismissCount = 0;
    function NonModalHarness({ active }: { active: boolean }) {
      useNonModalLayerAccessibility(active ? "actions" : null, () => dismissCount++);
      return createElement(
        "div",
        null,
        createElement(
          "button",
          {
            "data-nonmodal-trigger": "actions",
            "aria-expanded": active ? "true" : "false",
          },
          "trigger",
        ),
        active
          ? createElement(
              "div",
              { "data-nonmodal-layer": "actions", role: "menu" },
              createElement("button", { role: "menuitem" }, "first"),
              createElement("button", { role: "menuitem" }, "second"),
            )
          : null,
      );
    }

    await act(async () => harness.root.render(createElement(NonModalHarness, { active: true })));
    await harness.flushAnimationFrames();
    const trigger = harness.container.querySelector<HTMLElement>("[data-nonmodal-trigger]")!;
    const items = harness.container.querySelectorAll<HTMLElement>('[role="menuitem"]');
    assert.equal(harness.dom.window.document.activeElement, items[0]);

    items[0].dispatchEvent(
      new harness.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    assert.equal(harness.dom.window.document.activeElement, items[1]);
    items[1].dispatchEvent(
      new harness.dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    assert.equal(harness.dom.window.document.activeElement, items[0]);

    harness.dom.window.document.body.dispatchEvent(
      new harness.dom.window.MouseEvent("pointerdown", { bubbles: true }),
    );
    assert.equal(dismissCount, 1);
    trigger.dispatchEvent(new harness.dom.window.MouseEvent("pointerdown", { bubbles: true }));
    assert.equal(dismissCount, 1);

    const escape = new harness.dom.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    items[0].dispatchEvent(escape);
    assert.equal(dismissCount, 2);
    await act(async () => harness.root.render(createElement(NonModalHarness, { active: false })));
    assert.equal(harness.dom.window.document.activeElement, trigger);
  } finally {
    await harness.cleanup();
  }
});
