import { useState } from "react";
import type { AppController } from "../../app/useAppController";
import { omnimailWorkbenchClient } from "../../app/appRuntime";

export function ComposeBodyEditor({ controller }: { controller: AppController }) {
  const {
    composeAiAssistVisible, applyComposeRichCommand, applyComposeAiExpandSelection, insertComposeRichText, composeAiMoreMenuOpen, setComposeAiMoreMenuOpen, setComposeMoreMenuOpen, renderComposeAiMoreMenu,
    composeBodyEditorRef, composeFontCss, composeFontFamily, composeFontSize, composeTextColor, composeBackgroundColor, handleComposeRichInput, handleComposeRichPaste,
    saveComposeEditorSelection, syncComposeRichBodyState,
  } = controller;
  const [aiPolishing, setAiPolishing] = useState(false);

  async function runByokPolish() {
    const rawText = (composeBodyEditorRef.current?.innerText || controller.sendBodyText || "").trim();
    if (!rawText) {
      controller.setStatusMessage("请先输入邮件草稿内容后再执行 BYOK 润色。");
      return;
    }
    setAiPolishing(true);
    try {
      const res = await omnimailWorkbenchClient.analyzeMail({
        task: "polish",
        subject: controller.sendSubject,
        text: rawText,
        consentConfirmed: true,
      });
      if (res.result.polishedText?.trim()) {
        if (composeBodyEditorRef.current) {
          composeBodyEditorRef.current.textContent = res.result.polishedText.trim();
          syncComposeRichBodyState();
        }
        controller.setSendBodyText(res.result.polishedText.trim());
        controller.setStatusMessage("已通过 PrivacyGuard BYOK 模型完成草稿润色（未自动发送）。");
      }
    } catch (err) {
      controller.setStatusMessage(err instanceof Error ? err.message : "BYOK 润色请求失败");
    } finally {
      setAiPolishing(false);
    }
  }
  return (
    <div
      className={`nt-compose-popover__body ${
        composeAiAssistVisible ? "" : "nt-compose-popover__body--no-ai"
      }`}
    >
      {composeAiAssistVisible ? (
        <div
          className="nt-compose-popover__toolbar nt-compose-popover__toolbar--ai"
          aria-label="AI 写作辅助工具栏（模板预览）"
          onMouseDown={(event) => event.preventDefault()}
        >
          <span className="nt-compose-toolbar-note">模板预览</span>
          <button type="button" onClick={() => applyComposeRichCommand("ai")}>
            ✨ 为我撰写
          </button>
          <button type="button" onClick={() => applyComposeRichCommand("review")}>
            ⟳ 审阅
          </button>
          <button type="button" onClick={() => applyComposeAiExpandSelection()}>
            ↔ 展开
          </button>
          <button type="button" onClick={() => insertComposeRichText("请将上文缩短为更简洁的版本。")}>
            ↔ 缩短
          </button>
          <button type="button" disabled={aiPolishing} onClick={() => void runByokPolish()}>
            {aiPolishing ? "润色中…" : "✦ BYOK 润色"}
          </button>
          <span className="nt-compose-ai-more-control">
            <button
              type="button"
              aria-label="更多 AI 写作操作"
              aria-haspopup="menu"
              aria-expanded={composeAiMoreMenuOpen}
              aria-controls="compose-ai-more-menu"
              data-nonmodal-trigger="compose-ai-more"
              onClick={() => {
                setComposeAiMoreMenuOpen((value) => !value);
                setComposeMoreMenuOpen(false);
              }}
            >
              ⋯
            </button>
            {renderComposeAiMoreMenu()}
          </span>
        </div>
      ) : null}
      <div
        ref={composeBodyEditorRef}
        className="nt-compose-rich-editor"
        aria-label="邮件正文"
        role="textbox"
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        data-placeholder="在当前阅读上下文中撰写邮件"
        style={{
          fontFamily: composeFontCss(composeFontFamily),
          fontSize: composeFontSize,
          color: composeTextColor,
          backgroundColor: composeBackgroundColor,
        }}
        onInput={handleComposeRichInput}
        onPaste={handleComposeRichPaste}
        onFocus={() => saveComposeEditorSelection()}
        onKeyUp={() => saveComposeEditorSelection()}
        onMouseUp={() => saveComposeEditorSelection()}
        onBlur={syncComposeRichBodyState}
      />
    </div>
  );
}
