import type { ComposeMoreMenuAnchor } from "./appTypes";
import type { AppState } from "./useAppState";

type Dependencies = {
  insertComposeRichText: (text: string) => void;
  applyComposeRichCommand: (command: string) => void;
};

export function useComposeEditorMenus(appState: AppState, dependencies: Dependencies) {
  const {
    setComposeAiMoreMenuOpen, composeAiMoreMenuOpen, composeMoreMenuOpen, composeMoreMenuAnchor, setComposeMoreMenuOpen, composeImageInputRef, composeTextDirection,
  } = appState;
  const {
    insertComposeRichText, applyComposeRichCommand,
  } = dependencies;
  function applyComposeAiRewrite(kind: "formalize" | "friendly") {
      setComposeAiMoreMenuOpen(false);
      if (kind === "formalize") {
        insertComposeRichText("请将选中文本改写得更正式。");
        return;
      }
      insertComposeRichText("请将选中文本改写得更友好。");
    }
  function renderComposeAiMoreMenu() {
      if (!composeAiMoreMenuOpen) {
        return null;
      }
      return (
        <div
          id="compose-ai-more-menu"
          className="nt-compose-popover__more-menu nt-compose-ai-more-menu"
          role="menu"
          aria-label="更多 AI 写作操作"
          data-nonmodal-layer="compose-ai-more"
        >
          <button type="button" role="menuitem" onClick={() => applyComposeAiRewrite("formalize")}>
            正式化
          </button>
          <button type="button" role="menuitem" onClick={() => applyComposeAiRewrite("friendly")}>
            使它变得友好
          </button>
        </div>
      );
    }
  function renderComposeMoreMenu(anchor: ComposeMoreMenuAnchor) {
      if (!composeMoreMenuOpen || composeMoreMenuAnchor !== anchor) {
        return null;
      }
      const anchorClass =
        anchor === "formatbar"
          ? "nt-compose-popover__more-menu--formatbar"
          : "nt-compose-popover__more-menu--toolbar";
      return (
        <div
          id="compose-more-menu"
          className={`nt-compose-popover__more-menu ${anchorClass}`}
          role="menu"
          aria-label="更多格式操作"
          data-nonmodal-layer="compose-more"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setComposeMoreMenuOpen(false);
              composeImageInputRef.current?.click();
            }}
          >
            插入图片
          </button>
          <button type="button" role="menuitem" onClick={() => applyComposeRichCommand("direction-ltr")}>
            {composeTextDirection === "ltr" ? "✓ " : ""}从左到右
          </button>
          <button type="button" role="menuitem" onClick={() => applyComposeRichCommand("direction-rtl")}>
            {composeTextDirection === "rtl" ? "✓ " : ""}从右到左
          </button>
        </div>
      );
    }
  return {
    renderComposeAiMoreMenu, renderComposeMoreMenu,
  };
}

export type UseComposeEditorMenusResult = ReturnType<typeof useComposeEditorMenus>;
