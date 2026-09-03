import type { ChangeEvent, ClipboardEvent as ReactClipboardEvent, FormEvent } from "react";
import { useMemo } from "react";
import { composeFontCss, filterComposeEmojiCategories } from "../compose/composeData";
import { buildComposeImageHtml, validateComposeImageFile } from "../compose/composeImage";
import { sanitizeComposeHtml } from "../compose/composeHtmlSanitizer";
import type { ComposeAlignmentValue } from "./appTypes";
import type { AppState } from "./useAppState";

type Dependencies = {
  saveComposeEditorSelection: () => void;
  syncComposeRichBodyState: () => void;
  restoreComposeEditorSelection: () => boolean;
  nodeIsInsideComposeEditor: (node: Node) => boolean;
  focusComposeBody: () => void;
  rememberModalReturnFocus: () => void;
  showStatusToast: (message: string) => void;
  setComposeRichBodyFromPlainText: (text: string) => void;
};

export function useComposeRichEditor(appState: AppState, dependencies: Dependencies) {
  const {
    setComposeDraftDirty, setStatusMessage, composeBodyEditorRef, setComposeFontMenuOpen, setComposeFontSizeMenuOpen, setComposeColorMenuOpen, setComposeAlignmentMenuOpen, setComposeEmojiPickerOpen,
    setComposeMoreMenuOpen, setComposeAiMoreMenuOpen, setComposeBottomMoreOpen, setComposeEncryptionMenuOpen, setComposeScheduleSendOpen, setComposeEncryptionModalOpen, setComposeExpirationModalOpen, setComposeFontFamily,
    setComposeFontSize, composeColorMode, setComposeTextColor, setComposeBackgroundColor, setComposeLinkType, setComposeLinkUrl, setComposeLinkText, setComposeLinkModalOpen,
    normalizedComposeLinkHref, composeLinkText, composeEmojiSearch, composeEmojiActiveCategoryId, setComposeTextDirection,
  } = appState;
  const {
    saveComposeEditorSelection, syncComposeRichBodyState, restoreComposeEditorSelection, nodeIsInsideComposeEditor, focusComposeBody, rememberModalReturnFocus, showStatusToast, setComposeRichBodyFromPlainText,
  } = dependencies;
  function handleComposeRichInput(_event: FormEvent<HTMLDivElement>) {
      saveComposeEditorSelection();
      syncComposeRichBodyState();
      setComposeDraftDirty(true);
    }
  function handleComposeRichPaste(event: ReactClipboardEvent<HTMLDivElement>) {
      const pastedHtml = event.clipboardData.getData("text/html");
      const pastedText = event.clipboardData.getData("text/plain");
      if (!pastedHtml && !pastedText) {
        return;
      }
      event.preventDefault();
      if (pastedHtml) {
        document.execCommand("insertHTML", false, sanitizeComposeHtml(pastedHtml));
      } else {
        document.execCommand("insertText", false, pastedText);
      }
      saveComposeEditorSelection();
      syncComposeRichBodyState();
      setComposeDraftDirty(true);
    }
  function insertComposeRichHtml(html: string) {
      restoreComposeEditorSelection();
      document.execCommand("insertHTML", false, sanitizeComposeHtml(html));
      syncComposeRichBodyState();
    }
  function insertComposeRichText(text: string) {
      restoreComposeEditorSelection();
      document.execCommand("insertText", false, text);
      syncComposeRichBodyState();
    }
  function composeSelectedTextForAi() {
      restoreComposeEditorSelection();
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return "";
      }
      const range = selection.getRangeAt(0);
      if (
        !nodeIsInsideComposeEditor(range.commonAncestorContainer) &&
        !nodeIsInsideComposeEditor(range.startContainer) &&
        !nodeIsInsideComposeEditor(range.endContainer)
      ) {
        return "";
      }
      return selection.toString().replace(/\s+/g, " ").trim();
    }
  function expandComposeAiText(text: string) {
      const source = text.trim();
      const quotedSource = source.length > 120 ? `${source.slice(0, 120).trim()}...` : source;
      return `关于“${quotedSource}”，我想进一步补充说明：这部分内容可以从背景、原因和后续安排三个角度展开。首先，它体现了当前需要重点处理的问题；其次，我们会结合实际情况补充更多细节，让表达更完整、更自然；最后，也希望对方能够清楚理解我们的目标，并据此推进下一步沟通。`;
    }
  function applyComposeAiExpandSelection() {
      const selectedText = composeSelectedTextForAi();
      if (!selectedText) {
        setStatusMessage("请先选择一段短文本，然后点击展开。");
        return;
      }
      document.execCommand("insertText", false, expandComposeAiText(selectedText));
      syncComposeRichBodyState();
      setStatusMessage("已将选中文本扩写为更完整的润色草稿。");
    }
  function composeBlockForNode(node: Node): HTMLElement | null {
      const editor = composeBodyEditorRef.current;
      if (!editor) {
        return null;
      }
      const element =
        node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      const listItem = element?.closest("li");
      if (listItem && editor.contains(listItem)) {
        return listItem as HTMLElement;
      }
      const block = element?.closest("blockquote,p,div,h1,h2,h3,h4,h5,h6");
      if (block && block !== editor && editor.contains(block)) {
        return block as HTMLElement;
      }
      return editor;
    }
  function selectedComposeAlignmentBlocks(range: Range) {
      const editor = composeBodyEditorRef.current;
      const blocks = new Set<HTMLElement>();
      if (!editor) {
        return [];
      }
      const addBlock = (node: Node) => {
        const block = composeBlockForNode(node);
        if (block) {
          blocks.add(block);
        }
      };
      addBlock(range.startContainer);
      addBlock(range.endContainer);
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node) {
        const element = node as HTMLElement;
        if (
          element !== editor &&
          element.matches("li,blockquote,p,div,h1,h2,h3,h4,h5,h6") &&
          range.intersectsNode(element)
        ) {
          const listItem = element.closest("li");
          blocks.add(listItem && editor.contains(listItem) ? (listItem as HTMLElement) : element);
        }
        node = walker.nextNode();
      }
      return Array.from(blocks);
    }
  function applyComposeListMarkerAlignment(block: HTMLElement, alignment: ComposeAlignmentValue) {
      if (!block.matches("li")) {
        return;
      }
      block.style.listStylePosition = alignment === "left" ? "outside" : "inside";
    }
  function applyComposeAlignmentToBlocks(alignment: ComposeAlignmentValue) {
      restoreComposeEditorSelection();
      const selection = window.getSelection();
      const editor = composeBodyEditorRef.current;
      if (!selection || selection.rangeCount === 0 || !editor) {
        return;
      }
      const range = selection.getRangeAt(0);
      const blocks = selectedComposeAlignmentBlocks(range);
      (blocks.length > 0 ? blocks : [editor]).forEach((block) => {
        block.style.textAlign = alignment;
        applyComposeListMarkerAlignment(block, alignment);
      });
      saveComposeEditorSelection();
      syncComposeRichBodyState();
    }
  function closeComposeFormattingPopovers() {
      setComposeFontMenuOpen(false);
      setComposeFontSizeMenuOpen(false);
      setComposeColorMenuOpen(false);
      setComposeAlignmentMenuOpen(false);
      setComposeEmojiPickerOpen(false);
      setComposeMoreMenuOpen(false);
      setComposeAiMoreMenuOpen(false);
      setComposeBottomMoreOpen(false);
      setComposeEncryptionMenuOpen(false);
      setComposeScheduleSendOpen(false);
      setComposeEncryptionModalOpen(false);
      setComposeExpirationModalOpen(false);
    }
  function chooseComposeFont(label: string) {
      setComposeFontFamily(label);
      setComposeFontMenuOpen(false);
      focusComposeBody();
      document.execCommand("fontName", false, composeFontCss(label));
      syncComposeRichBodyState();
    }
  function pxToLegacyFontSize(size: string): string {
      const px = Number.parseInt(size, 10);
      if (px <= 10) return "1";
      if (px <= 12) return "2";
      if (px <= 16) return "3";
      if (px <= 18) return "4";
      if (px <= 22) return "5";
      if (px <= 24) return "6";
      return "7";
    }
  function normalizeComposeFontSizeNodes(size: string) {
      const editor = composeBodyEditorRef.current;
      if (!editor) {
        return;
      }
      editor.querySelectorAll("font[size]").forEach((node) => {
        if (node.getAttribute("size") !== pxToLegacyFontSize(size)) {
          return;
        }
        node.removeAttribute("size");
        (node as HTMLElement).style.fontSize = size;
      });
      syncComposeRichBodyState();
    }
  function applyComposeTextStyle(style: Partial<CSSStyleDeclaration>) {
      const selection = window.getSelection();
      const editor = composeBodyEditorRef.current;
      if (!editor || !selection || selection.rangeCount === 0) {
        return false;
      }
      const range = selection.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) {
        return false;
      }
      if (range.collapsed) {
        return false;
      }
      const span = document.createElement("span");
      Object.assign(span.style, style);
      try {
        range.surroundContents(span);
      } catch {
        span.appendChild(range.extractContents());
        range.insertNode(span);
      }
      selection.removeAllRanges();
      const nextRange = document.createRange();
      nextRange.selectNodeContents(span);
      selection.addRange(nextRange);
      syncComposeRichBodyState();
      return true;
    }
  function applyComposeBackgroundColor(color: string) {
      focusComposeBody();
      if (applyComposeTextStyle({ backgroundColor: color })) {
        return;
      }
      document.execCommand("backColor", false, color);
      syncComposeRichBodyState();
    }
  function chooseComposeFontSize(size: string) {
      setComposeFontSize(size);
      setComposeFontSizeMenuOpen(false);
      focusComposeBody();
      document.execCommand("fontSize", false, pxToLegacyFontSize(size));
      normalizeComposeFontSizeNodes(size);
    }
  function chooseComposeColor(color: string) {
      if (composeColorMode === "text") {
        setComposeTextColor(color);
        focusComposeBody();
        document.execCommand("foreColor", false, color);
        syncComposeRichBodyState();
      } else {
        setComposeBackgroundColor(color);
        applyComposeBackgroundColor(color);
      }
    }
  function openComposeLinkModal() {
      rememberModalReturnFocus();
      closeComposeFormattingPopovers();
      const selection = window.getSelection();
      const selectedText = selection?.toString().trim() ?? "";
      setComposeLinkType("web");
      setComposeLinkUrl("");
      setComposeLinkText(selectedText);
      setComposeLinkModalOpen(true);
    }
  function submitComposeLinkModal(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      const href = normalizedComposeLinkHref;
      const label = composeLinkText.trim();
      if (!href || !label) {
        showStatusToast("请输入有效的网页、电子邮件地址或电话号码链接。");
        return;
      }
      setComposeLinkModalOpen(false);
      focusComposeBody();
      const selection = window.getSelection();
      const selectedText = selection?.toString().trim() ?? "";
      if (!selectedText) {
        document.execCommand("insertText", false, label);
      }
      document.execCommand("createLink", false, href);
      syncComposeRichBodyState();
    }
  function insertComposeEmoji(emoji: string) {
      setComposeEmojiPickerOpen(false);
      insertComposeRichText(emoji);
    }
  const filteredComposeEmojiCategories = useMemo(
      () => filterComposeEmojiCategories(composeEmojiSearch, composeEmojiActiveCategoryId),
      [composeEmojiSearch, composeEmojiActiveCategoryId],
    );
  function handleComposeImageFile(event: ChangeEvent<HTMLInputElement>) {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file) {
        return;
      }
      const validation = validateComposeImageFile(file);
      if (!validation.valid) {
        showStatusToast(validation.message);
        return;
      }
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        if (typeof reader.result === "string") {
          insertComposeRichHtml(buildComposeImageHtml(reader.result, file.name));
        }
      });
      reader.addEventListener("error", () => {
        showStatusToast("图片读取失败，请重试。");
      });
      reader.readAsDataURL(file);
    }
  function applyComposeRichCommand(command: string) {
      setComposeMoreMenuOpen(false);
      setComposeFontMenuOpen(false);
      setComposeFontSizeMenuOpen(false);
      setComposeColorMenuOpen(false);
      setComposeAlignmentMenuOpen(false);
      restoreComposeEditorSelection();
      if (command === "bold") {
        document.execCommand("bold", false);
      } else if (command === "italic") {
        document.execCommand("italic", false);
      } else if (command === "underline") {
        document.execCommand("underline", false);
      } else if (command === "strike") {
        document.execCommand("strikeThrough", false);
      } else if (command === "unordered-list") {
        document.execCommand("insertUnorderedList", false);
      } else if (command === "ordered-list") {
        document.execCommand("insertOrderedList", false);
      } else if (command === "quote") {
        document.execCommand("formatBlock", false, "blockquote");
      } else if (command === "emoji") {
        setComposeEmojiPickerOpen((value) => !value);
        return;
      } else if (command === "link") {
        openComposeLinkModal();
        return;
      } else if (command === "align-left") {
        applyComposeAlignmentToBlocks("left");
        return;
      } else if (command === "align-center") {
        applyComposeAlignmentToBlocks("center");
        return;
      } else if (command === "align-right") {
        applyComposeAlignmentToBlocks("right");
        return;
      } else if (command === "direction-ltr") {
        composeBodyEditorRef.current?.setAttribute("dir", "ltr");
        setComposeTextDirection("ltr");
      } else if (command === "direction-rtl") {
        composeBodyEditorRef.current?.setAttribute("dir", "rtl");
        setComposeTextDirection("rtl");
      } else if (command === "remove-format") {
        document.execCommand("removeFormat", false);
        document.execCommand("unlink", false);
      } else if (command === "ai") {
        insertComposeRichText("【模板预览】请基于当前主题起草一封更完整的邮件。");
        return;
      } else if (command === "review") {
        insertComposeRichHtml(
          "<p>审阅清单：</p><ul><li>语气是否合适</li><li>表达是否清晰</li><li>行动请求是否明确</li></ul>",
        );
        return;
      } else if (command === "signature") {
        insertComposeRichHtml("<p><br></p><p>此致<br>NMail</p>");
        return;
      } else if (command === "clear") {
        setComposeRichBodyFromPlainText("");
        focusComposeBody();
        return;
      }
      syncComposeRichBodyState();
    }
  return {
    handleComposeRichInput, handleComposeRichPaste, insertComposeRichText, applyComposeAiExpandSelection, closeComposeFormattingPopovers, chooseComposeFont, chooseComposeFontSize, chooseComposeColor,
    submitComposeLinkModal, insertComposeEmoji, filteredComposeEmojiCategories, handleComposeImageFile, applyComposeRichCommand,
  };
}

export type UseComposeRichEditorResult = ReturnType<typeof useComposeRichEditor>;
