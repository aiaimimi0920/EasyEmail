import type { AppController } from "../../app/useAppController";

export function ComposeFormatToolbar({ controller }: { controller: AppController }) {
  const {
    preserveComposeEditorSelection, composeFontMenuOpen, setComposeFontMenuOpen, setComposeFontSizeMenuOpen, setComposeColorMenuOpen, setComposeMoreMenuOpen, composeFontFamily, COMPOSE_FONT_OPTIONS,
    chooseComposeFont, composeFontSizeMenuOpen, composeFontSize, COMPOSE_FONT_SIZE_OPTIONS, chooseComposeFontSize, composeColorMenuOpen, composeTextColor, composeColorMode,
    setComposeColorMode, COMPOSE_COLOR_SWATCHES, composeBackgroundColor, chooseComposeColor, composeFormatButtonClass, composeActiveFormats, applyComposeRichCommand, composeAlignmentMenuOpen,
    setComposeAlignmentMenuOpen, setComposeEmojiPickerOpen, composeEmojiPickerOpen, COMPOSE_EMOJI_CATEGORIES, composeEmojiActiveCategoryId, setComposeEmojiActiveCategoryId, composeEmojiSearch, setComposeEmojiSearch,
    filteredComposeEmojiCategories, insertComposeEmoji, ClearFormatIcon, composeMoreMenuOpen, composeMoreMenuAnchor, setComposeMoreMenuAnchor, renderComposeMoreMenu,
  } = controller;
  return (
    <div
      className="nt-compose-popover__formatbar"
      onMouseDown={(event) => {
        const target = event.target as Element;
        if (target.closest(".nt-compose-emoji-popover")) {
          return;
        }
        preserveComposeEditorSelection(event);
      }}
    >
      <div className="nt-compose-format-control">
        <button
          type="button"
          className="nt-compose-format-select"
          aria-haspopup="listbox"
          aria-expanded={composeFontMenuOpen}
          aria-controls="compose-font-menu"
          data-nonmodal-trigger="compose-font"
          onClick={() => {
            setComposeFontMenuOpen((value) => !value);
            setComposeFontSizeMenuOpen(false);
            setComposeColorMenuOpen(false);
            setComposeMoreMenuOpen(false);
          }}
        >
          {composeFontFamily}
        </button>
        {composeFontMenuOpen ? (
          <div
            id="compose-font-menu"
            className="nt-compose-format-menu nt-compose-format-menu--font"
            role="listbox"
            aria-label="字体"
            data-nonmodal-layer="compose-font"
          >
            {COMPOSE_FONT_OPTIONS.map((font) => (
              <button
                type="button"
                role="option"
                aria-selected={composeFontFamily === font.label}
                key={font.label}
                style={{ fontFamily: font.css }}
                className={
                  composeFontFamily === font.label
                    ? "nt-compose-format-menu__item nt-compose-format-menu__item--active"
                    : "nt-compose-format-menu__item"
                }
                onClick={() => chooseComposeFont(font.label)}
              >
                <span>{font.label}</span>
                {composeFontFamily === font.label ? <em>默认</em> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="nt-compose-format-control">
        <button
          type="button"
          className="nt-compose-format-select nt-compose-format-select--size"
          aria-haspopup="listbox"
          aria-expanded={composeFontSizeMenuOpen}
          aria-controls="compose-font-size-menu"
          data-nonmodal-trigger="compose-font-size"
          onClick={() => {
            setComposeFontSizeMenuOpen((value) => !value);
            setComposeFontMenuOpen(false);
            setComposeColorMenuOpen(false);
            setComposeMoreMenuOpen(false);
          }}
        >
          {composeFontSize}
        </button>
        {composeFontSizeMenuOpen ? (
          <div
            id="compose-font-size-menu"
            className="nt-compose-format-menu nt-compose-format-menu--size"
            role="listbox"
            aria-label="字号"
            data-nonmodal-layer="compose-font-size"
          >
            {COMPOSE_FONT_SIZE_OPTIONS.map((size) => (
              <button
                type="button"
                role="option"
                aria-selected={composeFontSize === size}
                key={size}
                className={
                  composeFontSize === size
                    ? "nt-compose-format-menu__item nt-compose-format-menu__item--active"
                    : "nt-compose-format-menu__item"
                }
                onClick={() => chooseComposeFontSize(size)}
              >
                <span>{size}</span>
                {composeFontSize === size ? <em>默认</em> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="nt-compose-format-control">
        <button
          type="button"
          className="nt-compose-color-button"
          aria-label="文本与背景颜色"
          aria-haspopup="dialog"
          aria-expanded={composeColorMenuOpen}
          aria-controls="compose-color-popover"
          data-nonmodal-trigger="compose-color"
          onClick={() => {
            setComposeColorMenuOpen((value) => !value);
            setComposeFontMenuOpen(false);
            setComposeFontSizeMenuOpen(false);
            setComposeMoreMenuOpen(false);
          }}
        >
          <span style={{ background: composeTextColor }} />
        </button>
        {composeColorMenuOpen ? (
          <div
            id="compose-color-popover"
            className="nt-compose-color-popover"
            role="dialog"
            aria-label="文本与背景颜色"
            data-nonmodal-layer="compose-color"
          >
            <div className="nt-compose-color-tabs">
              <button
                type="button"
                className={composeColorMode === "text" ? "is-active" : ""}
                onClick={() => setComposeColorMode("text")}
              >
              文本颜色
              </button>
              <button
                type="button"
                className={composeColorMode === "background" ? "is-active" : ""}
                onClick={() => setComposeColorMode("background")}
              >
              背景颜色
              </button>
            </div>
            <div className="nt-compose-color-grid">
              {COMPOSE_COLOR_SWATCHES.map((color) => {
                const active =
                  composeColorMode === "text"
                    ? composeTextColor === color
                    : composeBackgroundColor === color;
                return (
                  <button
                    type="button"
                    key={`${composeColorMode}:${color}`}
                    className={
                      active
                        ? "nt-compose-color-swatch nt-compose-color-swatch--active"
                        : "nt-compose-color-swatch"
                    }
                    style={{ background: color }}
                    aria-label={`${composeColorMode} ${color}`}
                    onClick={() => chooseComposeColor(color)}
                  />
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className={composeFormatButtonClass("bold")}
        aria-label="粗体"
        aria-pressed={composeActiveFormats.bold}
        onClick={() => applyComposeRichCommand("bold")}
      >
        B
      </button>
      <button
        type="button"
        className={composeFormatButtonClass("italic")}
        aria-label="斜体"
        aria-pressed={composeActiveFormats.italic}
        onClick={() => applyComposeRichCommand("italic")}
      >
        I
      </button>
      <button
        type="button"
        className={composeFormatButtonClass("underline")}
        aria-label="下划线"
        aria-pressed={composeActiveFormats.underline}
        onClick={() => applyComposeRichCommand("underline")}
      >
        U
      </button>
      <button
        type="button"
        className={composeFormatButtonClass("strike")}
        aria-label="删除线"
        aria-pressed={composeActiveFormats.strike}
        onClick={() => applyComposeRichCommand("strike")}
      >
        S
      </button>
      <button
        type="button"
        className={composeFormatButtonClass("unorderedList")}
        aria-label="无序列表"
        aria-pressed={composeActiveFormats.unorderedList}
        title="无序列表"
        onClick={() => applyComposeRichCommand("unordered-list")}
      >
        •≡
      </button>
      <button
        type="button"
        className={composeFormatButtonClass("orderedList")}
        aria-label="有序列表"
        aria-pressed={composeActiveFormats.orderedList}
        title="有序列表"
        onClick={() => applyComposeRichCommand("ordered-list")}
      >
        1≡
      </button>
      <div className="nt-compose-format-control">
        <button
          type="button"
          className="nt-compose-format-button"
          aria-label="对齐方式"
          aria-haspopup="menu"
          aria-expanded={composeAlignmentMenuOpen}
          aria-controls="compose-alignment-menu"
          title="对齐方式"
          data-nonmodal-trigger="compose-alignment"
          onClick={() => {
            setComposeAlignmentMenuOpen((value) => !value);
            setComposeFontMenuOpen(false);
            setComposeFontSizeMenuOpen(false);
            setComposeColorMenuOpen(false);
            setComposeEmojiPickerOpen(false);
            setComposeMoreMenuOpen(false);
          }}
        >
          ≔
        </button>
        {composeAlignmentMenuOpen ? (
          <div
            id="compose-alignment-menu"
            className="nt-compose-alignment-menu"
            role="menu"
            aria-label="对齐方式"
            data-nonmodal-layer="compose-alignment"
          >
            <button
              type="button"
              role="menuitem"
              onMouseDown={preserveComposeEditorSelection}
              onClick={() => {
                applyComposeRichCommand("align-left");
              }}
            >
              左对齐
            </button>
            <button
              type="button"
              role="menuitem"
              onMouseDown={preserveComposeEditorSelection}
              onClick={() => applyComposeRichCommand("align-center")}
            >
              居中对齐
            </button>
            <button
              type="button"
              role="menuitem"
              onMouseDown={preserveComposeEditorSelection}
              onClick={() => applyComposeRichCommand("align-right")}
            >
              右对齐
            </button>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="nt-compose-format-button"
        aria-label="选择表情"
        aria-haspopup="dialog"
        aria-expanded={composeEmojiPickerOpen}
        aria-controls="compose-emoji-popover"
        data-nonmodal-trigger="compose-emoji"
        onClick={() => applyComposeRichCommand("emoji")}
      >
        ☺
      </button>
      {composeEmojiPickerOpen ? (
        <div
          id="compose-emoji-popover"
          className="nt-compose-emoji-popover"
          role="dialog"
          aria-label="表情选择器"
          data-nonmodal-layer="compose-emoji"
        >
          <div className="nt-compose-emoji-tabs" role="tablist" aria-label="表情分类">
            {COMPOSE_EMOJI_CATEGORIES.map((category) => (
              <button
                type="button"
                key={category.id}
                className={`nt-compose-emoji-tab ${
                  composeEmojiActiveCategoryId === category.id
                    ? "nt-compose-emoji-tab--active"
                    : ""
                }`}
                role="tab"
                aria-selected={composeEmojiActiveCategoryId === category.id}
                aria-label={category.label}
                onMouseDown={preserveComposeEditorSelection}
                onClick={() => setComposeEmojiActiveCategoryId(category.id)}
              >
                {category.icon}
              </button>
            ))}
          </div>
          <label className="nt-compose-emoji-search">
            <span aria-hidden="true">⌕</span>
            <input
              value={composeEmojiSearch}
              onChange={(event) => setComposeEmojiSearch(event.currentTarget.value)}
              placeholder="搜索表情"
              aria-label="搜索表情"
            />
            {composeEmojiSearch ? (
              <button
                type="button"
              aria-label="清除表情搜索"
                onMouseDown={preserveComposeEditorSelection}
                onClick={() => setComposeEmojiSearch("")}
              >
                ×
              </button>
            ) : null}
          </label>
          <div className="nt-compose-emoji-scroll">
            {filteredComposeEmojiCategories.length > 0 ? (
              filteredComposeEmojiCategories.map((category) => (
              <section key={category.id}>
                <h4>{category.label}</h4>
                <div className="nt-compose-emoji-grid">
                  {category.emojis.map((emoji) => (
                    <button
                      type="button"
                      className="nt-compose-emoji-button"
                      key={`${category.id}-${emoji.symbol}`}
                  aria-label={`插入 ${emoji.symbol}`}
                      onMouseDown={preserveComposeEditorSelection}
                      onClick={() => insertComposeEmoji(emoji.symbol)}
                    >
                      {emoji.symbol}
                    </button>
                  ))}
                </div>
              </section>
              ))
            ) : (
              <p
                className="nt-compose-emoji-empty"
                role="status"
                aria-live="polite"
                data-empty-state
              >
                未找到匹配表情
              </p>
            )}
          </div>
        </div>
      ) : null}
      <button
        type="button"
        className={composeFormatButtonClass("quote")}
        aria-label="引用"
        aria-pressed={composeActiveFormats.quote}
        title="引用"
        onClick={() => applyComposeRichCommand("quote")}
      >
        ″
      </button>
      <button
        type="button"
        className="nt-compose-format-button"
        aria-label="插入链接"
        title="插入链接"
        onClick={() => applyComposeRichCommand("link")}
      >
        🔗
      </button>
      <button
        type="button"
        className="nt-compose-format-button"
        aria-label="清除格式"
        title="清除格式"
        onClick={() => applyComposeRichCommand("remove-format")}
      >
        <ClearFormatIcon />
      </button>
      <div className="nt-compose-format-more-control">
        <button
          type="button"
          aria-label="更多格式操作"
          aria-haspopup="menu"
          aria-expanded={
            composeMoreMenuOpen && composeMoreMenuAnchor === "formatbar"
          }
          aria-controls="compose-more-menu"
          data-nonmodal-trigger="compose-more"
          onClick={() => {
            setComposeMoreMenuAnchor("formatbar");
            setComposeMoreMenuOpen((value) =>
              composeMoreMenuAnchor === "formatbar" ? !value : true,
            );
          }}
        >
          ⋯
        </button>
        {renderComposeMoreMenu("formatbar")}
      </div>
    </div>
  );
}
