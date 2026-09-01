import { useEffect } from "react";
import { useEventCallback } from "./useEventCallback.ts";

const LAYER_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

type ReturnFocusRef = { current: HTMLElement | null };

export function useModalAccessibility(
  activeModalId: string | null,
  onDismiss: () => void,
  returnFocusRef: ReturnFocusRef,
) {
  const dismiss = useEventCallback(onDismiss);

  useEffect(() => {
    if (!activeModalId) {
      return undefined;
    }

    const modal = document.querySelector<HTMLElement>(`[data-modal-id="${activeModalId}"]`);
    if (!modal) {
      return undefined;
    }

    const previouslyFocused =
      returnFocusRef.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusableElements = () =>
      Array.from(modal.querySelectorAll<HTMLElement>(LAYER_FOCUSABLE_SELECTOR)).filter(
        (element) => element.offsetParent !== null && element.getAttribute("aria-hidden") !== "true",
      );

    const focusFrame = window.requestAnimationFrame(() => {
      const initialTarget =
        modal.querySelector<HTMLElement>("[data-modal-initial-focus]") ??
        focusableElements()[0] ??
        modal;
      initialTarget.focus({ preventScroll: true });
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        modal.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !modal.contains(activeElement))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousBodyOverflow;
      const fallbackFocus = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-modal-return-focus="${activeModalId}"]`),
      ).find((element) => element.offsetParent !== null);
      const returnTarget = previouslyFocused?.isConnected ? previouslyFocused : fallbackFocus;
      if (returnTarget) {
        returnTarget.focus({ preventScroll: true });
      }
      returnFocusRef.current = null;
    };
  }, [activeModalId, dismiss, returnFocusRef]);
}

export function useNonModalLayerAccessibility(
  activeLayerId: string | null,
  onDismiss: () => void,
  dismissOnOutside = true,
) {
  const dismiss = useEventCallback(onDismiss);

  useEffect(() => {
    if (!activeLayerId) {
      return undefined;
    }

    const layer = document.querySelector<HTMLElement>(
      `[data-nonmodal-layer="${activeLayerId}"]`,
    );
    if (!layer) {
      return undefined;
    }

    const expandedTrigger = Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-nonmodal-trigger~="${activeLayerId}"][aria-expanded="true"]`,
      ),
    ).find((element) => element.offsetParent !== null);
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let restoreFocus = false;
    const focusFrame = window.requestAnimationFrame(() => {
      if (layer.hasAttribute("data-nonmodal-preserve-focus")) {
        return;
      }
      const initialTarget =
        layer.querySelector<HTMLElement>("[data-nonmodal-initial-focus]") ??
        layer.querySelector<HTMLElement>(LAYER_FOCUSABLE_SELECTOR);
      initialTarget?.focus({ preventScroll: true });
    });

    const navigationRoot = layer.matches('[role="menu"], [role="listbox"]')
      ? layer
      : layer.querySelector<HTMLElement>("[data-nonmodal-navigation]");
    const focusableMenuItems = () =>
      Array.from(
        navigationRoot?.querySelectorAll<HTMLElement>(LAYER_FOCUSABLE_SELECTOR) ?? [],
      ).filter(
        (element) => element.offsetParent !== null && element.getAttribute("aria-hidden") !== "true",
      );

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        restoreFocus = true;
        dismiss();
        return;
      }

      if (
        !navigationRoot ||
        !["menu", "listbox"].includes(navigationRoot.getAttribute("role") ?? "") ||
        !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
      ) {
        return;
      }
      const eventTarget = event.target;
      if (
        eventTarget instanceof HTMLInputElement ||
        eventTarget instanceof HTMLTextAreaElement ||
        eventTarget instanceof HTMLSelectElement
      ) {
        return;
      }

      const items = focusableMenuItems();
      if (items.length === 0) {
        return;
      }
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowUp"
              ? (currentIndex <= 0 ? items.length : currentIndex) - 1
              : currentIndex < 0 || currentIndex === items.length - 1
                ? 0
                : currentIndex + 1;
      event.preventDefault();
      items[nextIndex].focus({ preventScroll: true });
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || layer.contains(target)) {
        return;
      }
      const trigger = document.querySelector<HTMLElement>(
        `[data-nonmodal-trigger~="${activeLayerId}"]`,
      );
      if (trigger?.contains(target)) {
        return;
      }
      dismiss();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    if (dismissOnOutside) {
      document.addEventListener("pointerdown", handlePointerDown);
    }
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      if (dismissOnOutside) {
        document.removeEventListener("pointerdown", handlePointerDown);
      }
      if (!restoreFocus) {
        return;
      }
      const fallbackFocus = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-nonmodal-trigger~="${activeLayerId}"]`,
        ),
      ).find((element) => element.offsetParent !== null);
      const returnTarget = expandedTrigger?.isConnected
        ? expandedTrigger
        : previouslyFocused?.isConnected
          ? previouslyFocused
          : fallbackFocus;
      returnTarget?.focus({ preventScroll: true });
    };
  }, [activeLayerId, dismiss, dismissOnOutside]);
}
