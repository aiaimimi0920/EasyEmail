import type { MouseEvent as ReactMouseEvent } from "react";
import type { ComposeActiveFormats } from "./appTypes";
import type { AppState } from "./useAppState";

type Dependencies = {
  composeRichBodyHtmlToPlainText: (editor: HTMLElement) => string;
};

export function useComposeEditorSelection(appState: AppState, dependencies: Dependencies) {
  const {
    composeBodyEditorRef, composeSavedSelectionRangeRef, setSendBodyHtml, setSendBodyText, setComposeActiveFormats, composeActiveFormats,
  } = appState;
  const {
    composeRichBodyHtmlToPlainText,
  } = dependencies;
  function nodeIsInsideComposeEditor(node: Node | null) {
      const editor = composeBodyEditorRef.current;
      return !!editor && !!node && (node === editor || editor.contains(node));
    }
  function saveComposeEditorSelection() {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return;
      }
      const range = selection.getRangeAt(0);
      if (
        nodeIsInsideComposeEditor(range.commonAncestorContainer) ||
        nodeIsInsideComposeEditor(range.startContainer) ||
        nodeIsInsideComposeEditor(range.endContainer)
      ) {
        composeSavedSelectionRangeRef.current = range.cloneRange();
      }
    }
  function restoreComposeEditorSelection() {
      const editor = composeBodyEditorRef.current;
      if (!editor) {
        return false;
      }
      editor.focus({ preventScroll: true });
      const range = composeSavedSelectionRangeRef.current;
      if (!range || !nodeIsInsideComposeEditor(range.startContainer) || !nodeIsInsideComposeEditor(range.endContainer)) {
        return false;
      }
      const selection = window.getSelection();
      if (!selection) {
        return false;
      }
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
  function preserveComposeEditorSelection(event: ReactMouseEvent<HTMLElement>) {
      event.preventDefault();
      restoreComposeEditorSelection();
    }
  function focusComposeBody() {
      const editor = composeBodyEditorRef.current;
      if (!editor) {
        return;
      }
      editor.focus({ preventScroll: true });
    }
  function syncComposeRichBodyState() {
      const editor = composeBodyEditorRef.current;
      if (!editor) {
        return;
      }
      setSendBodyHtml(editor.innerHTML);
      setSendBodyText(composeRichBodyHtmlToPlainText(editor));
      refreshComposeActiveFormats();
    }
  function refreshComposeActiveFormats() {
      const editor = composeBodyEditorRef.current;
      const selection = window.getSelection();
      const selectionNode = selection?.rangeCount ? selection.getRangeAt(0).commonAncestorContainer : null;
      if (!editor || !selectionNode || !editor.contains(selectionNode)) {
        return;
      }
      const element =
        selectionNode.nodeType === Node.ELEMENT_NODE
          ? (selectionNode as Element)
          : selectionNode.parentElement;
      setComposeActiveFormats({
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        underline: document.queryCommandState("underline"),
        strike: document.queryCommandState("strikeThrough"),
        unorderedList: document.queryCommandState("insertUnorderedList"),
        orderedList: document.queryCommandState("insertOrderedList"),
        quote: !!element?.closest("blockquote"),
      });
    }
  function composeFormatButtonClass(key: keyof ComposeActiveFormats) {
      return composeActiveFormats[key]
        ? "nt-compose-format-button nt-compose-format-button--active"
        : "nt-compose-format-button";
    }
  return {
    nodeIsInsideComposeEditor, saveComposeEditorSelection, restoreComposeEditorSelection, preserveComposeEditorSelection, focusComposeBody, syncComposeRichBodyState, refreshComposeActiveFormats, composeFormatButtonClass,
  };
}

export type UseComposeEditorSelectionResult = ReturnType<typeof useComposeEditorSelection>;
